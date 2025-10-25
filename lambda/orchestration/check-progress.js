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
const { getCurrentPosition, updateTurnTokens } = require('../shared/db');

const ssmClient = new SSMClient();

// Module-level caching to reuse across warm Lambda invocations
let client = null;
let cachedDbPassword = null;
let cachedMaxMoves = null;
let cachedMaxDurationMinutes = null;
const rateLimitCache = {};

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

async function getRateLimitRpm(modelName) {
  if (rateLimitCache[modelName]) {
    return rateLimitCache[modelName];
  }

  // Map model name to parameter store key
  // Example: "claude-3-5-haiku" maps to "/oriole/models/claude-3-5-haiku/rate-limit-rpm"
  const modelKey = modelName.toLowerCase().replace(/\./g, '-');

  try {
    const command = new GetParameterCommand({
      Name: `/oriole/models/${modelKey}/rate-limit-rpm`,
      WithDecryption: false
    });

    const response = await ssmClient.send(command);
    rateLimitCache[modelName] = parseInt(response.Parameter.Value);
    return rateLimitCache[modelName];
  } catch (error) {
    // If no rate limit configured for this model, default to 10 rpm (6s between requests)
    console.warn(`No rate limit found for model ${modelName}, defaulting to 10 rpm`);
    return 10;
  }
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
    const { experimentId, agentResult, turnNumber = 1 } = event;

    // Handle both Lambda invocation types:
    // - Direct invocation: agentResult.Payload is an object
    // - Step Functions Lambda integration: agentResult.Payload is a JSON string
    let agentPayload = {};
    if (agentResult?.Payload) {
      if (typeof agentResult.Payload === 'string') {
        agentPayload = JSON.parse(agentResult.Payload);
      } else {
        agentPayload = agentResult.Payload;
      }
    }

    // Extract token/cost data from the agent invocation result
    // CRITICAL: Force to Number to prevent string concatenation
    const invocationTokensIn = Number(agentPayload.inputTokens || 0);
    const invocationTokensOut = Number(agentPayload.outputTokens || 0);
    const invocationCost = Number(agentPayload.cost || 0);

    const db = await getDbClient();
    const maxMoves = await getMaxMoves();
    const maxDurationMinutes = await getMaxDurationMinutes();

    // Get experiment current state including cumulative tokens/cost
    const expResult = await db.query(
      `SELECT goal_found, started_at,
              total_input_tokens, total_output_tokens, total_cost_usd
       FROM experiments WHERE id = $1`,
      [experimentId]
    );

    if (expResult.rows.length === 0) {
      throw new Error(`Experiment ${experimentId} not found`);
    }

    const experiment = expResult.rows[0];
    const goalFound = experiment.goal_found;
    const startedAt = new Date(experiment.started_at);

    // Calculate cumulative totals
    // CRITICAL: Parse database values as integers to prevent string concatenation
    const cumulativeInputTokens = parseInt(experiment.total_input_tokens || 0) + invocationTokensIn;
    const cumulativeOutputTokens = parseInt(experiment.total_output_tokens || 0) + invocationTokensOut;
    const cumulativeCost = parseFloat(experiment.total_cost_usd || 0) + invocationCost;

    // Update experiment with new cumulative totals
    await db.query(
      `UPDATE experiments
       SET total_input_tokens = $1,
           total_output_tokens = $2,
           total_cost_usd = $3
       WHERE id = $4`,
      [cumulativeInputTokens, cumulativeOutputTokens, cumulativeCost, experimentId]
    );

    // Update all actions from this turn with token data
    // This allows per-turn token analysis from agent_actions table
    await updateTurnTokens(experimentId, turnNumber, invocationTokensIn, invocationTokensOut);

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

    console.log(`Experiment ${experimentId}: ${totalMoves}/${maxMoves} moves, ${elapsedMinutes.toFixed(1)}/${maxDurationMinutes} minutes, goal_found: ${goalFound}`);
    console.log(`Cumulative tokens: ${cumulativeInputTokens} in, ${cumulativeOutputTokens} out, $${cumulativeCost.toFixed(6)} total cost`);

    // Determine if we should continue
    // Stop if: goal found OR max moves reached OR max duration exceeded
    // Note: We check move count BETWEEN turns, so experiments can overshoot max_moves
    // Example: If at 96 moves and agent makes 8 tool calls in one turn, final count = 104
    const shouldContinue = !goalFound && totalMoves < maxMoves && elapsedMinutes < maxDurationMinutes;

    let stopReason = null;
    if (!shouldContinue) {
      if (goalFound) stopReason = 'goal_found';
      else if (totalMoves >= maxMoves) stopReason = 'max_moves_reached';
      else if (elapsedMinutes >= maxDurationMinutes) stopReason = 'max_duration_exceeded';
    }

    // Get current position from database
    // This is critical: Bedrock Agent sessions don't preserve state between invocations
    // We must fetch the latest position after each action and pass it to the next iteration
    const currentPos = await getCurrentPosition(experimentId);
    console.log(`Current position: (${currentPos.x}, ${currentPos.y})`);

    // Calculate rate limit wait time
    // Wait duration ensures we don't exceed model-specific rate limits
    // Formula: 60 / rate_limit_rpm = seconds to wait between requests
    const rateLimitRpm = await getRateLimitRpm(event.modelName);
    const waitSeconds = Math.ceil(60 / rateLimitRpm);  // Round up to ensure we stay under limit
    console.log(`Rate limit: ${rateLimitRpm} req/min, wait duration: ${waitSeconds}s`);

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
      goalFound,
      shouldContinue,
      stopReason,
      // Token and cost tracking (visible in Step Functions state!)
      cumulativeInputTokens,
      cumulativeOutputTokens,
      cumulativeTotalTokens: cumulativeInputTokens + cumulativeOutputTokens,
      cumulativeCost: parseFloat(cumulativeCost.toFixed(6)),
      // Rate limiting
      waitSeconds,  // Used by Step Functions Wait state to enforce rate limits
      rateLimitRpm,
      // Turn tracking: increment for next agent invocation
      turnNumber: turnNumber + 1,
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
