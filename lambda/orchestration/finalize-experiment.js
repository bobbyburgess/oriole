// Finalize Experiment Lambda
// Final step in the Step Functions workflow
//
// Responsibilities:
// 1. Calculate total actions and tokens used across all agent_actions
// 2. Determine if the goal was found (check for GOAL tile in vision)
// 3. Update experiments table with final status, counts, and completion timestamp
//
// Called when: shouldContinue=false from check-progress (max moves, duration, or goal found)

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

// Module-level caching for DB credentials
let dbClient = null;
let cachedDbPassword = null;

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

async function getDbClient() {
  if (dbClient) {
    return dbClient;
  }

  const password = await getDbPassword();

  dbClient = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: password,
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

    // Aggregate statistics from all agent actions
    // total_moves: Count of all actions (movement + recall)
    // total_tokens: Sum of tokens used (currently 0, Bedrock doesn't expose this yet)
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

    // Check if the agent found the goal
    // We look at the most recent action's tiles_seen field
    // If any visible tile has value 2 (GOAL constant), the agent succeeded
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
      // tiles_seen is a JSON object: {"x,y": tileType, ...}
      // Check if any tile is GOAL (value 2 from vision.js constants)
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
