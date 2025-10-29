// Database utilities for Lambda functions
// Provides shared DB connection and helper functions for experiment tracking
//
// Key responsibilities:
// - Manage PostgreSQL connection with credential caching
// - Track agent position across actions (critical for stateless orchestration)
// - Log all agent actions with vision data
// - Aggregate memory (tiles seen across all actions)

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

// Module-level caching for reuse across warm Lambda invocations
let client = null;
let cachedPassword = null;

async function getDbPassword() {
  if (cachedPassword) {
    return cachedPassword;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/db/password',
    WithDecryption: true
  });

  const response = await ssmClient.send(command);
  cachedPassword = response.Parameter.Value;
  return cachedPassword;
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

// Get experiment details
// Uses view to provide calculated token/cost columns from agent_actions aggregation
async function getExperiment(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    'SELECT * FROM v_experiments_with_costs WHERE id = $1',
    [experimentId]
  );
  return result.rows[0];
}

// Get maze data
async function getMaze(mazeId) {
  const db = await getDbClient();
  const result = await db.query(
    'SELECT * FROM mazes WHERE id = $1',
    [mazeId]
  );
  return result.rows[0];
}

// Acquire experiment-level advisory lock
// Prevents concurrent actions from reading stale position data
// Lock is automatically released when transaction commits or connection closes
async function acquireExperimentLock(experimentId) {
  const db = await getDbClient();
  await db.query('SELECT pg_advisory_lock($1)', [experimentId]);
}

// Release experiment-level advisory lock
async function releaseExperimentLock(experimentId) {
  const db = await getDbClient();
  await db.query('SELECT pg_advisory_unlock($1)', [experimentId]);
}

// Get current agent position from last action
// This is critical for stateless orchestration - position is the PRIMARY state we track
//
// Logic:
// 1. Get most recent action from agent_actions table
// 2. If it's a movement action (to_x/to_y populated), return destination
// 3. If it's a non-movement action like recall_all (to_x/to_y NULL), return from_x/from_y
// 4. If no actions yet, return start position from experiments table
//
// Historical bug: Originally only checked to_x/to_y, causing agent to "teleport"
// back to start position after recall_all actions set them to NULL
//
// Race condition fix: This function should only be called while holding an advisory lock
// via acquireExperimentLock(). Without the lock, concurrent actions could read the same
// position and create discontinuities.
async function getCurrentPosition(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    `SELECT to_x, to_y, from_x, from_y FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number DESC
     LIMIT 1`,
    [experimentId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    // If to_x/to_y exist (movement action), use them as current position
    if (row.to_x !== null && row.to_y !== null) {
      return { x: row.to_x, y: row.to_y };
    }
    // Otherwise use from_x/from_y (non-movement action like recall_all stayed in place)
    // This prevents "teleporting" back to start after recall_all
    if (row.from_x !== null && row.from_y !== null) {
      return { x: row.from_x, y: row.from_y };
    }
  }

  // If no actions yet, get start position from experiments table
  const experiment = await getExperiment(experimentId);
  return { x: experiment.start_x, y: experiment.start_y };
}

// Get next step number
async function getNextStepNumber(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    'SELECT MAX(step_number) as max_step FROM agent_actions WHERE experiment_id = $1',
    [experimentId]
  );

  // FAIL FAST: Validate query returned results
  if (!result.rows || result.rows.length === 0) {
    throw new Error(`Failed to query max step number for experiment ${experimentId}`);
  }

  // NULL is valid for first action (no previous actions), but other values should be numbers
  const maxStep = result.rows[0].max_step;
  if (maxStep === null) {
    return 1; // First action
  }

  if (typeof maxStep !== 'number' || isNaN(maxStep)) {
    throw new Error(`Invalid max_step value for experiment ${experimentId}: ${maxStep}`);
  }

  return maxStep + 1;
}

// Log an agent action
// assistantMessage: The full message.content from the LLM (optional)
// reasoning: The tool call's arguments.reasoning field (optional)
// inputTokens and outputTokens: TURN's total tokens, stored with each action in that turn (optional)
async function logAction(experimentId, stepNumber, actionType, reasoning, fromX, fromY, toX, toY, success, tilesSeen, turnNumber, inputTokens = null, outputTokens = null, assistantMessage = null) {
  const db = await getDbClient();
  await db.query(
    `INSERT INTO agent_actions
     (experiment_id, step_number, action_type, reasoning, from_x, from_y, to_x, to_y, success, tiles_seen, turn_number, input_tokens, output_tokens, assistant_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [experimentId, stepNumber, actionType, reasoning, fromX, fromY, toX, toY, success, JSON.stringify(tilesSeen), turnNumber, inputTokens, outputTokens, assistantMessage]
  );
}

// Update goal_found flag when goal is detected
// Called immediately when agent sees GOAL tile to stop experiment early
async function updateGoalFound(experimentId, found) {
  const db = await getDbClient();
  await db.query(
    'UPDATE experiments SET goal_found = $1 WHERE id = $2',
    [found, experimentId]
  );
}

// Update all actions in a turn with token usage data
// Called from check-progress after invoke-agent returns with turn-level tokens
async function updateTurnTokens(experimentId, turnNumber, inputTokens, outputTokens) {
  const db = await getDbClient();
  await db.query(
    `UPDATE agent_actions
     SET input_tokens = $1, output_tokens = $2
     WHERE experiment_id = $3 AND turn_number = $4`,
    [inputTokens, outputTokens, experimentId, turnNumber]
  );
}

module.exports = {
  getDbClient,
  getExperiment,
  getMaze,
  getCurrentPosition,
  getNextStepNumber,
  logAction,
  acquireExperimentLock,
  releaseExperimentLock,
  updateGoalFound,
  updateTurnTokens
};
