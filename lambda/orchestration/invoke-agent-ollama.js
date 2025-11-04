// Invoke Agent Lambda - Ollama Edition with Function Calling
// Uses Ollama's native function calling to match Bedrock Agent behavior
//
// How it works:
// 1. Receives current experiment state (position, experiment ID, etc.) from check-progress
// 2. Constructs initial prompt with current position and goal (includes exploration history)
// 3. Calls Ollama with function/tool definitions (same as Bedrock Agent)
// 4. Ollama returns tool calls in structured format (not text parsing!)
// 5. Executes each tool via action router Lambda
// 6. Feeds tool results back to Ollama with vision data
// 7. Repeats until Ollama stops calling tools or max_actions_per_turn reached
//
// This matches Bedrock Agent's orchestration loop for A/B testing

const https = require('https');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { getOllamaTools } = require('../shared/tools');
const db = require('../shared/db');

const ssmClient = new SSMClient();
const lambdaClient = new LambdaClient();

// Cache prompts to avoid repeated SSM calls
// Note: Model options are fetched from event config (not Parameter Store)
// to ensure atomic, race-condition-free configuration
// Force Lambda update: 2025-10-28 IAM permission propagation
const promptCache = {};

async function getPrompt(promptVersion) {
  if (promptCache[promptVersion]) {
    return promptCache[promptVersion];
  }

  const command = new GetParameterCommand({
    Name: `/oriole/prompts/${promptVersion}`
  });

  const response = await ssmClient.send(command);
  promptCache[promptVersion] = response.Parameter.Value;
  return promptCache[promptVersion];
}

// REMOVED: getMaxActionsPerTurn() - now using value from model_config stored at experiment start
// This eliminates fallback to default=50 and ensures atomic configuration

/**
 * Get Ollama model options from event config
 *
 * Config MUST be passed in event - no Parameter Store fallback.
 * This ensures atomic, race-condition-free configuration.
 *
 * Configurable parameters:
 * - maxContextWindow: Total context window size in tokens (default 32768)
 * - temperature: Sampling temperature (default 0.2)
 * - maxOutputTokens: Max tokens in model output (default 2000)
 * - repeatPenalty: Repetition penalty (default 1.0 = disabled, higher = stronger penalty)
 *
 * @param {Object} eventConfig - Config from event.config (REQUIRED)
 * @throws {Error} If config not provided in event
 */
async function getOllamaOptions(eventConfig) {
  if (!eventConfig || Object.keys(eventConfig).length === 0) {
    throw new Error('Config must be provided in event. Pass config parameters when triggering experiment.');
  }

  // Validate all required config fields are present
  if (eventConfig.maxContextWindow === undefined) {
    throw new Error('maxContextWindow must be provided in config');
  }
  if (eventConfig.temperature === undefined) {
    throw new Error('temperature must be provided in config');
  }
  if (eventConfig.maxOutputTokens === undefined) {
    throw new Error('maxOutputTokens must be provided in config');
  }

  console.log('Using config from event:', eventConfig);

  const options = {
    num_ctx: eventConfig.maxContextWindow,
    temperature: eventConfig.temperature,
    num_predict: eventConfig.maxOutputTokens
  };

  // Add repeat_penalty if specified (optional, defaults to Ollama's default 1.1 if not set)
  // Use 1.0 to disable repetition filtering for pure model behavior
  if (eventConfig.repeatPenalty !== undefined) {
    options.repeat_penalty = eventConfig.repeatPenalty;
  }

  return options;
}

async function getOllamaEndpoint() {
  const command = new GetParameterCommand({
    Name: '/oriole/ollama/endpoint'
  });
  const response = await ssmClient.send(command);
  const baseEndpoint = response.Parameter.Value;

  // Append GPU prefix for multi-GPU routing
  // GPU1 = RTX 4080 (Windows), GPU2 = M4 Pro
  // Using GPU2 (M4 Pro) for faster inference
  return `${baseEndpoint}/gpu2`;
}

