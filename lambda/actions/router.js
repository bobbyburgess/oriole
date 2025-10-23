// Router Lambda for Bedrock Agent action group
// Dispatches to the appropriate handler based on the action

const { handleMove } = require('./move_handler');
const recallAll = require('./recall_all');

exports.handler = async (event) => {
  console.log('Router received event:', JSON.stringify(event, null, 2));

  try {
    // Bedrock Agent event structure
    const { apiPath, requestBody, httpMethod } = event;

    // Parse Bedrock Agent request body format
    const properties = requestBody?.content?.['application/json']?.properties || [];

    // Convert properties array to object
    const params = {};
    properties.forEach(prop => {
      params[prop.name] = prop.value;
    });

    const { experimentId, reasoning } = params;

    // Route based on API path
    let result;
    switch (apiPath) {
      case '/move_north':
        result = await handleMove('north', { experimentId, reasoning });
        break;

      case '/move_south':
        result = await handleMove('south', { experimentId, reasoning });
        break;

      case '/move_east':
        result = await handleMove('east', { experimentId, reasoning });
        break;

      case '/move_west':
        result = await handleMove('west', { experimentId, reasoning });
        break;

      case '/recall_all':
        result = await recallAll.handler({ experimentId, reasoning });
        break;

      default:
        result = {
          statusCode: 404,
          body: JSON.stringify({ error: `Unknown action: ${apiPath}` })
        };
    }

    // Transform to Bedrock Agent response format
    return {
      messageVersion: '1.0',
      response: {
        actionGroup: event.actionGroup,
        apiPath,
        httpMethod,
        httpStatusCode: result.statusCode,
        responseBody: {
          'application/json': {
            body: result.body
          }
        }
      }
    };

  } catch (error) {
    console.error('Router error:', error);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup: event.actionGroup || '',
        apiPath: event.apiPath || '',
        httpMethod: event.httpMethod || '',
        httpStatusCode: 500,
        responseBody: {
          'application/json': {
            body: JSON.stringify({
              error: error.message,
              stack: error.stack
            })
          }
        }
      }
    };
  }
};
