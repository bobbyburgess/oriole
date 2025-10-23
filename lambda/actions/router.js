// Router Lambda for Bedrock Agent action group
// Dispatches to the appropriate handler based on the action

const { handleMove } = require('./move_handler');
const recallAll = require('./recall_all');

exports.handler = async (event) => {
  console.log('Router received event:', JSON.stringify(event, null, 2));

  try {
    // Bedrock Agent event structure
    const { apiPath, requestBody, httpMethod } = event;

    // Parse request body if it's a string
    let body = requestBody;
    if (typeof requestBody === 'string') {
      body = JSON.parse(requestBody);
    }

    // Extract content from Bedrock Agent format
    const { experimentId, reasoning } = body;

    // Route based on API path
    switch (apiPath) {
      case '/move_north':
        return await handleMove('north', { experimentId, reasoning });

      case '/move_south':
        return await handleMove('south', { experimentId, reasoning });

      case '/move_east':
        return await handleMove('east', { experimentId, reasoning });

      case '/move_west':
        return await handleMove('west', { experimentId, reasoning });

      case '/recall_all':
        return await recallAll.handler({ experimentId, reasoning });

      default:
        return {
          statusCode: 404,
          body: JSON.stringify({ error: `Unknown action: ${apiPath}` })
        };
    }

  } catch (error) {
    console.error('Router error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        stack: error.stack
      })
    };
  }
};
