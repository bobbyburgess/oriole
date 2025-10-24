/**
 * Queue Processor Lambda
 *
 * Polls SQS FIFO queue and starts Step Functions executions.
 *
 * Why this exists:
 * - SQS FIFO with MessageGroupId ensures experiments for the same model run sequentially
 * - Prevents rate limit conflicts when multiple experiments are queued
 * - Each model has its own "lane" (MessageGroupId) so different models run in parallel
 *
 * Flow:
 * EventBridge → SQS FIFO Queue (grouped by model) → This Lambda → Step Functions
 */

const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');

const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'us-west-2' });
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

exports.handler = async (event) => {
  console.log('Processing SQS messages:', JSON.stringify(event, null, 2));

  // Serialization is handled by:
  // 1. FIFO queue with MessageGroupId = "all-experiments" (processes messages in order)
  // 2. reservedConcurrentExecutions = 1 (only one Lambda instance)
  // 3. batchSize = 1 (process one message at a time)
  // No need to check for running executions - the queue ensures serialization

  for (const record of event.Records) {
    // Parse the EventBridge event from SQS message body
    const eventBridgeEvent = JSON.parse(record.body);

    // Extract experiment details from EventBridge detail
    const experimentDetails = eventBridgeEvent.detail;

    console.log('Starting Step Function execution for experiment:', {
      modelName: experimentDetails.modelName,
      mazeId: experimentDetails.mazeId,
      agentId: experimentDetails.agentId
    });

    // Start Step Functions execution
    const command = new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      input: JSON.stringify(experimentDetails),
      // Use EventBridge event ID as execution name for traceability
      name: `${eventBridgeEvent.id}_${record.messageId}`
    });

    const result = await sfnClient.send(command);

    console.log('Step Function execution started:', {
      executionArn: result.executionArn,
      messageId: record.messageId
    });

    // If this throws, Lambda fails and SQS will requeue after visibility timeout
  }
};
