// Vision calculation for agent perception

const VISION_RANGE = 3;
const EMPTY = 0;
const WALL = 1;
const GOAL = 2;

/**
 * Calculate what the agent can see from a given position
 * Uses line-of-sight: walls block vision
 *
 * @param {Array} grid - 2D maze grid
 * @param {number} x - Agent x position
 * @param {number} y - Agent y position
 * @param {boolean} seeThroughWalls - Whether walls block vision
 * @returns {Object} Map of visible tiles {x,y}: tileType
 */
function calculateVision(grid, x, y, seeThroughWalls = false) {
  const visible = {};
  const height = grid.length;
  const width = grid[0].length;

  // Always see current position
  visible[`${x},${y}`] = grid[y][x];

  if (seeThroughWalls) {
    // Simple: can see everything within range
    for (let dy = -VISION_RANGE; dy <= VISION_RANGE; dy++) {
      for (let dx = -VISION_RANGE; dx <= VISION_RANGE; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          visible[`${nx},${ny}`] = grid[ny][nx];
        }
      }
    }
  } else {
    // Line-of-sight: cast rays in each direction
    // North
    for (let i = 1; i <= VISION_RANGE; i++) {
      const ny = y - i;
      if (ny < 0) break;
      visible[`${x},${ny}`] = grid[ny][x];
      if (grid[ny][x] === WALL) break; // Wall blocks further vision
    }

    // South
    for (let i = 1; i <= VISION_RANGE; i++) {
      const ny = y + i;
      if (ny >= height) break;
      visible[`${x},${ny}`] = grid[ny][x];
      if (grid[ny][x] === WALL) break;
    }

    // East
    for (let i = 1; i <= VISION_RANGE; i++) {
      const nx = x + i;
      if (nx >= width) break;
      visible[`${nx},${y}`] = grid[y][nx];
      if (grid[y][nx] === WALL) break;
    }

    // West
    for (let i = 1; i <= VISION_RANGE; i++) {
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
