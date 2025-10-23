// Finalize Experiment Lambda
// Updates experiment record with final results

const { Client } = require('pg');

let dbClient = null;

async function getDbClient() {
  if (dbClient) {
    return dbClient;
  }

  dbClient = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await dbClient.connect();
  return dbClient;
}

exports.handler = async (event) => {
  console.log('Finalize experiment event:', JSON.stringify(event, null, 2));

  try {
    const { experimentId, status } = event;

    const db = await getDbClient();

    // Calculate total moves and tokens
    const statsResult = await db.query(
      `SELECT
         COUNT(*) as total_moves,
         COALESCE(SUM(tokens_used), 0) as total_tokens
       FROM agent_actions
       WHERE experiment_id = $1`,
      [experimentId]
    );

    const totalMoves = parseInt(statsResult.rows[0].total_moves);
    const totalTokens = parseInt(statsResult.rows[0].total_tokens);

    // Check if goal was found
    const goalResult = await db.query(
      `SELECT tiles_seen
       FROM agent_actions
       WHERE experiment_id = $1
       ORDER BY step_number DESC
       LIMIT 1`,
      [experimentId]
    );

    let foundGoal = false;
    if (goalResult.rows.length > 0 && goalResult.rows[0].tiles_seen) {
      const tilesSeen = goalResult.rows[0].tiles_seen;
      // Check if any tile is GOAL (value 2)
      for (const value of Object.values(tilesSeen)) {
        if (value === 2) {
          foundGoal = true;
          break;
        }
      }
    }

    // Update experiment
    await db.query(
      `UPDATE experiments
       SET completed_at = NOW(),
           status = $1,
           total_moves = $2,
           total_tokens = $3,
           success = $4
       WHERE id = $5`,
      [status === 'failed' ? 'failed' : 'completed', totalMoves, totalTokens, foundGoal, experimentId]
    );

    console.log(`Finalized experiment ${experimentId}: ${totalMoves} moves, ${totalTokens} tokens, success=${foundGoal}`);

    return {
      experimentId,
      totalMoves,
      totalTokens,
      success: foundGoal,
      status: status === 'failed' ? 'failed' : 'completed'
    };

  } catch (error) {
    console.error('Error finalizing experiment:', error);
    throw error;
  }
};
