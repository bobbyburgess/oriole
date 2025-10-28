/**
 * Unit tests for vision calculation
 *
 * Tests the line-of-sight algorithm that determines what tiles
 * the agent can see from its current position.
 *
 * These are pure logic tests - no AWS dependencies, fast execution.
 * Uses visionRangeOverride parameter to bypass SSM calls.
 *
 * Run with: npm run test:unit
 */

const { calculateVision, EMPTY, WALL, GOAL } = require('../../lambda/shared/vision');

// Vision range for tests (matches production default)
const TEST_VISION_RANGE = 3;

describe('Vision Calculation', () => {
  describe('Line-of-sight in cardinal directions', () => {
    test('sees straight line in open corridor', async () => {
      const grid = [
        [0, 0, 0, 0, 0, 0, 0],  // Open corridor
        [0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0],
      ];

      const visible = await calculateVision(grid, 3, 1, false, TEST_VISION_RANGE);

      // Should see own position
      expect(visible['3,1']).toBe(EMPTY);

      // Should see 3 tiles north (up to vision range)
      expect(visible['3,0']).toBe(EMPTY);

      // Should see 3 tiles south
      expect(visible['3,2']).toBe(EMPTY);

      // Should see 3 tiles east
      expect(visible['6,1']).toBe(EMPTY);

      // Should see 3 tiles west
      expect(visible['0,1']).toBe(EMPTY);

      // Should NOT see diagonals (not cardinal direction)
      expect(visible['4,2']).toBeUndefined();
      expect(visible['2,0']).toBeUndefined();
    });

    test('vision range is respected', async () => {
      const grid = [
        [0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0],
      ];

      const visible = await calculateVision(grid, 0, 0, false, TEST_VISION_RANGE);

      // Should see 1, 2, 3 tiles east (within vision range = 3)
      expect(visible['1,0']).toBe(EMPTY);
      expect(visible['2,0']).toBe(EMPTY);
      expect(visible['3,0']).toBe(EMPTY);

      // Should NOT see 4th tile (beyond vision range)
      expect(visible['4,0']).toBeUndefined();
      expect(visible['5,0']).toBeUndefined();
    });
  });

  describe('Wall blocking behavior', () => {
    test('walls block line of sight', async () => {
      const grid = [
        [0, 0, 0, 0, 0],
        [0, 0, 1, 0, 0],  // Wall at (2,1)
        [0, 0, 0, 0, 0],
      ];

      const visible = await calculateVision(grid, 1, 1, false, TEST_VISION_RANGE);

      // Should see the wall itself
      expect(visible['2,1']).toBe(WALL);

      // Should NOT see beyond the wall
      expect(visible['3,1']).toBeUndefined();
      expect(visible['4,1']).toBeUndefined();

      // Should still see in other directions (wall doesn't block those)
      expect(visible['0,1']).toBe(EMPTY); // West
      expect(visible['1,0']).toBe(EMPTY); // North
      expect(visible['1,2']).toBe(EMPTY); // South
    });

    test('multiple walls create isolated corridors', async () => {
      const grid = [
        [0, 1, 0],  // Wall at (1,0)
        [0, 0, 0],
        [0, 1, 0],  // Wall at (1,2)
      ];

      const visible = await calculateVision(grid, 1, 1, false, TEST_VISION_RANGE);

      // Should see walls to north and south
      expect(visible['1,0']).toBe(WALL);
      expect(visible['1,2']).toBe(WALL);

      // Should see tiles left and right
      expect(visible['0,1']).toBe(EMPTY);
      expect(visible['2,1']).toBe(EMPTY);

      // Should NOT see beyond walls
      expect(visible['0,0']).toBeUndefined();
      expect(visible['2,0']).toBeUndefined();
    });

    test('wall directly next to agent blocks immediately', async () => {
      const grid = [
        [0, 0, 0],
        [0, 1, 0],  // Wall at (1,1) - agent position
        [0, 0, 0],
      ];

      const visible = await calculateVision(grid, 0, 1, false, TEST_VISION_RANGE); // West of wall

      // Should see the adjacent wall
      expect(visible['1,1']).toBe(WALL);

      // Should NOT see past it
      expect(visible['2,1']).toBeUndefined();
    });
  });

  describe('Goal detection', () => {
    test('goal marker is visible', async () => {
      const grid = [
        [0, 0, 0],
        [0, 0, 2],  // Goal at (2,1)
        [0, 0, 0],
      ];

      const visible = await calculateVision(grid, 0, 1, false, TEST_VISION_RANGE); // West side

      // Should see goal 2 tiles away
      expect(visible['2,1']).toBe(GOAL);
    });

    test('goal behind wall is not visible', async () => {
      const grid = [
        [0, 1, 2],  // Wall at (1,0), Goal at (2,0)
      ];

      const visible = await calculateVision(grid, 0, 0, false, TEST_VISION_RANGE);

      // Should see wall
      expect(visible['1,0']).toBe(WALL);

      // Should NOT see goal behind wall
      expect(visible['2,0']).toBeUndefined();
    });
  });

  describe('Boundary handling', () => {
    test('respects grid boundaries on small grid', async () => {
      const grid = [
        [0, 0, 0],
        [0, 0, 0],
      ];

      // Agent at northwest corner
      const visible = await calculateVision(grid, 0, 0, false, TEST_VISION_RANGE);

      // Should not have coordinates outside grid
      expect(visible['-1,0']).toBeUndefined();
      expect(visible['0,-1']).toBeUndefined();

      // Should see own position
      expect(visible['0,0']).toBe(EMPTY);

      // Should see within bounds
      expect(visible['1,0']).toBe(EMPTY);
      expect(visible['0,1']).toBe(EMPTY);
    });

    test('vision stops at boundary even if range permits more', async () => {
      const grid = [
        [0, 0],  // Only 2 tiles wide
      ];

      const visible = await calculateVision(grid, 0, 0, false, TEST_VISION_RANGE);

      // Vision range is 3, but grid is only 2 wide
      expect(visible['1,0']).toBe(EMPTY);
      expect(visible['2,0']).toBeUndefined(); // Out of bounds
      expect(visible['3,0']).toBeUndefined(); // Out of bounds
    });

    test('handles agent at various edge positions', async () => {
      const grid = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];

      // Southwest corner
      const sw = await calculateVision(grid, 0, 2, false, TEST_VISION_RANGE);
      expect(sw['0,2']).toBe(EMPTY); // Own position
      expect(sw['0,3']).toBeUndefined(); // South boundary
      expect(sw['-1,2']).toBeUndefined(); // West boundary

      // Northeast corner
      const ne = await calculateVision(grid, 3, 0, false, TEST_VISION_RANGE);
      expect(ne['3,0']).toBe(EMPTY); // Own position
      expect(ne['3,-1']).toBeUndefined(); // North boundary
      expect(ne['4,0']).toBeUndefined(); // East boundary
    });
  });

  describe('Edge cases', () => {
    test('agent standing on goal sees goal tile', async () => {
      const grid = [
        [0, 0, 0],
        [0, 2, 0],  // Agent on goal at (1,1)
        [0, 0, 0],
      ];

      const visible = await calculateVision(grid, 1, 1, false, TEST_VISION_RANGE);

      // Should see that they're standing on goal
      expect(visible['1,1']).toBe(GOAL);
    });

    test('single tile grid', async () => {
      const grid = [[0]];

      const visible = await calculateVision(grid, 0, 0, false, TEST_VISION_RANGE);

      // Should only see own position
      expect(visible['0,0']).toBe(EMPTY);
      expect(Object.keys(visible).length).toBe(1);
    });

    test('long corridor with wall at exact vision range', async () => {
      const grid = [
        [0, 0, 0, 0, 1, 0, 0],  // Wall at position 4 (3 tiles away)
      ];

      const visible = await calculateVision(grid, 1, 0, false, TEST_VISION_RANGE);

      // Should see 3 tiles east (vision range = 3)
      expect(visible['2,0']).toBe(EMPTY);
      expect(visible['3,0']).toBe(EMPTY);
      expect(visible['4,0']).toBe(WALL); // Wall at exact vision limit

      // Should NOT see beyond the wall
      expect(visible['5,0']).toBeUndefined();
    });
  });
});
