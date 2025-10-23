// recall_all action - returns all tiles the agent has seen

const db = require('../shared/db');
const vision = require('../shared/vision');

exports.handler = async (event) => {
  try {
    const { experimentId, reasoning } = event;

    if (!experimentId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'experimentId required' })
      };
    }

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
      0
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
