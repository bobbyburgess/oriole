/**
 * Router Lambda for Bedrock Agent Action Group
 *
 * PURPOSE:
 *   Central dispatcher for all maze action requests
 *   Routes to appropriate handler based on API path
 *   Enforces experiment-level locking to prevent race conditions
 *
 * BEDROCK AGENT REQUEST FORMAT:
 *   All action handlers expect and must return Bedrock Agent format.
 *   This format is used even when called from invoke-agent-ollama.js (non-Bedrock flow).
 *
 *   Input format (from agent):
 *   {
 *     apiPath: '/move_north',
 *     httpMethod: 'POST',
 *     requestBody: {
 *       content: {
 *         'application/json': {
 *           properties: [
 *             { name: 'experimentId', type: 'integer', value: 123 },
 *             { name: 'turnNumber', type: 'integer', value: 1 }
 *           ]
 *         }
 *       }
 *     },
 *     sessionAttributes: {...}
 *   }
 *
 *   Output format (from handler):
 *   {
 *     messageVersion: '1.0',
 *     response: {
 *       actionGroup: 'maze-actions',
 *       apiPath: '/move_north',
 *       httpMethod: 'POST',
 *       httpStatusCode: 200,
 *       responseBody: {
 *         'application/json': {
 *           body: JSON.stringify({success: true, position: {x: 3, y: 2}, ...})
 *         }
 *       }
 *     }
 *   }
 *
 * RACE CONDITION PREVENTION:
 *   Bedrock Agent can orchestrate multiple tool calls in ONE invocation.
 *   Example: Agent calls move_north AND move_east in one response.
 *
 *   Without locking:
 *     Thread 1: Read position (2,2) -> move north -> write (2,1)
 *     Thread 2: Read position (2,2) -> move east -> write (3,2)
 *     Result: (3,2) instead of (3,1) [lost the north movement!]
 *
 *   Solution: PostgreSQL Advisory Lock
 *     - Acquire lock at start of router (wrapper for all actions)
 *     - Prevents concurrent reads of stale position
 *     - Lock held for entire action execution
 *     - Released in finally block
 *
 *   Per-experiment locking:
 *     - Lock ID = experimentId
 *     - Different experiments can run in parallel
 *     - Same experiment blocks concurrent actions
 */

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
    // Bedrock sends parameters in specific format: properties array
    // Each property has {name, type, value} structure
    // Example: [{name: 'experimentId', type: 'integer', value: 123}]
    const properties = requestBody?.content?.['application/json']?.properties || [];

    // Convert properties array to simple key-value object
    // This decoupling allows handlers to work with simple objects, not Bedrock format
    // Example: {experimentId: 123, turnNumber: 1}
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
