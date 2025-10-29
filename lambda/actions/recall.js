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
let cachedMaxRecallDepth = null;

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

async function getMaxRecallDepth() {
  if (cachedMaxRecallDepth !== null) {
    return cachedMaxRecallDepth;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/experiments/max-recall-depth',
    WithDecryption: false
  });

  const response = await ssmClient.send(command);
  cachedMaxRecallDepth = parseInt(response.Parameter.Value);
  return cachedMaxRecallDepth;
}

/**
 * Recall handler - accepts explicit limit parameter
 * @param {Object} event - Contains experimentId, reasoning, turnNumber
 * @param {number} limit - Number of recent actions to recall (25, 50, 100, or 200)
 */
exports.handler = async (event, limit) => {
  try {
    const { experimentId, reasoning, turnNumber, assistantMessage } = event;

    if (!experimentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'experimentId required' })
      };
    }

    // Validate and cap depth at configured maximum
    const maxDepth = await getMaxRecallDepth();
    const cappedLimit = Math.min(limit, maxDepth);
    const wasLimited = limit > maxDepth;

    if (wasLimited) {
      console.log(`Depth ${limit} exceeds max ${maxDepth}, capping to ${maxDepth}`);
    }

    // Get current position
    const currentPos = await db.getCurrentPosition(experimentId);
    const dbClient = await db.getDbClient();

    // Get detailed action history (path + vision)
    const historyResult = await dbClient.query(
      `SELECT action_type, from_x, from_y, to_x, to_y, tiles_seen, success
       FROM agent_actions
       WHERE experiment_id = $1
         AND action_type <> 'no_tool_call'
         AND action_type NOT LIKE 'recall_%'
       ORDER BY step_number DESC
       LIMIT $2`,
      [experimentId, cappedLimit]
    );

    const actions = historyResult.rows.reverse(); // Chronological order

    // Build exploration history (path + vision combined)
    const explorationHistory = actions.map(action => {
      const position = action.success
        ? `(${action.to_x}, ${action.to_y})`
        : `(${action.from_x}, ${action.from_y})`;

      let visionText = 'No vision data';
      if (action.tiles_seen) {
        const tiles = typeof action.tiles_seen === 'string'
          ? JSON.parse(action.tiles_seen)
          : action.tiles_seen;
        const tileDescriptions = tiles.map(t => {
          const tileType = t.type === 'goal' ? 'GOAL' : t.type;
          return `${tileType} at (${t.x},${t.y})`;
        });
        visionText = tileDescriptions.length > 0
          ? `Saw ${tileDescriptions.join(', ')}`
          : 'No tiles visible';
      }

      const moveResult = action.success ? '✓' : '✗';
      return `${moveResult} ${action.action_type} → ${position}: ${visionText}`;
    });

    // Build tiles discovered summary (deduplicated)
    const tilesDiscovered = { empty: [], wall: [], goal: [] };
    const seenCoords = new Set();

    for (const action of actions) {
      if (action.tiles_seen) {
        const tiles = typeof action.tiles_seen === 'string'
          ? JSON.parse(action.tiles_seen)
          : action.tiles_seen;

        for (const tile of tiles) {
          const coord = `(${tile.x},${tile.y})`;
          if (!seenCoords.has(coord)) {
            seenCoords.add(coord);
            if (tile.type === vision.GOAL || tile.type === 'goal') {
              tilesDiscovered.goal.push(coord);
            } else if (tile.type === vision.WALL || tile.type === 'wall') {
              tilesDiscovered.wall.push(coord);
            } else {
              tilesDiscovered.empty.push(coord);
            }
          }
        }
      }
    }

    // Get next step number for logging
    const stepNumber = await db.getNextStepNumber(experimentId);

    // Log the recall action (use empty object for tiles_seen since we're returning structured history)
    await db.logAction(
      experimentId,
      stepNumber,
      'recall_movement_history',
      reasoning || '',
      currentPos.x,
      currentPos.y,
      null, // No movement
      null,
      true, // Always succeeds
      {}, // Empty tiles_seen (not using this field for recall_movement_history)
      turnNumber || null,
      null, // inputTokens (not available in handler)
      null, // outputTokens (not available in handler)
      assistantMessage || null // Full LLM response
    );

    // Build path summary
    const pathSummary = actions.length > 0
      ? `${actions.length} actions: ${actions[0].from_x},${actions[0].from_y} → ${currentPos.x},${currentPos.y}`
      : 'No movement history';

    let message = `Recalled last ${cappedLimit} actions. ${pathSummary}. Discovered ${seenCoords.size} unique tiles.`;

    if (wasLimited) {
      message += ` NOTE: You requested depth=${limit}, but the maximum recall depth is ${maxDepth}. Only the last ${maxDepth} actions were returned. This limit helps manage token usage and context window constraints.`;
    }

    const response = {
      success: true,
      actionsRecalled: actions.length,
      pathSummary: pathSummary,
      explorationHistory: explorationHistory,
      tilesDiscovered: tilesDiscovered,
      currentPosition: currentPos,
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
