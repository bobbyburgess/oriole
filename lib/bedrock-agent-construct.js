// Bedrock Agent construct for Oriole maze navigation

const { Construct } = require('constructs');
const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const bedrock = require('aws-cdk-lib/aws-bedrock');

class BedrockAgentConstruct extends Construct {
  constructor(scope, id, props) {
    super(scope, id);

    const {
      agentName,
      modelId,
      instruction,
      actionLambda
    } = props;

    // IAM role for Bedrock Agent
    const agentRole = new iam.Role(this, 'BedrockAgentRole', {
      roleName: `${agentName}-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        BedrockModelPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel'],
              resources: [`arn:aws:bedrock:*::foundation-model/${modelId}`]
            })
          ]
        })
      }
    });

    // Grant Lambda invoke permissions to the agent role
    actionLambda.grantInvoke(agentRole);

    // Create Bedrock Agent
    // Note: Action groups must be added manually via AWS Console or CLI
    // See docs/BEDROCK_AGENT_SETUP.md for instructions
    const agent = new bedrock.CfnAgent(this, 'Agent', {
      agentName: agentName,
      agentResourceRoleArn: agentRole.roleArn,
      foundationModel: modelId,
      instruction: instruction,
      idleSessionTtlInSeconds: 600,
      description: `Oriole maze navigation agent using ${modelId}`
    });

    // Create Agent Alias
    const agentAlias = new bedrock.CfnAgentAlias(this, 'AgentAlias', {
      agentId: agent.attrAgentId,
      agentAliasName: 'prod',
      description: 'Production alias for maze navigation agent'
    });

    this.agent = agent;
    this.agentAlias = agentAlias;
    this.agentRole = agentRole;
  }
}

module.exports = { BedrockAgentConstruct };
