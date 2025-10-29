// Shared movement handler for all directional moves
// Called by router.js for move_north, move_south, move_east, move_west
//
// Grid Tile Encoding:
// - 0 = EMPTY (passable)
// - 1 = WALL (blocks movement and vision)
// - 2 = GOAL (target location, passable)
//
// Flow:
// 1. Calculate target position based on direction
// 2. Validate move (check walls, boundaries)
// 3. If invalid, agent stays in place (success=false)
// 4. Calculate vision from actual position
// 5. Log action to database with from/to coordinates
// 6. Return success status and visible tiles to agent

const db = require('../shared/db');
const vision = require('../shared/vision');

const DIRECTIONS = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 }
};

/**
 * Handle a movement action
 * @param {string} direction - 'north', 'south', 'east', or 'west'
 * @param {Object} event - Bedrock agent event
 */
async function handleMove(direction, event) {
  try {
    // Parse event from Bedrock Agent
    const { experimentId, reasoning, turnNumber, assistantMessage } = event;

    if (!experimentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'experimentId required' })
      };
    }

    // Get current position
    const currentPos = await db.getCurrentPosition(experimentId);
    const experiment = await db.getExperiment(experimentId);
    const maze = await db.getMaze(experiment.maze_id);
    const grid = maze.grid_data;

    // Calculate new position
    const delta = DIRECTIONS[direction];
    const newX = currentPos.x + delta.dx;
    const newY = currentPos.y + delta.dy;

    // Check if move is valid (not a wall, within bounds)
    // Invalid moves return success=false but still log the action
    // Agent stays in place and sees tiles from current position
    // This feedback helps the agent learn maze boundaries
    const height = grid.length;
    const width = grid[0].length;
    let success = true;
    let actualX = newX;
    let actualY = newY;

    if (newX < 0 || newX >= width || newY < 0 || newY >= height) {
      // Out of bounds - agent stays in current position
      success = false;
      actualX = currentPos.x;
      actualY = currentPos.y;
    } else if (grid[newY][newX] === vision.WALL) {
      // Hit a wall - agent stays in current position
      success = false;
      actualX = currentPos.x;
      actualY = currentPos.y;
    }

    // Calculate vision from new position
    const visibleTiles = await vision.calculateVision(
      grid,
      actualX,
      actualY,
      maze.see_through_walls
    );

    // Get next step number
    const stepNumber = await db.getNextStepNumber(experimentId);

    // Log the action
    await db.logAction(
      experimentId,
      stepNumber,
      `move_${direction}`,
      reasoning || '',
      currentPos.x,
      currentPos.y,
      actualX,
      actualY,
      success,
      visibleTiles,
      turnNumber || null,
      null, // inputTokens (not available in handler)
      null, // outputTokens (not available in handler)
      assistantMessage || null // Full LLM response
    );

    // Check if agent found the goal
    let foundGoal = false;
    for (const [coord, type] of Object.entries(visibleTiles)) {
      if (type === vision.GOAL) {
        foundGoal = true;
        break;
      }
    }

    // CRITICAL: Update goal_found immediately so check-progress can stop the experiment
    if (foundGoal) {
      await db.updateGoalFound(experimentId, true);
      console.log(`🎯 GOAL FOUND! Experiment ${experimentId} will stop after this turn.`);
    }

    // Build response
    const response = {
      success,
      position: { x: actualX, y: actualY },
      visible: vision.describeVision(visibleTiles),
      foundGoal,
      message: success
        ? `Moved ${direction} to (${actualX}, ${actualY})`
        : `Cannot move ${direction} - ${grid[newY]?.[newX] === vision.WALL ? 'wall' : 'boundary'} in the way. Still at (${actualX}, ${actualY})`
    };

    return {
      statusCode: 200,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Error in move handler:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
}

module.exports = { handleMove };
