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
      goalDescription = 'Find the goal marker',
      resumeFromExperimentId,
      llmProvider = 'bedrock'  // Default to bedrock for backwards compatibility
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
     * For Ollama experiments, we fetch all configurable parameters from Parameter Store
     * and store them in the model_config JSONB column. This enables:
     * - Historical comparison (e.g., before/after context window increase)
     * - A/B testing (e.g., temperature 0.2 vs 0.7)
     * - Reproducibility (know exact config that produced results)
     *
     * For Bedrock experiments, model_config is NULL (agent config is managed separately)
     */
    let modelConfig = null;
    if (llmProvider === 'ollama') {
      console.log('Capturing Ollama model configuration...');
      const [numCtx, temperature, numPredict, repeatPenalty, recallInterval, maxRecallActions, maxMoves, maxDurationMinutes] =
        await Promise.all([
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/ollama/num-ctx' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/ollama/temperature' }))
            .then(r => parseFloat(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/ollama/num-predict' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/ollama/repeat-penalty' }))
            .then(r => parseFloat(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/experiments/recall-interval' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/experiments/max-recall-actions' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/max-moves' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null),
          ssmClient.send(new GetParameterCommand({ Name: '/oriole/max-duration-minutes' }))
            .then(r => parseInt(r.Parameter.Value)).catch(() => null)
        ]);

      modelConfig = {
        num_ctx: numCtx,
        temperature: temperature,
        num_predict: numPredict,
        repeat_penalty: repeatPenalty,
        recall_interval: recallInterval,
        max_recall_actions: maxRecallActions,
        max_moves: maxMoves,
        max_duration_minutes: maxDurationMinutes
      };
      console.log('Model config captured:', modelConfig);
    }

    // Create experiment record
    const db = await getDbClient();
    const result = await db.query(
      `INSERT INTO experiments
       (agent_id, model_name, prompt_version, maze_id, goal_description, start_x, start_y, started_at, model_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
       RETURNING id`,
      [agentId, modelName, promptVersion, mazeId, goalDescription, startX, startY,
       modelConfig ? JSON.stringify(modelConfig) : null]
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
      goalDescription,
      startX,
      startY,
      currentX: startX,  // Initial position = start position
      currentY: startY,
      turnNumber: 1,  // Initialize turn counter
      llmProvider  // Pass through to AgentProviderRouter choice state
    };

  } catch (error) {
    console.error('Error starting experiment:', error);
    throw error;
  }
};
