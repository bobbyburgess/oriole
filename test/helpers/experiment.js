// Test helpers for triggering experiments
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');

const eventBridgeClient = new EventBridgeClient({
  region: process.env.AWS_REGION || 'us-west-2'
});

async function triggerExperiment({ agentId, agentAliasId, modelName, mazeId, promptVersion = 'v2' }) {
  const eventDetail = {
    agentId,
    agentAliasId,
    modelName,
    promptVersion,
    mazeId,
    goalDescription: 'Find the goal marker',
    startX: 2,
    startY: 2
  };

  const command = new PutEventsCommand({
    Entries: [{
      Source: 'oriole.experiments',
      DetailType: 'RunExperiment',
      Detail: JSON.stringify(eventDetail)
    }]
  });

  await eventBridgeClient.send(command);

  // Wait for event to flow through: EventBridge → SQS → Lambda → Step Functions → DB
  // SQS polling can take a few seconds, so we wait longer than before
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Get the experiment ID from the database
  const { createDbClient } = require('./db');
  const client = await createDbClient();

  try {
    const result = await client.query(`
      SELECT id
      FROM experiments
      WHERE agent_id = $1 AND model_name = $2
      ORDER BY started_at DESC
      LIMIT 1
    `, [agentId, modelName]);

    if (result.rows.length === 0) {
      throw new Error('Failed to find created experiment in database');
    }

    return result.rows[0].id;
  } finally {
    await client.end();
  }
}

module.exports = {
  triggerExperiment
};
