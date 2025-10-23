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

const bedrockClient = new BedrockAgentRuntimeClient();

exports.handler = async (event) => {
  console.log('Invoke agent event:', JSON.stringify(event, null, 2));

  try {
    const {
      experimentId,
      agentId,
      agentAliasId,
      goalDescription,
      currentX,
      currentY
    } = event;

    console.log(`Agent invocation for experiment ${experimentId} at position (${currentX}, ${currentY})`);

    // Construct the prompt for this iteration
    // Critical: We must explicitly tell the agent its current position
    // The agent has no memory of position across orchestration loop iterations
    const input = `You are continuing a maze navigation experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

The maze is on a 60x60 grid. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision).

Available actions:
- move_north: Move one step north (negative Y)
- move_south: Move one step south (positive Y)
- move_east: Move one step east (positive X)
- move_west: Move one step west (negative X)
- recall_all: Query your spatial memory to see what you've discovered

Continue navigating from your current position! Think step-by-step and use your tools strategically. When you call any action, always include experimentId=${experimentId} in your request.`;

    console.log('Invoking agent with input:', input);

    // Invoke the Bedrock Agent
    // SessionId keeps conversation context (agent can reference previous tool results)
    // But position must be in prompt - agent doesn't track spatial state internally
    const command = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId: `experiment-${experimentId}`, // Consistent session for conversation continuity
      inputText: input
    });

    const response = await bedrockClient.send(command);

    // Process streaming response from agent
    // The agent may invoke multiple tools before responding
    // All tool invocations happen synchronously during this call
    let completion = '';

    if (response.completion) {
      for await (const chunk of response.completion) {
        if (chunk.chunk?.bytes) {
          const text = new TextDecoder().decode(chunk.chunk.bytes);
          completion += text;
        }
      }
    }

    console.log('Agent response:', completion);

    return {
      experimentId,
      agentResponse: completion,
      status: 'completed'
    };

  } catch (error) {
    console.error('Error invoking agent:', error);

    return {
      experimentId: event.experimentId,
      error: error.message,
      status: 'failed'
    };
  }
};
