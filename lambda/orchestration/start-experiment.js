// Start Experiment Lambda
// First step in the Step Functions workflow
//
// Responsibilities:
// 1. Create experiment record in database with metadata (agent, model, maze, prompt)
// 2. Initialize experiment state (started_at, positions)
// 3. Return all fields needed by subsequent steps (currentX, currentY, turnNumber, etc.)
//
// What gets passed forward to Step Functions:
// - experimentId: Database ID for this run
// - agentId/agentAliasId: Bedrock Agent identifiers
// - modelName: For pricing and rate limit lookups
// - currentX/currentY: Starting position (critical for stateless orchestration)
// - turnNumber: Initialized to 1, incremented by check-progress

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { getCurrentPosition } = require('../shared/db');

let dbClient = null;
let cachedDbPassword = null;
const ssmClient = new SSMClient();

async function getDbPassword() {
  if (cachedDbPassword) {
    return cachedDbPassword;
  }

  const command = new GetParameterCommand({
    Name: '/oriole/db/password',
    WithDecryption: true
  });

  const response = await ssmClient.send(command);
  cachedDbPassword = response.Parameter.Value;
  return cachedDbPassword;
}

async function getDbClient() {
  if (dbClient) {
    return dbClient;
  }

  const password = await getDbPassword();

  dbClient = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: password,
    ssl: {
      rejectUnauthorized: false
    }
  });

  await dbClient.connect();
  return dbClient;
}

async function getPrompt(promptVersion) {
  const command = new GetParameterCommand({
    Name: `/oriole/prompts/${promptVersion}`
  });

  const response = await ssmClient.send(command);
  return response.Parameter.Value;
}

