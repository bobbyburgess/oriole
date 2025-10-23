// Vision calculation for agent perception
// Determines what tiles the agent can see from its current position
//
// Vision modes:
// 1. Line-of-sight (default): Agent sees N tiles in each cardinal direction until hitting a wall
// 2. See-through-walls: Agent sees all tiles within N-tile radius (for testing/easy mode)
//
// Vision range is configurable via Parameter Store: /oriole/gameplay/vision-range
// This allows difficulty tuning without redeployment

const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const ssmClient = new SSMClient();

// Module-level caching for vision range parameter
let cachedVisionRange = null;

async function getVisionRange() {
  if (cachedVisionRange !== null) {
    return cachedVisionRange;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/gameplay/vision-range',
    WithDecryption: false
  });

  const response = await ssmClient.send(command);
  cachedVisionRange = parseInt(response.Parameter.Value);
  return cachedVisionRange;
}

// Tile type constants (must match maze generator and DB schema)
const EMPTY = 0;
const WALL = 1;
const GOAL = 2;

/**
 * Calculate what the agent can see from a given position
 *
 * Line-of-sight mode (default):
 * - Cast rays in 4 cardinal directions (N, S, E, W)
 * - Stop at first wall encountered (walls block vision)
 * - Returns all visible tiles within range
 *
 * See-through mode (testing/debug):
 * - Returns all tiles within Manhattan distance
 * - Walls don't block vision
 *
 * @param {Array} grid - 2D maze grid (grid[y][x])
 * @param {number} x - Agent x position (column)
 * @param {number} y - Agent y position (row)
 * @param {boolean} seeThroughWalls - Whether walls block vision (default: false)
 * @returns {Object} Map of visible tiles {"x,y": tileType}
 */
async function calculateVision(grid, x, y, seeThroughWalls = false) {
  const visible = {};
  const height = grid.length;
  const width = grid[0].length;
  const visionRange = await getVisionRange();

  // Agent always sees the tile they're standing on
  visible[`${x},${y}`] = grid[y][x];

  if (seeThroughWalls) {
    // Debug/easy mode: See all tiles within range (Manhattan distance)
    for (let dy = -visionRange; dy <= visionRange; dy++) {
      for (let dx = -visionRange; dx <= visionRange; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          visible[`${nx},${ny}`] = grid[ny][nx];
        }
      }
    }
  } else {
    // Line-of-sight: Cast rays in 4 cardinal directions
    // Stop at first wall (or boundary) encountered in each direction

    // North (decreasing Y)
    for (let i = 1; i <= visionRange; i++) {
      const ny = y - i;
      if (ny < 0) break; // Hit boundary
      visible[`${x},${ny}`] = grid[ny][x];
      if (grid[ny][x] === WALL) break; // Wall blocks further vision
    }

    // South
    for (let i = 1; i <= visionRange; i++) {
      const ny = y + i;
      if (ny >= height) break;
      visible[`${x},${ny}`] = grid[ny][x];
      if (grid[ny][x] === WALL) break;
    }

    // East
    for (let i = 1; i <= visionRange; i++) {
      const nx = x + i;
      if (nx >= width) break;
      visible[`${nx},${y}`] = grid[y][nx];
      if (grid[y][nx] === WALL) break;
    }

    // West
    for (let i = 1; i <= visionRange; i++) {
      const nx = x - i;
      if (nx < 0) break;
      visible[`${nx},${y}`] = grid[y][nx];
      if (grid[y][nx] === WALL) break;
    }
  }

  return visible;
}

/**
 * Format visible tiles as a human-readable description
 */
function describeVision(visibleTiles) {
  const tiles = [];

  for (const [coord, type] of Object.entries(visibleTiles)) {
    const [x, y] = coord.split(',').map(Number);
    let description = `(${x},${y}): `;

    switch (type) {
      case EMPTY:
        description += 'empty';
        break;
      case WALL:
        description += 'wall';
        break;
      case GOAL:
        description += 'GOAL';
        break;
    }

    tiles.push(description);
  }

  return tiles.join(', ');
}

module.exports = {
  calculateVision,
  describeVision,
  EMPTY,
  WALL,
  GOAL
};
