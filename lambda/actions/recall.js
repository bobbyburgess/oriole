// recall action - Returns agent's spatial memory with explicit depth limits
//
// Four variants available (called via router):
// - recall_last_25: Returns tiles from last 25 actions
// - recall_last_50: Returns tiles from last 50 actions
// - recall_last_100: Returns tiles from last 100 actions
// - recall_last_200: Returns tiles from last 200 actions
//
// Purpose: Allows agents to strategically manage memory/context tradeoff
// Cooldown: Configurable minimum number of moves between recalls (prevents analysis paralysis)
//
// Configurable via: /oriole/experiments/recall-interval (default: 10 moves)

const db = require('../shared/db');
const vision = require('../shared/vision');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

// Module-level caching for configuration parameters
let cachedRecallInterval = null;

async function getRecallInterval() {
  if (cachedRecallInterval !== null) {
    return cachedRecallInterval;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/experiments/recall-interval',
    WithDecryption: false
  });

  const response = await ssmClient.send(command);
  cachedRecallInterval = parseInt(response.Parameter.Value);
  return cachedRecallInterval;
}

/**
 * Recall handler - accepts explicit limit parameter
 * @param {Object} event - Contains experimentId, reasoning, turnNumber
 * @param {number} limit - Number of recent actions to recall (25, 50, 100, or 200)
 */
exports.handler = async (event, limit) => {
  try {
    const { experimentId, reasoning, turnNumber } = event;

    if (!experimentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'experimentId required' })
      };
    }

    /**
     * Enforce recall cooldown to prevent agents from getting stuck in "thinking loops"
     *
     * BEHAVIOR PROBLEM: Without cooldown, LLMs tend to repeatedly call recall
     *                   without exploring, trying to "reason" their way through the maze
     *                   Example: recall -> recall -> recall (no movement!)
     *
     * SOLUTION: Force minimum exploration between recalls
     *          Count only MOVEMENT actions (move_*), not other recalls
     *          This ensures agent is actively exploring, not just thinking
     *
     * Default: 10 movements required between recalls (configurable via Parameter Store)
     */
    const recallInterval = await getRecallInterval();
    const dbClient = await db.getDbClient();

    // Find the most recent recall action (any recall_last_* variant)
    const lastRecallResult = await dbClient.query(
      `SELECT step_number FROM agent_actions
       WHERE experiment_id = $1 AND action_type LIKE 'recall_last_%'
       ORDER BY step_number DESC LIMIT 1`,
      [experimentId]
    );

    // If there was a previous recall, check if enough moves have been made since
    if (lastRecallResult.rows.length > 0) {
      const lastRecallStep = lastRecallResult.rows[0].step_number;

      // Count only MOVEMENT actions (not other recalls)
      // This ensures the agent is actually exploring, not just thinking
      const movesSinceRecallResult = await dbClient.query(
        `SELECT COUNT(*) as move_count FROM agent_actions
         WHERE experiment_id = $1
         AND step_number > $2
         AND action_type LIKE 'move_%'`,
        [experimentId, lastRecallStep]
      );

      const movesSinceRecall = parseInt(movesSinceRecallResult.rows[0].move_count);

      // Reject if cooldown is still active
      if (movesSinceRecall < recallInterval) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: `Recall cooldown active. You must make ${recallInterval - movesSinceRecall} more movement actions before calling any recall tool again. Use your vision and continue exploring!`,
            movesSinceLastRecall: movesSinceRecall,
            movesRequired: recallInterval
          })
        };
      }
    }
    // First recall is always allowed (no previous recall to check)

    // Get tiles the agent has seen (limited to recent N actions based on tool called)
    const seenTiles = await db.getAllSeenTiles(experimentId, limit);

    // Get current position
    const currentPos = await db.getCurrentPosition(experimentId);

    // Get next step number
    const stepNumber = await db.getNextStepNumber(experimentId);

    // Log the recall action with specific tool name
    await db.logAction(
      experimentId,
      stepNumber,
      `recall_last_${limit}`,
      reasoning || '',
      currentPos.x,
      currentPos.y,
      null, // No movement
      null,
      true, // Always succeeds
      seenTiles,
      turnNumber || null
    );

    // Format the recalled memory
    const memory = [];
    for (const [coord, type] of Object.entries(seenTiles)) {
      const [x, y] = coord.split(',').map(Number);
      let tileType = '';
      switch (type) {
        case vision.EMPTY:
          tileType = 'empty';
          break;
        case vision.WALL:
          tileType = 'wall';
          break;
        case vision.GOAL:
          tileType = 'GOAL';
          break;
      }
      memory.push({ x, y, type: tileType });
    }

    // Build response message with explicit limit information
    const message = `Memory recall complete. You have ${memory.length} tiles from your last ${limit} actions. Current position: (${currentPos.x}, ${currentPos.y})`;

    const response = {
      success: true,
      currentPosition: currentPos,
      tilesSeen: memory.length,
      memory: memory,
      message: message
    };

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error(`Error in recall_last_${limit}:`, error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
