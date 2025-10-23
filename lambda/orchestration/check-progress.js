// Check Progress Lambda
// Invoked between each agent iteration in the Step Functions loop
// Responsibilities:
// 1. Count total actions taken so far (from agent_actions table)
// 2. Check if experiment should continue based on:
//    - Goal found (success flag set)
//    - Max moves reached
//    - Max duration exceeded
// 3. Fetch current position from DB (critical for stateless orchestration)
// 4. Pass all state forward to next step (invoke-agent or finalize)

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { getCurrentPosition } = require('../shared/db');

const ssmClient = new SSMClient();

// Module-level caching to reuse across warm Lambda invocations
let client = null;
let cachedDbPassword = null;
let cachedMaxMoves = null;
let cachedMaxDurationMinutes = null;

async function getDbPassword() {
  if (cachedDbPassword) {
    return cachedDbPassword;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/db/password',
    WithDecryption: true
  });

  const response = await ssmClient.send(command);
  cachedDbPassword = response.Parameter.Value;
  return cachedDbPassword;
}

async function getMaxMoves() {
  if (cachedMaxMoves) {
    return cachedMaxMoves;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/experiments/max-moves',
    WithDecryption: false
  });

  const response = await ssmClient.send(command);
  cachedMaxMoves = parseInt(response.Parameter.Value);
  return cachedMaxMoves;
}

async function getMaxDurationMinutes() {
  if (cachedMaxDurationMinutes) {
    return cachedMaxDurationMinutes;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/experiments/max-duration-minutes',
    WithDecryption: false
  });

  const response = await ssmClient.send(command);
  cachedMaxDurationMinutes = parseInt(response.Parameter.Value);
  return cachedMaxDurationMinutes;
}

async function getDbClient() {
  if (client) {
    return client;
  }

  const password = await getDbPassword();

  client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: password,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  return client;
}

exports.handler = async (event) => {
  console.log('Check progress event:', JSON.stringify(event, null, 2));

  try {
    const { experimentId } = event;

    const db = await getDbClient();
    const maxMoves = await getMaxMoves();
    const maxDurationMinutes = await getMaxDurationMinutes();

    // Get experiment current state
    const expResult = await db.query(
      'SELECT success, started_at FROM experiments WHERE id = $1',
      [experimentId]
    );

    if (expResult.rows.length === 0) {
      throw new Error(`Experiment ${experimentId} not found`);
    }

    const experiment = expResult.rows[0];
    const success = experiment.success;
    const startedAt = new Date(experiment.started_at);

    // Count actual actions from agent_actions table
    // Note: experiments.total_moves is only updated at finalization
    // We count ALL actions here (moves + recalls) since they both consume agent turns
    const movesResult = await db.query(
      'SELECT COUNT(*) as move_count FROM agent_actions WHERE experiment_id = $1',
      [experimentId]
    );
    const totalMoves = parseInt(movesResult.rows[0].move_count);

    // Calculate elapsed time in minutes
    const now = new Date();
    const elapsedMinutes = (now - startedAt) / 1000 / 60;

    console.log(`Experiment ${experimentId}: ${totalMoves}/${maxMoves} moves, ${elapsedMinutes.toFixed(1)}/${maxDurationMinutes} minutes, success: ${success}`);

    // Determine if we should continue
    // Stop if: goal found OR max moves reached OR max duration exceeded
    const shouldContinue = !success && totalMoves < maxMoves && elapsedMinutes < maxDurationMinutes;

    let stopReason = null;
    if (!shouldContinue) {
      if (success) stopReason = 'goal_found';
      else if (totalMoves >= maxMoves) stopReason = 'max_moves_reached';
      else if (elapsedMinutes >= maxDurationMinutes) stopReason = 'max_duration_exceeded';
    }

    // Get current position from database
    // This is critical: Bedrock Agent sessions don't preserve state between invocations
    // We must fetch the latest position after each action and pass it to the next iteration
    const currentPos = await getCurrentPosition(experimentId);
    console.log(`Current position: (${currentPos.x}, ${currentPos.y})`);

    // Return all state needed for next step in the workflow
    // The Step Functions state machine uses this to decide whether to:
    // - Continue looping (invoke agent again)
    // - Finalize (experiment complete)
    return {
      experimentId,
      totalMoves,
      maxMoves,
      elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
      maxDurationMinutes,
      success,
      shouldContinue,
      stopReason,
      // Current position must be passed to invoke-agent for next prompt
      currentX: currentPos.x,
      currentY: currentPos.y,
      // Pass through original event data for next step
      agentId: event.agentId,
      agentAliasId: event.agentAliasId,
      modelName: event.modelName,
      promptVersion: event.promptVersion,
      mazeId: event.mazeId,
      goalDescription: event.goalDescription,
      startX: event.startX,
      startY: event.startY
    };

  } catch (error) {
    console.error('Error checking progress:', error);
    throw error;
  }
};
