// Database utilities for Lambda functions
const { Client } = require('pg');

let client = null;

async function getDbClient() {
  if (client) {
    return client;
  }

  client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await client.connect();
  return client;
}

// Get experiment details
async function getExperiment(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    'SELECT * FROM experiments WHERE id = $1',
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

// Get current agent position from last action
async function getCurrentPosition(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    `SELECT to_x, to_y FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number DESC
     LIMIT 1`,
    [experimentId]
  );

  if (result.rows.length > 0) {
    return { x: result.rows[0].to_x, y: result.rows[0].to_y };
  }

  // If no actions yet, get start position
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
  return (result.rows[0].max_step || 0) + 1;
}

// Log an agent action
async function logAction(experimentId, stepNumber, actionType, reasoning, fromX, fromY, toX, toY, success, tilesSeen, tokensUsed) {
  const db = await getDbClient();
  await db.query(
    `INSERT INTO agent_actions
     (experiment_id, step_number, action_type, reasoning, from_x, from_y, to_x, to_y, success, tiles_seen, tokens_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [experimentId, stepNumber, actionType, reasoning, fromX, fromY, toX, toY, success, JSON.stringify(tilesSeen), tokensUsed]
  );
}

// Get all tiles the agent has seen
async function getAllSeenTiles(experimentId) {
  const db = await getDbClient();
  const result = await db.query(
    `SELECT tiles_seen FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number`,
    [experimentId]
  );

  // Merge all tiles_seen into a single map
  const allTiles = {};
  result.rows.forEach(row => {
    if (row.tiles_seen) {
      Object.assign(allTiles, row.tiles_seen);
    }
  });

  return allTiles;
}

// Update experiment totals
async function updateExperimentStats(experimentId, totalMoves, totalTokens) {
  const db = await getDbClient();
  await db.query(
    'UPDATE experiments SET total_moves = $1, total_tokens = $2 WHERE id = $3',
    [totalMoves, totalTokens]
  );
}

module.exports = {
  getDbClient,
  getExperiment,
  getMaze,
  getCurrentPosition,
  getNextStepNumber,
  logAction,
  getAllSeenTiles,
  updateExperimentStats
};
