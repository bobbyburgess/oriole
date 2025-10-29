/**
 * Ollama Queue Processor Lambda
 *
 * Polls SQS FIFO queue and starts Step Functions executions for Ollama experiments.
 *
 * Differences from regular queue-processor:
 * - Allows multiple concurrent Ollama experiments (up to MAX_CONCURRENT_OLLAMA)
 * - Checks count of running Ollama executions before starting new ones
 * - No rate limiting needed (local Ollama has no API limits)
 *
 * Flow:
 * EventBridge → SQS FIFO Queue → This Lambda → Step Functions (max N at a time)
 */

const { SFNClient, StartExecutionCommand, ListExecutionsCommand } = require('@aws-sdk/client-sfn');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'us-west-2' });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'us-west-2' });
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

// Cache max concurrent value to avoid SSM calls on every invocation
let cachedMaxConcurrent = null;

async function getMaxConcurrent() {
  if (cachedMaxConcurrent !== null) {
    return cachedMaxConcurrent;
  }

  try {
    const command = new GetParameterCommand({
      Name: '/oriole/ollama/max-concurrent-experiments'
    });
    const response = await ssmClient.send(command);
    cachedMaxConcurrent = parseInt(response.Parameter.Value);
    console.log(`Max concurrent Ollama experiments set to: ${cachedMaxConcurrent}`);
    return cachedMaxConcurrent;
  } catch (error) {
    // FAIL FAST: Concurrent experiment limit is critical for performance and resource management
    throw new Error(`Failed to load required parameter /oriole/ollama/max-concurrent-experiments: ${error.message}`);
  }
}

exports.handler = async (event) => {
  console.log('Processing Ollama SQS messages:', JSON.stringify(event, null, 2));

  // Get max concurrent limit from Parameter Store
  const MAX_CONCURRENT = await getMaxConcurrent();

  // Check current count of running Ollama experiments
  // We identify Ollama executions by the 'ollama_' prefix in execution name
  const listCommand = new ListExecutionsCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    statusFilter: 'RUNNING',
    maxResults: 100 // Get all running to count accurately
  });

  const runningExecutions = await sfnClient.send(listCommand);

  // Count only Ollama experiments by checking execution names
  const ollamaCount = runningExecutions.executions?.filter(exec =>
    exec.name?.startsWith('ollama_')
  ).length || 0;

  if (ollamaCount >= MAX_CONCURRENT) {
    console.log(`Max concurrent Ollama experiments reached (${ollamaCount}/${MAX_CONCURRENT}), requeueing message`);

    // Throw error to make SQS requeue this message
    // SQS visibility timeout will delay retry automatically
    throw new Error(`Max Ollama concurrency reached (${ollamaCount}/${MAX_CONCURRENT}) - message will be requeued`);
  }

  console.log(`Currently running ${ollamaCount}/${MAX_CONCURRENT} Ollama experiments - starting new one`);

  for (const record of event.Records) {
    // Parse the EventBridge event from SQS message body
    const eventBridgeEvent = JSON.parse(record.body);

    // Extract experiment details from EventBridge detail
    const experimentDetails = eventBridgeEvent.detail;

    console.log('Starting Ollama Step Function execution:', {
      modelName: experimentDetails.modelName,
      mazeId: experimentDetails.mazeId,
      promptVersion: experimentDetails.promptVersion
    });

    // Start Step Functions execution with 'ollama_' prefix for tracking
    const command = new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      input: JSON.stringify(experimentDetails),
      // Use 'ollama_' prefix to identify Ollama experiments
      name: `ollama_${eventBridgeEvent.id}_${record.messageId}`.substring(0, 80) // Max 80 chars
    });

    const result = await sfnClient.send(command);

    console.log('Ollama Step Function execution started:', {
      executionArn: result.executionArn,
      messageId: record.messageId,
      currentOllamaCount: ollamaCount + 1
    });

    // If this throws, Lambda fails and SQS will requeue after visibility timeout
  }
};
