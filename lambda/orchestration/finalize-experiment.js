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
    const { experimentId, success: explicitSuccess, failureReason } = event;

    const db = await getDbClient();

    // If called from error handler, use explicit success=false and failure reason
    if (explicitSuccess === false) {
      await db.query(
        `UPDATE experiments
         SET completed_at = NOW(),
             goal_found = $1,
             failure_reason = $2
         WHERE id = $3`,
        [false, failureReason || 'Unknown error', experimentId]
      );

      console.log(`Finalized experiment ${experimentId}: failed with reason: ${failureReason}`);

      return {
        experimentId,
        goal_found: false,
        failureReason
      };
    }

    // Normal completion path - check if goal was found
    // Note: Token counts are tracked in experiments table via check-progress.js
    // No need to aggregate from agent_actions (we use total_input_tokens + total_output_tokens)

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
           goal_found = $1
       WHERE id = $2`,
      [foundGoal, experimentId]
    );

    console.log(`Finalized experiment ${experimentId}: goal_found=${foundGoal}`);

    return {
      experimentId,
      goal_found: foundGoal
    };

  } catch (error) {
    console.error('Error finalizing experiment:', error);
    throw error;
  }
};
