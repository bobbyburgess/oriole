// Maze generator for Oriole project
// Generates various maze types for testing AI spatial reasoning
//
// Grid Tile Encoding (stored in grid_data as integers):
// - 0 = EMPTY: Passable tile, agents can walk through
// - 1 = WALL: Impassable tile, blocks movement and vision
// - 2 = GOAL: Target tile, passable, marks success when agent reaches/sees it
//
// The encoding is consistent across:
// - Database storage (mazes.grid_data JSON column)
// - Vision system (lambda/shared/vision.js constants)
// - Movement validation (lambda/actions/move_handler.js)
// - Agent perception (visible tiles returned as "empty", "wall", or "GOAL")

const fs = require('fs');
const path = require('path');

const GRID_SIZE = 60;
const EMPTY = 0;  // Passable floor tile
const WALL = 1;   // Impassable obstacle
const GOAL = 2;   // Target location (passable)

// Create empty grid
function createEmptyGrid() {
  return Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(EMPTY));
}

// Add border walls
function addBorder(grid) {
  for (let i = 0; i < GRID_SIZE; i++) {
    grid[0][i] = WALL;
    grid[GRID_SIZE - 1][i] = WALL;
    grid[i][0] = WALL;
    grid[i][GRID_SIZE - 1] = WALL;
  }
}

// Simple recursive backtracker maze (one path through)
function generateMaze(grid, density = 0.3) {
  const visited = Array(GRID_SIZE).fill(null).map(() => Array(GRID_SIZE).fill(false));

  function carve(x, y) {
    visited[y][x] = true;
    const directions = [
      [0, -2], [2, 0], [0, 2], [-2, 0]
    ].sort(() => Math.random() - 0.5);

    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;

      if (nx > 0 && nx < GRID_SIZE - 1 && ny > 0 && ny < GRID_SIZE - 1 && !visited[ny][nx]) {
        grid[y + dy/2][x + dx/2] = EMPTY;
        grid[ny][nx] = EMPTY;
        carve(nx, ny);
      }
    }
  }

  // Fill with walls first
  for (let y = 1; y < GRID_SIZE - 1; y++) {
    for (let x = 1; x < GRID_SIZE - 1; x++) {
      grid[y][x] = WALL;
    }
  }

  carve(1, 1);

  // Adjust density by removing some walls
  if (density < 0.5) {
    const removeCount = Math.floor((GRID_SIZE * GRID_SIZE) * (0.5 - density));
    for (let i = 0; i < removeCount; i++) {
      const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
      const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
      grid[y][x] = EMPTY;
    }
  }
}

// Open field with scattered obstacles
function generateOpenField(grid) {
  const obstacleCount = Math.floor((GRID_SIZE * GRID_SIZE) * 0.05);
  for (let i = 0; i < obstacleCount; i++) {
    const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    grid[y][x] = WALL;
  }
}

// Spiral pattern
function generateSpiral(grid) {
  let x = GRID_SIZE / 2;
  let y = GRID_SIZE / 2;
  let dx = 0, dy = -1;
  let steps = 1;
  let stepCount = 0;
  let turnCount = 0;

  while (x >= 1 && x < GRID_SIZE - 1 && y >= 1 && y < GRID_SIZE - 1) {
    grid[Math.floor(y)][Math.floor(x)] = WALL;

    stepCount++;
    if (stepCount === steps) {
      stepCount = 0;
      turnCount++;

      // Turn right
      const temp = dx;
      dx = -dy;
      dy = temp;

      if (turnCount === 2) {
        turnCount = 0;
        steps++;
      }
    }

    x += dx * 2;
    y += dy * 2;
  }
}

// Rooms and corridors
function generateRoomsAndCorridors(grid) {
  // Create 4 large rooms
  const rooms = [
    { x: 5, y: 5, w: 15, h: 15 },
    { x: 40, y: 5, w: 15, h: 15 },
    { x: 5, y: 40, w: 15, h: 15 },
    { x: 40, y: 40, w: 15, h: 15 }
  ];

  // Fill with walls
  for (let y = 1; y < GRID_SIZE - 1; y++) {
    for (let x = 1; x < GRID_SIZE - 1; x++) {
      grid[y][x] = WALL;
    }
  }

  // Carve out rooms
  rooms.forEach(room => {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (x < GRID_SIZE - 1 && y < GRID_SIZE - 1) {
          grid[y][x] = EMPTY;
        }
      }
    }
  });

  // Connect rooms with corridors
  // Horizontal corridor
  for (let x = 20; x < 40; x++) {
    grid[12][x] = EMPTY;
    grid[47][x] = EMPTY;
  }
  // Vertical corridor
  for (let y = 12; y < 47; y++) {
    grid[y][20] = EMPTY;
    grid[y][40] = EMPTY;
  }
}

