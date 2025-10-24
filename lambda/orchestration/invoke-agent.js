// Invoke Agent Lambda
// Calls AWS Bedrock Agent to perform one iteration of maze navigation
//
// How it works:
// 1. Receives current experiment state (position, experiment ID, etc.) from check-progress
// 2. Constructs a prompt telling the agent where it is and what it can do
// 3. Invokes Bedrock Agent with the prompt
// 4. Agent uses its action group tools (move_north, recall_all, etc.) via the router Lambda
// 5. Returns after agent completes its turn (may be multiple tool calls)
//
// Important: Each invocation is stateless from the agent's perspective
// The sessionId ensures conversation continuity, but position must be provided explicitly

const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const bedrockClient = new BedrockAgentRuntimeClient();
const ssmClient = new SSMClient();

// Cache prompts and pricing to avoid repeated SSM calls
const promptCache = {};
let pricingCache = null;

async function getPrompt(promptVersion) {
  if (promptCache[promptVersion]) {
    return promptCache[promptVersion];
  }

  const command = new GetParameterCommand({
    Name: `/oriole/prompts/${promptVersion}`
  });

  const response = await ssmClient.send(command);
  promptCache[promptVersion] = response.Parameter.Value;
  return promptCache[promptVersion];
}

async function getPricing() {
  if (pricingCache) {
    return pricingCache;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/pricing/models'
  });

  const response = await ssmClient.send(command);
  pricingCache = JSON.parse(response.Parameter.Value);
  return pricingCache;
}

function calculateCost(modelName, inputTokens, outputTokens, pricing) {
  const modelPricing = pricing[modelName];
  if (!modelPricing) {
    console.warn(`No pricing found for model: ${modelName}`);
    return 0;
  }

  const inputCost = (inputTokens / 1000000) * modelPricing.input_per_mtok;
  const outputCost = (outputTokens / 1000000) * modelPricing.output_per_mtok;
  return inputCost + outputCost;
}

exports.handler = async (event) => {
  console.log('Invoke agent event:', JSON.stringify(event, null, 2));

  try {
    const {
      experimentId,
      agentId,
      agentAliasId,
      goalDescription,
      currentX,
      currentY,
      promptVersion = 'v1',
      turnNumber = 1
    } = event;

    console.log(`Agent invocation for experiment ${experimentId} at position (${currentX}, ${currentY}) using prompt ${promptVersion}`);

    // Get the prompt text for this version
    const promptText = await getPrompt(promptVersion);

    // Construct the input for this iteration
    // Critical: We must explicitly tell the agent its current position
    // The agent has no memory of position across orchestration loop iterations
    const input = `You are continuing a maze navigation experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

${promptText}

When you call any action, always include experimentId=${experimentId} in your request.`;

    console.log('Invoking agent with input:', input);
    console.log(`Turn number: ${turnNumber}`);

    // Invoke the Bedrock Agent (single API call per turn)
    // This ONE call may result in multiple tool invocations handled by Bedrock's orchestration
    // SessionId keeps conversation context (agent can reference previous tool results)
    // But position must be in prompt - agent doesn't track spatial state internally
    // SessionAttributes pass through to action handlers via router.js
    const command = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId: `experiment-${experimentId}`, // Consistent session for conversation continuity
      inputText: input,
      enableTrace: true, // Enable trace to get token usage and reasoning steps
      sessionState: {
        sessionAttributes: {
          experimentId: experimentId.toString(),
          turnNumber: turnNumber.toString()
        }
      }
    });

    const startTime = Date.now();
    console.log(`[TIMING] Starting Bedrock Agent invocation at ${new Date().toISOString()}`);

    const response = await bedrockClient.send(command);

    console.log(`[TIMING] Bedrock client.send() completed in ${Date.now() - startTime}ms`);

    // Process streaming response from agent
    // The agent may invoke multiple tools before responding (e.g., 13+ tool calls in one turn)
    // All tool invocations happen INSIDE this single API call (Bedrock Agents' orchestration)
    // This is the key architectural advantage: multiple tool calls don't count as separate API calls
    // Our rate limit (6 RPM) controls time between TURNS, not between individual tool calls
    let completion = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let chunkCount = 0;
    const streamStartTime = Date.now();

    console.log(`[TIMING] Starting to process stream chunks`);

    if (response.completion) {
      for await (const chunk of response.completion) {
      // DEBUG: Log full chunk structure for Nova
      if (chunkCount === 0) {
        console.log('[DEBUG] Full first chunk structure:', JSON.stringify(chunk, null, 2));
      }
        chunkCount++;

        if (chunk.chunk?.bytes) {
          const text = new TextDecoder().decode(chunk.chunk.bytes);
          completion += text;
        }

        // Log tool invocations as they happen
        if (chunk.trace?.trace?.orchestrationTrace?.invocationInput) {
          const actionGroup = chunk.trace.trace.orchestrationTrace.invocationInput?.actionGroupInvocationInput?.actionGroupName;
          const apiPath = chunk.trace.trace.orchestrationTrace.invocationInput?.actionGroupInvocationInput?.apiPath;
          if (apiPath) {
            console.log(`[TIMING] Tool call: ${apiPath} (chunk ${chunkCount}, elapsed ${Date.now() - streamStartTime}ms)`);
          }
        }

        // Extract token usage from streaming response
        // Usage stats come in the final chunk
        if (chunk.trace?.trace?.orchestrationTrace?.modelInvocationInput) {
          const trace = chunk.trace.trace.orchestrationTrace;
          if (trace.modelInvocationInput?.text) {
            console.log(`[TIMING] Model invocation input received (chunk ${chunkCount}, elapsed ${Date.now() - streamStartTime}ms)`);
          }
        }

        // Token usage is in the trace
        // Different models use different field names: inputTokens vs inputToken (singular)
        if (chunk.trace?.trace?.orchestrationTrace?.modelInvocationOutput) {
          const usage = chunk.trace.trace.orchestrationTrace.modelInvocationOutput?.metadata?.usage;
          if (usage) {
            // Support both plural (Claude) and singular (Nova/docs) field names
            inputTokens = usage.inputTokens || usage.inputToken || 0;
            outputTokens = usage.outputTokens || usage.outputToken || 0;
            console.log(`[TIMING] Token usage received: ${inputTokens} in, ${outputTokens} out (chunk ${chunkCount}, elapsed ${Date.now() - streamStartTime}ms)`);
          }
        }
      }
    }

    const streamDuration = Date.now() - streamStartTime;
    console.log(`[TIMING] Stream completed: ${chunkCount} chunks in ${streamDuration}ms`);
    console.log('Agent response:', completion);
    console.log(`Token usage: ${inputTokens} input, ${outputTokens} output`);

    // Calculate cost for this invocation
    const pricing = await getPricing();
    const cost = calculateCost(event.modelName, inputTokens, outputTokens, pricing);

    console.log(`Cost for this invocation: $${cost.toFixed(6)}`);

    return {
      experimentId,
      agentResponse: completion,
      inputTokens,
      outputTokens,
      cost
    };

  } catch (error) {
    console.error('Error invoking agent:', error);

    // Fail fast - throw error to fail the Step Functions execution
    // No retries, no swallowing errors - if Bedrock throttles or anything fails, the experiment fails
    throw error;
  }
};