async function getOllamaApiKey() {
  const command = new GetParameterCommand({
    Name: '/oriole/ollama/api-key',
    WithDecryption: true  // Required for SecureString parameters
  });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

async function getOllamaRequestTimeout() {
  // FAIL FAST: Request timeout is critical for slow models - don't fallback to default
  try {
    const command = new GetParameterCommand({
      Name: '/oriole/ollama/request-timeout-ms'
    });
    const response = await ssmClient.send(command);
    return parseInt(response.Parameter.Value, 10);
  } catch (error) {
    throw new Error(`Failed to load required parameter /oriole/ollama/request-timeout-ms: ${error.message}`);
  }
}

async function getSystemPromptHistoryActions() {
  // FAIL FAST: History action count is critical for context management
  try {
    const command = new GetParameterCommand({
      Name: '/oriole/experiments/system-prompt-history-actions'
    });
    const response = await ssmClient.send(command);
    return parseInt(response.Parameter.Value, 10);
  } catch (error) {
    throw new Error(`Failed to load required parameter /oriole/experiments/system-prompt-history-actions: ${error.message}`);
  }
}

/**
 * Fetch exploration history for system prompt
 *
 * Returns chronological path with vision data from last N actions.
 * This replaces recall tools by providing guaranteed spatial memory in system prompt.
 *
 * @param {number} experimentId - Experiment ID to fetch history for
 * @param {number} limit - Number of past actions to include
 * @returns {Promise<string>} Formatted exploration history
 */
async function getExplorationHistory(experimentId, limit) {
  const dbClient = await db.getDbClient();

  // Fetch last N actions with position and vision data
  const result = await dbClient.query(
    `SELECT
       action_type,
       from_x,
       from_y,
       to_x,
       to_y,
       tiles_seen,
       success
     FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number DESC
     LIMIT $2`,
    [experimentId, limit]
  );

  if (!result.rows || result.rows.length === 0) {
    return null; // No history yet (first turn)
  }

  // Reverse to show chronological order (oldest first)
  const actions = result.rows.reverse();

  // Format as path with vision
  const historyLines = actions.map(action => {
    const position = action.success
      ? `(${action.to_x}, ${action.to_y})`  // Where we ended up
      : `(${action.from_x}, ${action.from_y})`;  // Stayed at same position (failed move)

    // Parse tiles_seen JSON
    let visionText = 'No vision data';
    if (action.tiles_seen) {
      try {
        const tiles = typeof action.tiles_seen === 'string'
          ? JSON.parse(action.tiles_seen)
          : action.tiles_seen;

        // Format tiles as "Saw wall at (2,1), empty at (3,2), GOAL at (5,5)"
        const tileDescriptions = tiles.map(t => {
          const tileType = t.type === 'goal' ? 'GOAL' : t.type;
          return `${tileType} at (${t.x},${t.y})`;
        });

        visionText = tileDescriptions.length > 0
          ? `Saw ${tileDescriptions.join(', ')}`
          : 'No tiles visible';
      } catch (e) {
        visionText = 'Vision data parse error';
      }
    }

    const moveResult = action.success ? '✓' : '✗';
    return `${moveResult} ${action.action_type} → ${position}: ${visionText}`;
  });

  return historyLines.join('\n');
}

/**
 * Call Ollama chat API with function calling support
 *
 * Uses /api/chat endpoint (not /api/generate) for conversational tool calling
 * Ollama supports OpenAI-compatible function calling format
 *
 * @param {string} endpoint - Ollama HTTPS endpoint
 * @param {string} model - Model name (e.g., "llama3.2:latest")
 * @param {Array} messages - Conversation history with tool results
 * @param {string} apiKey - API key for auth proxy
 * @param {Array} tools - Tool definitions in OpenAI format
 * @param {Object} options - Model options (temperature, num_ctx, etc.)
 * @param {number} timeoutMs - Request timeout in milliseconds
 * @returns {Promise} Ollama response with potential tool_calls
 */
async function callOllamaChat(endpoint, model, messages, apiKey, tools, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${endpoint}/api/chat`);
    const postData = JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      options: options
    });

    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'X-API-Key': apiKey
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          // Check HTTP status code - non-200 responses indicate errors
          if (res.statusCode !== 200) {
            const errorMsg = parsed.error || `HTTP ${res.statusCode}`;
            reject(new Error(`Ollama/proxy error (${res.statusCode}): ${errorMsg}`));
            return;
          }

          // Check for error responses in the body (200 OK but error field present)
          // This catches authentication errors, model not found, etc.
          if (parsed.error) {
            reject(new Error(`Ollama/proxy error: ${parsed.error}`));
            return;
          }

          resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse Ollama response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs);
    req.write(postData);
    req.end();
  });
}

/**
 * Execute action via Lambda invocation
 *
 * Ollama doesn't have native action tools like Bedrock Agents, so we:
 * 1. Receive structured tool calls from Ollama (function name + arguments)
 * 2. Invoke action_router Lambda for each tool call
 * 3. Return result with vision data
 *
 * IMPORTANT: Must format request in Bedrock Agent format even though router is called directly.
 * This ensures router.js can parse properties array without modification.
 *
 * Bedrock Agent format:
 *   requestBody.content['application/json'].properties = [
 *     {name: 'experimentId', type: 'integer', value: 123},
 *     {name: 'turnNumber', type: 'integer', value: 1}
 *   ]
 */
async function executeAction(action, args, experimentId, turnNumber, stepNumber, assistantMessage = null) {
  const command = new InvokeCommand({
    FunctionName: process.env.ACTION_ROUTER_FUNCTION_NAME,
    Payload: JSON.stringify({
      actionGroup: 'maze-actions',
      apiPath: `/${action}`,
      httpMethod: 'POST',
      requestBody: {
        content: {
          'application/json': {
            properties: [
              { name: 'experimentId', type: 'integer', value: experimentId },
              { name: 'reasoning', type: 'string', value: args.reasoning || '' },
              { name: 'depth', type: 'integer', value: args.depth || null },
              { name: 'turnNumber', type: 'integer', value: turnNumber },
              { name: 'stepNumber', type: 'integer', value: stepNumber },
              { name: 'assistantMessage', type: 'string', value: assistantMessage || '' }
            ]
          }
        }
      },
      sessionAttributes: {
        experimentId: experimentId.toString(),
        turnNumber: turnNumber.toString()
      }
    })
  });

  const response = await lambdaClient.send(command);
  const payload = JSON.parse(new TextDecoder().decode(response.Payload));

  // Parse the Bedrock Agent response format to extract the actual result
  // FAIL FAST: Don't return empty object if action router failed - agent needs to know about failures
  if (!payload.response?.responseBody?.['application/json']?.body) {
    throw new Error(`Invalid action router response for ${actionType}: missing response.responseBody['application/json'].body. Full payload: ${JSON.stringify(payload)}`);
  }

  const result = typeof payload.response.responseBody['application/json'].body === 'string'
    ? JSON.parse(payload.response.responseBody['application/json'].body)
    : payload.response.responseBody['application/json'].body;

  return result;
}

exports.handler = async (event) => {
  console.log('Invoke agent (Ollama) event:', JSON.stringify(event, null, 2));

  try {
    const {
      experimentId,
      currentX: startX,
      currentY: startY,
      goalDescription,
      promptVersion = 'v1',
      modelName = 'llama3.2:latest',
      turnNumber = 1,
      config = null  // Optional config passed in event
    } = event;

    console.log(`Ollama invocation for experiment ${experimentId} at position (${startX}, ${startY}) using prompt ${promptVersion}`);

    // Get the prompt text for this version
    const promptText = await getPrompt(promptVersion);

    // Fetch exploration history for system prompt (replaces recall tools)
    const historyLimit = await getSystemPromptHistoryActions();
    const explorationHistory = await getExplorationHistory(experimentId, historyLimit);
    console.log(`Including exploration history: ${explorationHistory ? 'yes' : 'no'} (limit: ${historyLimit} actions)`);

    // Track current position throughout turn (updates after each action)
    let currentX = startX;
    let currentY = startY;

    // Construct the initial system message with exploration history
    let systemMessage = `You are continuing a grid exploration experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

${promptText}`;

    // Add exploration history if available
    if (explorationHistory) {
      systemMessage += `

YOUR EXPLORATION HISTORY (last ${historyLimit} actions):
${explorationHistory}

Use this history to avoid repeating failed moves and to build a mental map of the space. You can see where you've been and what you saw at each position.`;
    }

    systemMessage += `

Use the provided tools to navigate and explore. You will receive vision feedback after each move showing what you can see from your new position.`;

    // Get Ollama endpoint, API key, model options, and request timeout
    const endpoint = await getOllamaEndpoint();
    const apiKey = await getOllamaApiKey();
    const modelOptions = await getOllamaOptions(config);  // Pass config from event
    const requestTimeoutMs = await getOllamaRequestTimeout();
    console.log(`Ollama endpoint: ${endpoint}`);
    console.log(`Model options:`, modelOptions);
    console.log(`Request timeout: ${requestTimeoutMs}ms`);

    // Get tools from shared definitions (same as Bedrock Agent)
    const tools = getOllamaTools();
    console.log(`Loaded ${tools.length} tools from shared definitions`);

    // Initialize conversation with system message
    const messages = [
      {
        role: 'user',
        content: systemMessage
      }
    ];

    let actionCount = 0;

    // Get max actions from experiment config stored in database (atomic configuration)
    // Previously fetched from Parameter Store with fallback to 50 - now stored at experiment start
    // FAIL FAST: Don't fall back to defaults - use the config that was validated and stored
    const dbClient = await db.getDbClient();
    const configResult = await dbClient.query(
      'SELECT model_config FROM experiments WHERE id = $1',
      [experimentId]
    );

    if (!configResult.rows || configResult.rows.length === 0 || !configResult.rows[0].model_config) {
      throw new Error(`Missing model_config for experiment ${experimentId} - all experiments must have explicit config`);
    }

    const storedConfig = configResult.rows[0].model_config;
    if (storedConfig.max_actions_per_turn === undefined || storedConfig.max_actions_per_turn === null) {
      throw new Error(`Missing max_actions_per_turn in model_config for experiment ${experimentId}`);
    }

    const maxActions = storedConfig.max_actions_per_turn === 0 ? Infinity : storedConfig.max_actions_per_turn;
    console.log(`Max actions per turn: ${storedConfig.max_actions_per_turn === 0 ? 'unlimited' : storedConfig.max_actions_per_turn}`);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let goalFound = false;
    let lastOllamaMetrics = null; // Track last call's performance metrics

    console.log(`\n[TURN ${turnNumber}] Starting Ollama orchestration loop (max ${maxActions === Infinity ? 'unlimited' : maxActions} actions)`);

    // Orchestration loop - mirrors Bedrock Agent's behavior
    // Continue calling Ollama until it stops requesting tools or max actions reached
    while (actionCount < maxActions) {
      console.log(`\n[ACTION ${actionCount + 1}${maxActions === Infinity ? '' : `/${maxActions}`}] Calling Ollama...`);
      const startTime = Date.now();

      // Call Ollama with conversation history and available tools
      const response = await callOllamaChat(endpoint, modelName, messages, apiKey, tools, modelOptions, requestTimeoutMs);

      const elapsed = Date.now() - startTime;
      console.log(`[TIMING] Ollama call completed in ${elapsed}ms`);

      // Track token usage
      // Vision/multimodal models (llava, phi4, etc.) may not return token counts in text-only mode
      // Log warnings for missing token counts but don't fail experiments
      // Ollama may occasionally not return token counts during context overflow, model swapping, etc.
      // Better to record the reasoning/actions and continue than to fail the entire experiment
      if (response.prompt_eval_count === undefined || response.prompt_eval_count === null) {
        console.warn(`WARNING: Missing prompt_eval_count in Ollama response for model ${modelName} on turn ${turnNumber} - defaulting to 0`);
      }
      if (response.eval_count === undefined || response.eval_count === null) {
        console.warn(`WARNING: Missing eval_count in Ollama response for model ${modelName} on turn ${turnNumber} - defaulting to 0`);
      }

      // Add token counts if available (may be undefined for vision models)
      const promptTokens = response.prompt_eval_count || 0;
      const outputTokens = response.eval_count || 0;
      totalInputTokens += promptTokens;
      totalOutputTokens += outputTokens;
      console.log(`Token usage: ${promptTokens} in, ${outputTokens} out`);

      // Extract Ollama performance metrics (timing data in nanoseconds)
      // Store the last call's metrics to update the turn after actions complete
      const ollamaMetrics = {
        inferenceDurationMs: response.total_duration ? Math.round(response.total_duration / 1e6) : null,
        promptEvalDurationMs: response.prompt_eval_duration ? Math.round(response.prompt_eval_duration / 1e6) : null,
        evalDurationMs: response.eval_duration ? Math.round(response.eval_duration / 1e6) : null,
        tokensPerSecond: (response.eval_duration && response.eval_count)
          ? Math.round((response.eval_count / (response.eval_duration / 1e9)) * 100) / 100
          : null,
        doneReason: response.done_reason || null
      };
      lastOllamaMetrics = ollamaMetrics; // Save for turn-level update
      console.log(`Performance: ${ollamaMetrics.inferenceDurationMs}ms total, ${ollamaMetrics.tokensPerSecond} tok/s`);

      // Add assistant's message to conversation history
      const assistantMessage = response.message;

      // Check if response is valid
      if (!assistantMessage) {
        console.error('Invalid response from Ollama - no message field');
        console.error('Full response:', JSON.stringify(response, null, 2));
        throw new Error(`Ollama returned invalid response for model ${modelName} - no message field. This model may not support function calling.`);
      }

      messages.push(assistantMessage);

      // Check if Ollama wants to call any tools
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        console.log('No tool calls requested - ending turn');
        console.log('Assistant response:', assistantMessage.content);

        // Record no-op turn in database for tracking model reliability
        const dbClient = await db.getDbClient();
        const noOpStepNumber = await db.getNextStepNumber(experimentId);
        await dbClient.query(
          `INSERT INTO agent_actions (
            experiment_id, turn_number, step_number, action_type,
            from_x, from_y, to_x, to_y, success,
            input_tokens, output_tokens, assistant_message, timestamp
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
          [
            experimentId,
            turnNumber,
            noOpStepNumber, // Get next step number from database (not turn-local count)
            'no_tool_call',
            currentX,
            currentY,
            currentX,
            currentY,
            false, // success = false for no-op
            response.prompt_eval_count,
            response.eval_count,
            assistantMessage.content || null // Full LLM response for no-op turns
          ]
        );
        console.log('Recorded no-op turn in database');

        break;
      }

      console.log(`Ollama requested ${assistantMessage.tool_calls.length} tool call(s)`);

      // Execute each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        if (actionCount >= maxActions) {
          console.log(`Reached max actions (${maxActions}), stopping`);
          break;
        }

        actionCount++;
        const toolName = toolCall.function.name;
        // Ollama may return arguments as object or string, handle both
        const toolArgs = typeof toolCall.function.arguments === 'string'
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;

        console.log(`  [${actionCount}] Executing: ${toolName}(${JSON.stringify(toolArgs)})`);

        // Execute the action
        const result = await executeAction(
          toolName,
          toolArgs,
          experimentId,
          turnNumber,
          actionCount,
          assistantMessage.content || null // Pass full LLM response for logging
        );

        console.log(`    Result: ${result.success ? '✅' : '❌'} ${result.message || 'Unknown'}`);
        if (result.visible) {
          console.log(`    Vision: ${result.visible.substring(0, 100)}...`);
        }

        // Update current position after action (critical for multi-action turns)
        // Prevents teleportation bug when logging no_tool_call actions
        if (result.position) {
          currentX = result.position.x;
          currentY = result.position.y;
          console.log(`    Position updated to (${currentX}, ${currentY})`);
        }

        // Check if goal found
        if (result.foundGoal) {
          goalFound = true;
          console.log('    🎯 GOAL FOUND!');
        }

        // Add tool result to conversation
        // This is critical - Ollama sees the result including vision data
        messages.push({
          role: 'tool',
          content: JSON.stringify(result)
        });

        // Stop if goal found
        if (goalFound) {
          console.log('Goal found, ending turn');
          break;
        }
      }

      // Stop if goal found
      if (goalFound) {
        break;
      }

      // Continue loop - Ollama will see tool results and can decide to call more tools
    }

    console.log(`\n[TURN ${turnNumber}] Complete: ${actionCount} actions executed`);
    console.log(`Total tokens: ${totalInputTokens} in, ${totalOutputTokens} out`);

    // Update all actions in this turn with Ollama performance metrics
    if (lastOllamaMetrics && actionCount > 0) {
      await db.updateTurnMetrics(experimentId, turnNumber, lastOllamaMetrics);
      console.log(`Performance metrics updated for ${actionCount} actions in turn ${turnNumber}`);
    }

    return {
      experimentId,
      agentResponse: messages[messages.length - 1]?.content || 'Turn complete',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cost: 0 // Local = free!
    };

  } catch (error) {
    console.error('Error invoking Ollama agent:', error);

    // Fail fast - throw error to fail the Step Functions execution
    // No retries, no swallowing errors - if Ollama fails, the experiment fails
    throw error;
  }
};
