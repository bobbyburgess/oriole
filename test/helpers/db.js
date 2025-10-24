// Test helpers for database operations
const { Client } = require('pg');

async function createDbClient() {
  const client = new Client({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();
  return client;
}

async function checkPositionContinuity(experimentId) {
  const client = await createDbClient();

  try {
    const result = await client.query(`
      WITH moves AS (
        SELECT
          step_number,
          from_x,
          from_y,
          COALESCE(to_x, from_x) as end_x,
          COALESCE(to_y, from_y) as end_y,
          LAG(COALESCE(to_x, from_x)) OVER (ORDER BY step_number) as prev_end_x,
          LAG(COALESCE(to_y, from_y)) OVER (ORDER BY step_number) as prev_end_y
        FROM agent_actions
        WHERE experiment_id = $1
      )
      SELECT
        step_number,
        from_x || ',' || from_y as actual_from,
        prev_end_x || ',' || prev_end_y as expected_from
      FROM moves
      WHERE step_number > 1
        AND (from_x != prev_end_x OR from_y != prev_end_y)
    `, [experimentId]);

    return result.rows; // Empty array = no violations
  } finally {
    await client.end();
  }
}

async function getTurnData(experimentId) {
  const client = await createDbClient();

  try {
    const result = await client.query(`
      SELECT
        turn_number,
        COUNT(*) as steps_in_turn,
        COUNT(*) FILTER (WHERE success) as successful_steps
      FROM agent_actions
      WHERE experiment_id = $1
      GROUP BY turn_number
      ORDER BY turn_number
    `, [experimentId]);

    return result.rows;
  } finally {
    await client.end();
  }
}

async function getExperimentStats(experimentId) {
  const client = await createDbClient();

  try {
    const result = await client.query(`
      SELECT
        COUNT(*) as total_steps,
        COUNT(*) FILTER (WHERE action_type LIKE 'move_%') as move_attempts,
        COUNT(*) FILTER (WHERE action_type LIKE 'move_%' AND agent_actions.success) as successful_moves,
        COUNT(*) FILTER (WHERE action_type LIKE 'move_%' AND NOT agent_actions.success) as failed_moves,
        COUNT(*) FILTER (WHERE action_type = 'recall_all') as recall_count,
        MAX(turn_number) as max_turn,
        experiments.success as completed_successfully
      FROM agent_actions
      JOIN experiments ON experiments.id = agent_actions.experiment_id
      WHERE experiment_id = $1
      GROUP BY experiments.success
    `, [experimentId]);

    const stats = result.rows[0] || {};
    return {
      total_steps: parseInt(stats.total_steps || 0),
      move_attempts: parseInt(stats.move_attempts || 0),
      successful_moves: parseInt(stats.successful_moves || 0),
      failed_moves: parseInt(stats.failed_moves || 0),
      failure_rate: stats.move_attempts > 0
        ? stats.failed_moves / stats.move_attempts
        : 0,
      recall_count: parseInt(stats.recall_count || 0),
      max_turn: parseInt(stats.max_turn || 0),
      completed_successfully: stats.completed_successfully
    };
  } finally {
    await client.end();
  }
}

async function waitForExperimentCompletion(experimentId, { timeoutMs = 300000, pollIntervalMs = 5000 } = {}) {
  const client = await createDbClient();
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < timeoutMs) {
      const result = await client.query(
        'SELECT completed_at FROM experiments WHERE id = $1',
        [experimentId]
      );

      if (result.rows.length === 0) {
        throw new Error(`Experiment ${experimentId} not found`);
      }

      if (result.rows[0].completed_at) {
        return; // Completed!
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Experiment ${experimentId} did not complete within ${timeoutMs}ms`);
  } finally {
    await client.end();
  }
}

module.exports = {
  createDbClient,
  checkPositionContinuity,
  getTurnData,
  getExperimentStats,
  waitForExperimentCompletion
};
