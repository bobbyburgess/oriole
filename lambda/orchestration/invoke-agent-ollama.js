// Invoke Agent Lambda - Ollama Edition
// Calls local Ollama via webhook instead of AWS Bedrock Agent
//
// How it works:
// 1. Receives current experiment state (position, experiment ID, etc.) from check-progress
// 2. Constructs a prompt telling the LLM where it is and what it can do
// 3. Calls Ollama via ngrok webhook with API key authentication
// 4. Parses actions from LLM response
// 5. Executes actions by directly invoking router Lambda for each action
// 6. Returns after completing turn (all actions executed)
//
// Important: Each invocation is stateless from the LLM's perspective
// Position must be provided explicitly each turn (no conversation history)

const https = require('https');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const ssmClient = new SSMClient();
const lambdaClient = new LambdaClient();

// Cache prompts to avoid repeated SSM calls
const promptCache = {};

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

async function getOllamaEndpoint() {
  const command = new GetParameterCommand({
    Name: '/oriole/ollama/endpoint'
  });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

async function getOllamaApiKey() {
  const command = new GetParameterCommand({
    Name: '/oriole/ollama/api-key',
    WithDecryption: true  // Required for SecureString parameters
  });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

// Call Ollama via HTTPS webhook
async function callOllama(endpoint, model, prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/api/generate`);
    const postData = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.7,
        num_predict: 1000
      }
    });

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': apiKey
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000); // 2 minute timeout
    req.write(postData);
    req.end();
  });
}

/**
 * Parse actions from Ollama LLM response
 *
 * Ollama outputs natural language, not structured JSON, so we regex-match action names.
 *
 * Max 8 actions per turn prevents runaway loops (same limit as Bedrock orchestration).
 * Action parsing is permissive - invalid names are silently ignored.
 *
 * Example response:
 *   "I'll start by moving north. move_north experimentId=123
 *    Then I'll check what I can see. recall_all experimentId=123"
 *
 * Parsed result: ['move_north', 'recall_all']
 */
function parseActions(response) {
  const actions = [];
  const actionRegex = /(?:move_north|move_south|move_east|move_west|recall_all)/gi;
  const matches = response.match(actionRegex);

  if (matches) {
    for (const match of matches.slice(0, 8)) { // Max 8 actions per turn
      actions.push(match.toLowerCase());
    }
  }

  return actions;
}

/**
 * Execute action via Lambda invocation
 *
 * Ollama doesn't have native action tools like Bedrock Agents, so we:
 * 1. Parse action names from LLM response
 * 2. Invoke action_router Lambda for each action (sequential execution)
 * 3. Update position after each action
 *
 * IMPORTANT: Must format request in Bedrock Agent format even though router is called directly.
 * This ensures router.js can parse properties array without modification.
 *
 * Bedrock Agent format:
 *   requestBody.content['application/json'].properties = [
 *     {name: 'experimentId', type: 'integer', value: 123},
 *     {name: 'turnNumber', type: 'integer', value: 1}
 *   ]
 *
 * This is the SAME format that Bedrock Agent sends, ensuring router.js works identically
 * for both Bedrock and Ollama paths.
 */
async function executeAction(action, experimentId, currentX, currentY, turnNumber, stepNumber) {
  const command = new InvokeCommand({
    FunctionName: process.env.ACTION_ROUTER_FUNCTION_NAME,
    Payload: JSON.stringify({
      actionGroup: 'maze-actions',
      apiPath: `/${action}`,
      httpMethod: 'POST',
      requestBody: {
        content: {
          'application/json': {
            properties: [
              { name: 'experimentId', type: 'integer', value: experimentId },
              { name: 'currentX', type: 'integer', value: currentX },
              { name: 'currentY', type: 'integer', value: currentY },
              { name: 'turnNumber', type: 'integer', value: turnNumber },
              { name: 'stepNumber', type: 'integer', value: stepNumber }
            ]
          }
        }
      },
      sessionAttributes: {
        experimentId: experimentId.toString(),
        turnNumber: turnNumber.toString()
      }
    })
  });

  const response = await lambdaClient.send(command);
  const payload = JSON.parse(new TextDecoder().decode(response.Payload));

  // Parse the Bedrock Agent response format to extract the actual result
  const result = typeof payload.response?.responseBody?.['application/json']?.body === 'string'
    ? JSON.parse(payload.response.responseBody['application/json'].body)
    : payload.response?.responseBody?.['application/json']?.body || {};

  return result;
}

exports.handler = async (event) => {
  console.log('Invoke agent (Ollama) event:', JSON.stringify(event, null, 2));

  try {
    const {
      experimentId,
      currentX,
      currentY,
      goalDescription,
      promptVersion = 'v1',
      modelName = 'llama3.2:latest',
      turnNumber = 1
    } = event;

    console.log(`Ollama invocation for experiment ${experimentId} at position (${currentX}, ${currentY}) using prompt ${promptVersion}`);

    // Get the prompt text for this version
    const promptText = await getPrompt(promptVersion);

    // Construct the input for this iteration
    // Critical: We must explicitly tell the agent its current position
    // The agent has no memory of position across orchestration loop iterations
    // This matches the AWS Bedrock format from invoke-agent.js lines 87-95
    const input = `You are continuing a grid exploration experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

${promptText}

When you call any action, always include experimentId=${experimentId} in your request.`;

    console.log('Invoking Ollama with input:', input);
    console.log(`Turn number: ${turnNumber}`);

    // Get Ollama endpoint and API key from Parameter Store
    const endpoint = await getOllamaEndpoint();
    const apiKey = await getOllamaApiKey();
    console.log(`Ollama endpoint: ${endpoint}`);

    // Call Ollama
    const startTime = Date.now();
    console.log(`[TIMING] Starting Ollama invocation at ${new Date().toISOString()}`);

    const llmResponse = await callOllama(endpoint, modelName, input, apiKey);

    console.log(`[TIMING] Ollama call completed in ${Date.now() - startTime}ms`);
    console.log('Ollama response:', llmResponse.response);
    console.log(`Token usage: ${llmResponse.prompt_eval_count || 0} input, ${llmResponse.eval_count || 0} output`);

    // Parse actions from response
    const actions = parseActions(llmResponse.response);
    console.log(`\nParsed actions: [${actions.join(', ')}]`);

    if (actions.length === 0) {
      console.log('No valid actions found, ending turn');
      return {
        experimentId,
        agentResponse: llmResponse.response,
        inputTokens: llmResponse.prompt_eval_count || 0,
        outputTokens: llmResponse.eval_count || 0,
        cost: 0 // Local = free!
      };
    }

    // Execute each action
    console.log('\nExecuting actions:');
    let position = { x: currentX, y: currentY };
    let goalFound = false;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      console.log(`  [${i + 1}/${actions.length}] Executing: ${action}`);

      const result = await executeAction(
        action,
        experimentId,
        position.x,
        position.y,
        turnNumber,
        i + 1
      );

      console.log(`    Result: ${result.success ? '✅' : '❌'} ${result.result || result.message || 'Unknown'}`);

      // Update position if move succeeded
      if (result.success && result.newX !== undefined && result.newY !== undefined) {
        position.x = result.newX;
        position.y = result.newY;
      }

      // Check if goal found
      if (result.goalFound) {
        goalFound = true;
        console.log('    🎯 GOAL FOUND!');
        break;
      }
    }

    console.log(`\nTurn complete. Final position: (${position.x}, ${position.y}), Goal found: ${goalFound}`);

    return {
      experimentId,
      agentResponse: llmResponse.response,
      inputTokens: llmResponse.prompt_eval_count || 0,
      outputTokens: llmResponse.eval_count || 0,
      cost: 0 // Local = free!
    };

  } catch (error) {
    console.error('Error invoking Ollama agent:', error);

    // Fail fast - throw error to fail the Step Functions execution
    // No retries, no swallowing errors - if Ollama fails, the experiment fails
    throw error;
  }
};
