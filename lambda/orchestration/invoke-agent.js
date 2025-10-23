// Invoke Agent Lambda
// Calls Bedrock Agent to run the maze experiment

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
      startX,
      startY
    } = event;

    // Prepare input for the agent
    const input = `You are starting a maze navigation experiment.

Experiment ID: ${experimentId}
Starting Position: (${startX}, ${startY})
Goal: ${goalDescription}

The maze is on a 60x60 grid. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision).

Available actions:
- move_north: Move one step north (negative Y)
- move_south: Move one step south (positive Y)
- move_east: Move one step east (positive X)
- move_west: Move one step west (negative X)
- recall_all: Query your spatial memory

Begin navigating! Think step-by-step and use your tools strategically. When you call any action, always include experimentId=${experimentId} in your request.`;

    console.log('Invoking agent with input:', input);

    // Invoke the agent
    const command = new InvokeAgentCommand({
      agentId,
      agentAliasId,
      sessionId: `experiment-${experimentId}`,
      inputText: input
    });

    const response = await bedrockClient.send(command);

    // Process agent response
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
