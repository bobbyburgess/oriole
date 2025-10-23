// Start Experiment Lambda
// Creates a new experiment record in the database

const { Client } = require('pg');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

let dbClient = null;
const ssmClient = new SSMClient();

async function getDbClient() {
  if (dbClient) {
    return dbClient;
  }

  dbClient = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
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
    const {
      agentId,
      agentAliasId,
      modelName,
      promptVersion = 'v1',
      mazeId,
      goalDescription = 'Find the goal marker',
      startX = 2,
      startY = 2
    } = event;

    // Validate required parameters
    if (!agentId || !agentAliasId || !modelName || !mazeId) {
      throw new Error('Missing required parameters: agentId, agentAliasId, modelName, mazeId');
    }

    // Get prompt text
    const promptText = await getPrompt(promptVersion);

    // Create experiment record
    const db = await getDbClient();
    const result = await db.query(
      `INSERT INTO experiments
       (agent_id, model_name, prompt_version, prompt_text, maze_id, goal_description, start_x, start_y, status, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       RETURNING id`,
      [agentId, modelName, promptVersion, promptText, mazeId, goalDescription, startX, startY, 'running']
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
      startY
    };

  } catch (error) {
    console.error('Error starting experiment:', error);
    throw error;
  }
};