exports.handler = async (event) => {
  console.log('Start experiment event:', JSON.stringify(event, null, 2));

  try {
    // Extract detail from EventBridge event structure
    const payload = event.detail || event;

    /**
     * LLM PROVIDER ROUTING
     *
     * The llmProvider field is set at experiment start and passed through the entire state machine.
     * This enables the SAME workflow to invoke either:
     *   - AWS Bedrock Agent (invoke-agent.js): Full agent orchestration with tool calling
     *   - Local Ollama (invoke-agent-ollama.js): Raw LLM output parsed for actions
     *
     * Flow: llmProvider='bedrock' -> Step Functions Choice -> InvokeBedrockAgent
     *                  'ollama'   -> Step Functions Choice -> InvokeOllamaAgent
     *
     * Default: 'bedrock' (for backwards compatibility if field is missing)
     *
     * Selected by:
     *   - Agent ID = "OLLAMA" in trigger script -> sets llmProvider='ollama'
     *   - Normal agent ID -> sets llmProvider='bedrock'
     *
     * Each path has different:
     *   - Handler Lambda (different logic, different response format)
     *   - Timeout (Ollama faster since local)
     *   - Token tracking (Ollama uses prompt_eval_count/eval_count vs inputTokens/outputTokens)
     *   - Action execution (Bedrock = orchestrated by AWS, Ollama = sequential via invoke)
     */
    const {
      agentId,
      agentAliasId,
      modelName,
      promptVersion = 'v1',
      mazeId,
      resumeFromExperimentId,
      llmProvider = 'bedrock',  // Default to bedrock for backwards compatibility
      config  // Ollama config passed in event (atomic!)
    } = payload;

    let { startX = 2, startY = 2 } = payload;

    // Validate required parameters
    if (!agentId || !agentAliasId || !modelName || !mazeId) {
      throw new Error('Missing required parameters: agentId, agentAliasId, modelName, mazeId');
    }

    // Handle resume logic: override start position with last known position from failed experiment
    if (resumeFromExperimentId) {
      console.log(`Resuming from experiment ${resumeFromExperimentId}`);
      const resumePosition = await getCurrentPosition(resumeFromExperimentId);
      startX = resumePosition.x;
      startY = resumePosition.y;
      console.log(`Resume position: (${startX}, ${startY})`);
    }

    // Note: prompt text is fetched at runtime in invoke-agent, not stored in DB

    /**
     * Capture model configuration for reproducibility and A/B testing
     *
     * Config is REQUIRED for ALL experiments (Ollama AND Bedrock) to ensure:
     * - Explicit configuration (no hidden defaults)
     * - Historical comparison (e.g., before/after context window increase)
     * - A/B testing (e.g., temperature 0.2 vs 0.7)
     * - Reproducibility (know exact config that produced results)
     *
     * For Bedrock experiments, config is stored but may not affect behavior
     * (AWS manages some settings internally), but we require it for consistency.
     */
    if (!config || Object.keys(config).length === 0) {
      throw new Error('Config must be provided in event for ALL experiments. Pass config parameters when triggering experiment.');
    }

    let modelConfig = null;
    if (llmProvider === 'ollama') {

      console.log('Using Ollama config from event:', config);

      // Fetch non-model params from Parameter Store (these don't change per-experiment)
      // FAIL FAST: If any parameter is missing, experiment should fail immediately
      // rather than storing null values that cause undefined behavior later
      let recallInterval, maxMoves, maxDurationMinutes, maxActionsPerTurn, visionRange;
      try {
        [recallInterval, maxMoves, maxDurationMinutes, maxActionsPerTurn, visionRange] = await Promise.all([
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/experiments/recall-interval' }))
            .then(r => parseInt(r.Parameter.Value)),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/max-moves' }))
            .then(r => parseInt(r.Parameter.Value)),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/max-duration-minutes' }))
            .then(r => parseInt(r.Parameter.Value)),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/ollama/max-actions-per-turn' }))
            .then(r => parseInt(r.Parameter.Value)),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/gameplay/vision-range' }))
            .then(r => parseInt(r.Parameter.Value))
        ]);
      } catch (error) {
        throw new Error(`Failed to load required Parameter Store configuration: ${error.message}`);
      }

      // Validate all required config fields are present
      if (config.maxContextWindow === undefined) {
        throw new Error('maxContextWindow must be provided in config for Ollama experiments');
      }
      if (config.temperature === undefined) {
        throw new Error('temperature must be provided in config for Ollama experiments');
      }
      if (config.maxOutputTokens === undefined) {
        throw new Error('maxOutputTokens must be provided in config for Ollama experiments');
      }

      modelConfig = {
        // Model-specific config from event (varies per experiment)
        num_ctx: config.maxContextWindow,
        temperature: config.temperature,
        num_predict: config.maxOutputTokens,
        // System config from Parameter Store (stable across experiments)
        recall_interval: recallInterval,
        max_moves: maxMoves,
        max_duration_minutes: maxDurationMinutes,
        max_actions_per_turn: maxActionsPerTurn,
        vision_range: visionRange
      };
      console.log('Ollama model config captured:', modelConfig);
    } else {
      // Bedrock experiments: Store config for tracking but it won't affect AWS-managed settings
      // Validate all required config fields are present
      if (config.maxContextWindow === undefined) {
        throw new Error('maxContextWindow must be provided in config for all experiments');
      }
      if (config.temperature === undefined) {
        throw new Error('temperature must be provided in config for all experiments');
      }
      if (config.maxOutputTokens === undefined) {
        throw new Error('maxOutputTokens must be provided in config for all experiments');
      }

      modelConfig = {
        num_ctx: config.maxContextWindow,
        temperature: config.temperature,
        num_predict: config.maxOutputTokens
      };
      console.log('Bedrock model config captured (for tracking only):', modelConfig);
    }

    /**
     * Smart Cooldown: Only delay when switching models AND insufficient time has passed
     *
     * Purpose: Ollama loads one model at a time into GPU memory. When switching models,
     * Ollama needs time to unload the previous model and load the new one. Without cooldown,
     * rapid model switches can cause resource contention.
     *
     * Traditional approach: Wait cooldown-seconds after EVERY experiment
     * Problem: Wastes time when running batches of the same model (no model switch)
     *
     * Smart approach: Only wait when:
     * 1. Model changed from previous experiment (model switch detected)
     * 2. Not enough time has elapsed since last completion (still "warm")
     *
     * Examples:
     * - qwen → qwen (5s later): No cooldown (same model)
     * - qwen → llama (5s later): Cooldown needed (model switch, still warm)
     * - qwen → llama (60s later): No cooldown (model switch, but already cool)
     * - First experiment: No cooldown (no previous experiment)
     *
     * Configuration: /oriole/experiments/cooldown-seconds (default: 10)
     */
    const db = await getDbClient();
    let needsCooldown = false;

    try {
      // Query last completed experiment to check model name and completion time
      const lastExpResult = await db.query(
        `SELECT model_name, completed_at
         FROM experiments
         WHERE completed_at IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`
      );

      if (lastExpResult.rows.length > 0) {
        const lastExp = lastExpResult.rows[0];

        // Check if model has changed from last experiment
        if (lastExp.model_name !== modelName) {
          // Model switch detected - check if enough time has passed
          const cooldownSeconds = await ssmClient.send(
            new GetParameterCommand({ Name: '/oriole/experiments/cooldown-seconds' })
          ).then(r => parseInt(r.Parameter.Value));

          // Calculate time elapsed since last experiment completed
          const elapsedMs = Date.now() - new Date(lastExp.completed_at).getTime();
          const elapsedSeconds = elapsedMs / 1000;

          // Only need cooldown if elapsed time < required cooldown period
          needsCooldown = elapsedSeconds < cooldownSeconds;

          if (needsCooldown) {
            console.log(`Model switch detected (${lastExp.model_name} → ${modelName}). Only ${elapsedSeconds.toFixed(1)}s elapsed, need ${cooldownSeconds}s cooldown.`);
          } else {
            console.log(`Model switch detected (${lastExp.model_name} → ${modelName}), but ${elapsedSeconds.toFixed(1)}s elapsed >= ${cooldownSeconds}s cooldown. No wait needed.`);
          }
        } else {
          // Same model - no cooldown needed (model already loaded)
          console.log(`Same model as last run (${modelName}). No cooldown needed.`);
        }
      } else {
        // Clean database - no previous experiments, no cooldown needed
        console.log('No previous experiments found. No cooldown needed.');
      }
    } catch (error) {
      // If cooldown check fails, default to no cooldown (fail open, not fail closed)
      // This ensures experiments can continue even if cooldown logic has issues
      console.warn('Failed to check cooldown status, defaulting to no cooldown:', error.message);
      needsCooldown = false;
    }

    // Create experiment record
    const result = await db.query(
      `INSERT INTO experiments
       (agent_id, model_name, prompt_version, maze_id, start_x, start_y, started_at, model_config, comment)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
       RETURNING id`,
      [agentId, modelName, promptVersion, mazeId, startX, startY,
       modelConfig ? JSON.stringify(modelConfig) : null,
       payload.comment || null]
    );

    const experimentId = result.rows[0].id;

    console.log(`Created experiment ${experimentId}`);

    return {
      experimentId,
      agentId,
      agentAliasId,
      modelName,
      promptVersion,
      mazeId,
      startX,
      startY,
      currentX: startX,  // Initial position = start position
      currentY: startY,
      turnNumber: 1,  // Initialize turn counter
      llmProvider,  // Pass through to AgentProviderRouter choice state
      config,  // Pass config through for atomic configuration (no Parameter Store race conditions)
      needsCooldown  // Pass through to CooldownRouter choice state
    };

  } catch (error) {
    console.error('Error starting experiment:', error);
    throw error;
  }
};
