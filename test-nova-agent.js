const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

const client = new BedrockAgentRuntimeClient({ region: 'us-west-2' });

async function testAgent() {
  console.log('Testing Nova Micro agent with simple prompt...');

  const command = new InvokeAgentCommand({
    agentId: 'BGNJXVYEPT',
    agentAliasId: 'TSTALIASID',
    sessionId: `test-simple-${Date.now()}`,
    inputText: 'List all available actions you can perform.',
    enableTrace: true
  });

  try {
    const startTime = Date.now();
    const response = await client.send(command);
    console.log(`Response received in ${Date.now() - startTime}ms`);

    let completion = '';
    let hasToolUse = false;

    if (response.completion) {
      for await (const chunk of response.completion) {
        if (chunk.chunk?.bytes) {
          const text = new TextDecoder().decode(chunk.chunk.bytes);
          completion += text;
        }

        if (chunk.trace?.orchestrationTrace?.modelInvocationOutput) {
          console.log('Model invocation output detected');
          const output = chunk.trace.orchestrationTrace.modelInvocationOutput;
          if (output.metadata?.usage) {
            console.log('Token usage:', output.metadata.usage);
          }
        }

        if (chunk.trace?.orchestrationTrace?.observation?.actionGroupInvocationOutput) {
          hasToolUse = true;
          console.log('Tool invocation detected!');
        }
      }
    }

    console.log('\n=== Results ===');
    console.log('Completion:', completion.substring(0, 200));
    console.log('Had tool use:', hasToolUse);
    console.log('Total time:', Date.now() - startTime, 'ms');

  } catch (error) {
    console.error('Error:', error.name);
    console.error('Message:', error.message);
    console.error('Full error:', JSON.stringify(error, null, 2));
  }
}

testAgent();
