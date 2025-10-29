// Invoke Agent Lambda - Ollama Edition with Function Calling
// Uses Ollama's native function calling to match Bedrock Agent behavior
//
// How it works:
// 1. Receives current experiment state (position, experiment ID, etc.) from check-progress
// 2. Constructs initial prompt with current position and goal
// 3. Calls Ollama with function/tool definitions (same as Bedrock Agent)
// 4. Ollama returns tool calls in structured format (not text parsing!)
// 5. Executes each tool via action router Lambda
// 6. Feeds tool results back to Ollama with vision data
// 7. Repeats until Ollama stops calling tools or max 8 actions reached
//
// This matches Bedrock Agent's orchestration loop for A/B testing

const https = require('https');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { getOllamaTools } = require('../shared/tools');

const ssmClient = new SSMClient();
const lambdaClient = new LambdaClient();

// Cache prompts to avoid repeated SSM calls
// Note: Model options are fetched from event config (not Parameter Store)
// to ensure atomic, race-condition-free configuration
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
 * - repeatPenalty: Repetition penalty (default 1.4)
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
  if (eventConfig.repeatPenalty === undefined) {
    throw new Error('repeatPenalty must be provided in config');
  }

  console.log('Using config from event:', eventConfig);
  return {
    num_ctx: eventConfig.maxContextWindow,
    temperature: eventConfig.temperature,
    num_predict: eventConfig.maxOutputTokens,
    repeat_penalty: eventConfig.repeatPenalty
  };
}

async function getOllamaEndpoint() {
  const command = new GetParameterCommand({
    Name: '/oriole/ollama/endpoint'
  });
  const response = await ssmClient.send(command);
  return response.Parameter.Value;
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
          resolve(JSON.parse(data));
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
async function executeAction(action, args, experimentId, turnNumber, stepNumber) {
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
              { name: 'turnNumber', type: 'integer', value: turnNumber },
              { name: 'stepNumber', type: 'integer', value: stepNumber }
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
      currentX,
      currentY,
      goalDescription,
      promptVersion = 'v1',
      modelName = 'llama3.2:latest',
      turnNumber = 1,
      config = null  // Optional config passed in event
    } = event;

    console.log(`Ollama invocation for experiment ${experimentId} at position (${currentX}, ${currentY}) using prompt ${promptVersion}`);

    // Get the prompt text for this version
    const promptText = await getPrompt(promptVersion);

    // Construct the initial system message
    const systemMessage = `You are continuing a grid exploration experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

${promptText}

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
    const db = await getDbClient();
    const configResult = await db.query(
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
      // FAIL FAST: Token counts are critical for cost tracking and experiment analysis
      if (response.prompt_eval_count === undefined || response.prompt_eval_count === null) {
        throw new Error(`Missing prompt_eval_count in Ollama response for model ${modelName}`);
      }
      if (response.eval_count === undefined || response.eval_count === null) {
        throw new Error(`Missing eval_count in Ollama response for model ${modelName}`);
      }

      totalInputTokens += response.prompt_eval_count;
      totalOutputTokens += response.eval_count;
      console.log(`Token usage: ${response.prompt_eval_count} in, ${response.eval_count} out`);

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
          actionCount
        );

        console.log(`    Result: ${result.success ? '✅' : '❌'} ${result.message || 'Unknown'}`);
        if (result.visible) {
          console.log(`    Vision: ${result.visible.substring(0, 100)}...`);
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
