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
      actionLambda,
      promptOverrideConfiguration
    } = props;

    // IAM role for Bedrock Agent
    // Complex setup to support both legacy models and inference profiles (Nova)
    // Based on working implementation from cardinal codebase
    const isInferenceProfile = modelId.startsWith('us.') || modelId.startsWith('eu.') || modelId.startsWith('ap.');

    const bedrockResources = [];

    if (isInferenceProfile) {
      // Inference Profile Resources:
      // Nova models use inference profiles for load balancing and cross-region routing
      // Inference profiles are account-specific resources that route to foundation models
      // Format: arn:aws:bedrock:region:account:inference-profile/profile-id
      bedrockResources.push(`arn:aws:bedrock:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:inference-profile/${modelId}`);

      // Foundation Model Resources:
      // For Nova models, strip the region prefix (us.amazon. → amazon.)
      // Example: 'us.amazon.nova-micro-v1:0' becomes 'amazon.nova-micro-v1:0'
      const foundationModelId = modelId.replace('us.amazon.', 'amazon.')
                                       .replace('eu.amazon.', 'amazon.')
                                       .replace('ap.amazon.', 'amazon.');

      // Local region foundation model access
      bedrockResources.push(`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/${foundationModelId}`);

      // Cross-Region Foundation Model Access:
      // When using inference profiles, Bedrock SDK automatically routes requests to
      // available foundation models across multiple regions for load balancing.
      // Without these permissions, requests fail with AccessDeniedException.
      bedrockResources.push(`arn:aws:bedrock:us-east-1::foundation-model/${foundationModelId}`);
      bedrockResources.push(`arn:aws:bedrock:us-east-2::foundation-model/${foundationModelId}`);
      bedrockResources.push(`arn:aws:bedrock:us-west-1::foundation-model/${foundationModelId}`);
      bedrockResources.push(`arn:aws:bedrock:us-west-2::foundation-model/${foundationModelId}`);
    } else {
      // Legacy foundation models (direct model IDs)
      bedrockResources.push(`arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/${modelId}`);
    }

    const agentRole = new iam.Role(this, 'BedrockAgentRole', {
      roleName: `${agentName}-role`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        BedrockModelPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              resources: bedrockResources
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
    const agentProps = {
      agentName: agentName,
      agentResourceRoleArn: agentRole.roleArn,
      foundationModel: modelId,
      instruction: instruction,
      idleSessionTtlInSeconds: 600,
      description: `Oriole maze navigation agent using ${modelId}`
    };

    // Add prompt override configuration if provided
    if (promptOverrideConfiguration) {
      agentProps.promptOverrideConfiguration = promptOverrideConfiguration;
    }

    const agent = new bedrock.CfnAgent(this, 'Agent', agentProps);

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
