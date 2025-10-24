// Router Lambda for Bedrock Agent action group
// Dispatches to the appropriate handler based on the action

const { handleMove } = require('./move_handler');
const recallAll = require('./recall_all');
const { acquireExperimentLock, releaseExperimentLock } = require('../shared/db');

exports.handler = async (event) => {
  console.log('Router received event:', JSON.stringify(event, null, 2));

  let experimentId;

  try {
    // Bedrock Agent event structure
    const { apiPath, requestBody, httpMethod, sessionAttributes } = event;

    // Parse Bedrock Agent request body format
    const properties = requestBody?.content?.['application/json']?.properties || [];

    // Convert properties array to object
    const params = {};
    properties.forEach(prop => {
      params[prop.name] = prop.value;
    });

    experimentId = params.experimentId;
    const { reasoning } = params;

    // Extract turnNumber from session attributes (passed via invoke-agent.js)
    const turnNumber = sessionAttributes?.turnNumber ? parseInt(sessionAttributes.turnNumber) : null;

    // CRITICAL: Acquire experiment-level lock before reading position
    // This prevents race conditions when Bedrock Agent makes concurrent tool calls
    // Only one action can execute per experiment at a time, but different experiments
    // can process actions in parallel.
    await acquireExperimentLock(experimentId);
    console.log(`Acquired lock for experiment ${experimentId}`);

    // Route based on API path
    let result;
    switch (apiPath) {
      case '/move_north':
        result = await handleMove('north', { experimentId, reasoning, turnNumber });
        break;

      case '/move_south':
        result = await handleMove('south', { experimentId, reasoning, turnNumber });
        break;

      case '/move_east':
        result = await handleMove('east', { experimentId, reasoning, turnNumber });
        break;

      case '/move_west':
        result = await handleMove('west', { experimentId, reasoning, turnNumber });
        break;

      case '/recall_all':
        result = await recallAll.handler({ experimentId, reasoning, turnNumber });
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
  } finally {
    // CRITICAL: Always release the lock, even if an error occurred
    // Advisory locks are released automatically when connection closes, but explicit
    // release is better practice and allows connection reuse
    if (experimentId) {
      try {
        await releaseExperimentLock(experimentId);
        console.log(`Released lock for experiment ${experimentId}`);
      } catch (unlockError) {
        console.error(`Failed to release lock for experiment ${experimentId}:`, unlockError);
        // Don't throw - lock will be released when connection closes
      }
    }
  }
};
