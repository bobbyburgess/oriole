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
    const { experimentId, success: explicitSuccess, failureReason, errorInfo } = event;

    const db = await getDbClient();

    /**
     * ERROR PATH: Execution failed before normal completion
     *
     * This path is triggered when:
     *   1. Lambda timeout (15 minute limit exceeded)
     *   2. Unhandled exception in invoke-agent Lambda
     *   3. Step Functions task failure (States.TaskFailed)
     *   4. Manual abort
     *
     * Key fields updated:
     *   - execution_status: Set to 'FAILED' (or 'TIMED_OUT' if we can detect it)
     *   - last_error: Structured error info (error type + cause + timestamp)
     *   - failure_reason: Human-readable error message (existing field)
     *   - completed_at: Mark as completed even though it failed
     *   - goal_found: false (didn't complete successfully)
     *
     * Why capture structured errors:
     *   - errorInfo.Error: AWS error type (e.g., "Lambda.Timeout", "States.TaskFailed")
     *   - errorInfo.Cause: Detailed message from AWS (JSON string or plain text)
     *   - Enables automated error classification and alerting
     *
     * See: db/migrations/015_add_execution_tracking_columns.sql for schema details
     */
    if (explicitSuccess === false) {
      // Parse error details from Step Functions error handler
      // errorInfo comes from: .addCatch(finalizeOnError, { resultPath: '$.errorInfo' })
      let lastError = null;
      let executionStatus = 'FAILED';  // Default to FAILED

      if (errorInfo) {
        // Detect specific error types for better status classification
        const errorType = errorInfo.Error || 'Unknown';

        if (errorType.includes('Timeout') || errorType === 'States.Timeout') {
          executionStatus = 'TIMED_OUT';
        }

        // Structure error for database (matches schema in migration 015)
        lastError = {
          error: errorType,
          cause: errorInfo.Cause || failureReason || 'No error details provided',
          timestamp: new Date().toISOString()
        };

        console.log(`Execution failed with error type: ${errorType}`);
      }

      await db.query(
        `UPDATE experiments
         SET completed_at = NOW(),
             goal_found = $1,
             failure_reason = $2,
             execution_status = $3,
             last_error = $4
         WHERE id = $5`,
        [
          false,
          failureReason || 'Unknown error',
          executionStatus,
          lastError ? JSON.stringify(lastError) : null,
          experimentId
        ]
      );

      console.log(`Finalized experiment ${experimentId}: ${executionStatus} with reason: ${failureReason}`);

      return {
        experimentId,
        goal_found: false,
        failureReason,
        execution_status: executionStatus
      };
    }

    // Normal completion path - check if goal was found
    // Note: Token/cost data is stored per-turn in agent_actions table
    // Use experiments_with_costs view to calculate totals (denormalized columns removed)

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

    /**
     * SUCCESS PATH: Execution completed normally
     *
     * Update experiment with final status:
     *   - execution_status: Set to 'SUCCEEDED' (execution completed, even if goal not found)
     *   - goal_found: true/false based on whether GOAL tile (value 2) was seen
     *   - completed_at: Timestamp of completion
     *
     * Important distinction:
     *   - execution_status='SUCCEEDED' means Step Functions execution completed
     *   - goal_found=true means the agent actually found the goal tile
     *
     * Possible combinations:
     *   1. execution_status='SUCCEEDED', goal_found=true: Perfect run
     *   2. execution_status='SUCCEEDED', goal_found=false: Completed but failed to find goal
     *   3. execution_status='FAILED', goal_found=false: Execution crashed
     *   4. execution_status='TIMED_OUT', goal_found=false: Lambda timeout
     *
     * last_error remains NULL on success path (only populated on failure path above)
     */
    await db.query(
      `UPDATE experiments
       SET completed_at = NOW(),
           goal_found = $1,
           execution_status = $2
       WHERE id = $3`,
      [foundGoal, 'SUCCEEDED', experimentId]
    );

    console.log(`Finalized experiment ${experimentId}: execution_status=SUCCEEDED, goal_found=${foundGoal}`);

    return {
      experimentId,
      goal_found: foundGoal,
      execution_status: 'SUCCEEDED'
    };

  } catch (error) {
    console.error('Error finalizing experiment:', error);
    throw error;
  }
};