// Multiple paths (less wall density)
function generateMultiplePaths(grid) {
  generateMaze(grid, 0.15);
}

// Random scatter
function generateRandomScatter(grid) {
  const obstacleCount = Math.floor((GRID_SIZE * GRID_SIZE) * 0.25);
  for (let i = 0; i < obstacleCount; i++) {
    const x = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;
    const y = Math.floor(Math.random() * (GRID_SIZE - 2)) + 1;

    // Create small 2x2 or 3x3 wall clusters
    const size = Math.random() > 0.5 ? 2 : 3;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        if (x + dx < GRID_SIZE - 1 && y + dy < GRID_SIZE - 1) {
          grid[y + dy][x + dx] = WALL;
        }
      }
    }
  }
}

// Diagonal bias
function generateDiagonalBias(grid) {
  // Create diagonal wall lines
  for (let i = 0; i < GRID_SIZE; i += 5) {
    for (let offset = 0; offset < GRID_SIZE - 5; offset++) {
      if (offset + i < GRID_SIZE - 1) {
        grid[offset][offset + i] = WALL;
        if (GRID_SIZE - 1 - offset - i >= 1) {
          grid[offset][GRID_SIZE - 1 - offset - i] = WALL;
        }
      }
    }
  }
}

// Add goal at a far position from start
function addGoal(grid, startX, startY) {
  // Place goal in opposite corner area
  const goalX = GRID_SIZE - 5;
  const goalY = GRID_SIZE - 5;

  // Find nearest empty spot
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const gx = goalX + dx;
      const gy = goalY + dy;
      if (gx > 0 && gx < GRID_SIZE - 1 && gy > 0 && gy < GRID_SIZE - 1 && grid[gy][gx] === EMPTY) {
        grid[gy][gx] = GOAL;
        return;
      }
    }
  }
}

// Save maze to JSON file
function saveMaze(name, grid, seeThrough = false) {
  const maze = {
    name,
    width: GRID_SIZE,
    height: GRID_SIZE,
    grid_data: grid,
    see_through_walls: seeThrough
  };

  const filename = path.join(__dirname, `${name}.json`);
  fs.writeFileSync(filename, JSON.stringify(maze, null, 2));
  console.log(`Created: ${filename}`);
}

// Generate all mazes
function generateAll() {
  console.log('Generating 12 mazes...\n');

  // 1. One-path mazes with varying density
  console.log('Creating one-path mazes:');
  const densities = [
    { name: '01_sparse_maze', density: 0.1 },
    { name: '02_light_maze', density: 0.2 },
    { name: '03_medium_maze', density: 0.3 },
    { name: '04_dense_maze', density: 0.4 },
    { name: '05_very_dense_maze', density: 0.5 },
    { name: '06_extreme_maze', density: 0.6 }
  ];

  densities.forEach(({ name, density }) => {
    const grid = createEmptyGrid();
    addBorder(grid);
    generateMaze(grid, density);
    addGoal(grid, 2, 2);
    saveMaze(name, grid);
  });

  // 2. Interesting variations
  console.log('\nCreating interesting variations:');

  const grid1 = createEmptyGrid();
  addBorder(grid1);
  generateOpenField(grid1);
  addGoal(grid1, 2, 2);
  saveMaze('07_open_field', grid1);

  const grid2 = createEmptyGrid();
  addBorder(grid2);
  generateSpiral(grid2);
  addGoal(grid2, 2, 2);
  saveMaze('08_spiral', grid2);

  const grid3 = createEmptyGrid();
  addBorder(grid3);
  generateRoomsAndCorridors(grid3);
  addGoal(grid3, 2, 2);
  saveMaze('09_rooms_corridors', grid3);

  const grid4 = createEmptyGrid();
  addBorder(grid4);
  generateMultiplePaths(grid4);
  addGoal(grid4, 2, 2);
  saveMaze('10_multiple_paths', grid4);

  const grid5 = createEmptyGrid();
  addBorder(grid5);
  generateDiagonalBias(grid5);
  addGoal(grid5, 2, 2);
  saveMaze('11_diagonal_bias', grid5);

  const grid6 = createEmptyGrid();
  addBorder(grid6);
  generateRandomScatter(grid6);
  addGoal(grid6, 2, 2);
  saveMaze('12_random_scatter', grid6);

  console.log('\n✅ All 12 mazes generated!');
}

generateAll();
