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

    const {
      agentId,
      agentAliasId,
      modelName,
      promptVersion = 'v1',
      mazeId,
      goalDescription = 'Find the goal marker',
      startX = 2,
      startY = 2
    } = payload;

    // Validate required parameters
    if (!agentId || !agentAliasId || !modelName || !mazeId) {
      throw new Error('Missing required parameters: agentId, agentAliasId, modelName, mazeId');
    }

    // Note: prompt text is fetched at runtime in invoke-agent, not stored in DB

    // Create experiment record
    const db = await getDbClient();
    const result = await db.query(
      `INSERT INTO experiments
       (agent_id, model_name, prompt_version, maze_id, goal_description, start_x, start_y, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id`,
      [agentId, modelName, promptVersion, mazeId, goalDescription, startX, startY]
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
      turnNumber: 1  // Initialize turn counter
    };

  } catch (error) {
    console.error('Error starting experiment:', error);
    throw error;
  }
};
