// recall_all action - Returns agent's spatial memory (all tiles seen across all actions)
//
// Purpose: Allows agents to "remember" what they've explored without re-visiting
// Cooldown: Configurable minimum number of moves between recalls (prevents analysis paralysis)
//
// How it works:
// 1. Check if agent has made enough movement actions since last recall
// 2. If cooldown active, reject with error message
// 3. Otherwise, aggregate all tiles_seen from agent_actions table
// 4. Return formatted memory with tile types and coordinates
//
// Configurable via: /oriole/experiments/recall-interval (default: 10 moves)

const db = require('../shared/db');
const vision = require('../shared/vision');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

// Module-level caching for recall interval parameter
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

exports.handler = async (event) => {
  try {
    const { experimentId, reasoning, turnNumber } = event;

    if (!experimentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'experimentId required' })
      };
    }

    // Enforce recall cooldown to prevent agents from getting stuck in "thinking loops"
    // Without this, agents tend to call recall_all repeatedly without exploring
    const recallInterval = await getRecallInterval();
    const dbClient = await db.getDbClient();

    // Find the most recent recall_all action
    const lastRecallResult = await dbClient.query(
      `SELECT step_number FROM agent_actions
       WHERE experiment_id = $1 AND action_type = 'recall_all'
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
            error: `Recall cooldown active. You must make ${recallInterval - movesSinceRecall} more movement actions before calling recall_all again. Use your vision and continue exploring!`,
            movesSinceLastRecall: movesSinceRecall,
            movesRequired: recallInterval
          })
        };
      }
    }
    // First recall is always allowed (no previous recall to check)

    // Get all tiles the agent has seen
    const seenTiles = await db.getAllSeenTiles(experimentId);

    // Get current position
    const currentPos = await db.getCurrentPosition(experimentId);

    // Get next step number
    const stepNumber = await db.getNextStepNumber(experimentId);

    // Log the recall action
    await db.logAction(
      experimentId,
      stepNumber,
      'recall_all',
      reasoning || '',
      currentPos.x,
      currentPos.y,
      null, // No movement
      null,
      true, // Always succeeds
      seenTiles,
      0,
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

    const response = {
      success: true,
      currentPosition: currentPos,
      tilesSeen: memory.length,
      memory: memory,
      message: `You have seen ${memory.length} tiles so far. Current position: (${currentPos.x}, ${currentPos.y})`
    };

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error in recall_all:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
