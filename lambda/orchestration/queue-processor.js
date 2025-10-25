/**
 * Queue Processor Lambda
 *
 * Polls SQS FIFO queue and starts Step Functions executions.
 *
 * Why this exists:
 * - Ensures only ONE experiment runs at a time (strict serialization)
 * - Prevents Lambda throttling from concurrent Step Functions executions
 * - SQS will requeue messages if an experiment is already running
 *
 * Flow:
 * EventBridge → SQS FIFO Queue → This Lambda → Step Functions (one at a time)
 */

const { SFNClient, StartExecutionCommand, ListExecutionsCommand } = require('@aws-sdk/client-sfn');

const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'us-west-2' });
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

exports.handler = async (event) => {
  console.log('Processing SQS messages:', JSON.stringify(event, null, 2));

  // CRITICAL: Check if any experiment is currently running
  // If yes, throw error to requeue message and try again later
  const listCommand = new ListExecutionsCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    statusFilter: 'RUNNING',
    maxResults: 1
  });

  const runningExecutions = await sfnClient.send(listCommand);

  if (runningExecutions.executions && runningExecutions.executions.length > 0) {
    const runningExecution = runningExecutions.executions[0];
    console.log('Experiment already running, requeueing message:', {
      runningExecutionArn: runningExecution.executionArn,
      startDate: runningExecution.startDate
    });

    // Throw error to make SQS requeue this message
    // SQS visibility timeout will delay retry automatically
    throw new Error('Experiment already running - message will be requeued');
  }

  console.log('No running experiments - proceeding to start new execution');

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
