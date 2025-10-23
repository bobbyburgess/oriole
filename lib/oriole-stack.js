const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const iam = require('aws-cdk-lib/aws-iam');
const ec2 = require('aws-cdk-lib/aws-ec2');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const authorizers = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const cognito = require('aws-cdk-lib/aws-cognito');
const ssm = require('aws-cdk-lib/aws-ssm');
const sfn = require('aws-cdk-lib/aws-stepfunctions');
const tasks = require('aws-cdk-lib/aws-stepfunctions-tasks');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const path = require('path');
const { BedrockAgentConstruct } = require('./bedrock-agent-construct');

class OrioleStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Database configuration from environment
    const dbConfig = {
      host: process.env.DB_HOST || 'continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com',
      port: process.env.DB_PORT || '5432',
      database: process.env.DB_NAME || 'oriole',
      user: process.env.DB_USER || 'oriole_user',
      password: process.env.DB_PASSWORD
    };

    // Create environment variables for Lambdas
    const dbEnvVars = {
      DB_HOST: dbConfig.host,
      DB_PORT: dbConfig.port,
      DB_NAME: dbConfig.database,
      DB_USER: dbConfig.user,
      DB_PASSWORD: dbConfig.password
    };

    // IAM role for Lambda functions
    const lambdaRole = new iam.Role(this, 'OrioleLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    // ====================
    // Action Router Lambda
    // ====================

    // Single router Lambda for all action group operations
    const actionRouterLambda = new lambda.Function(this, 'ActionRouterFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'router.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/actions')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30)
    });

    // Grant Bedrock invoke permissions to Lambda role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeAgent', 'bedrock:InvokeModel'],
      resources: ['*']
    }));

    // ====================
    // Viewer App
    // ====================

    // Viewer Lambda
    const viewerLambda = new lambda.Function(this, 'ViewerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'viewer.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/viewer')),
      environment: dbEnvVars,
      timeout: cdk.Duration.seconds(30)
    });

    // Import existing Cognito User Pool from Parameter Store
    const userPoolId = ssm.StringParameter.valueForStringParameter(
      this,
      '/oriole/cognito/user-pool-id'
    );

    const userPoolClientId = ssm.StringParameter.valueForStringParameter(
      this,
      '/oriole/cognito/user-pool-client-id'
    );

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      'ExistingUserPool',
      userPoolId
    );

    // HTTP API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'ViewerApi', {
      description: 'Oriole Maze Viewer API',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    // Cognito Authorizer
    const authorizer = new authorizers.HttpUserPoolAuthorizer(
      'CognitoAuthorizer',
      userPool,
      {
        userPoolClients: [
          cognito.UserPoolClient.fromUserPoolClientId(
            this,
            'UserPoolClient',
            userPoolClientId.valueAsString
          )
        ]
      }
    );

    // Add route to API Gateway
    httpApi.addRoutes({
      path: '/viewer',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'ViewerIntegration',
        viewerLambda
      ),
      authorizer: authorizer
    });

    httpApi.addRoutes({
      path: '/experiments/{experimentId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'ExperimentDataIntegration',
        viewerLambda
      ),
      authorizer: authorizer
    });

    // ====================
    // Parameter Store for Prompts
    // ====================

    // Create sample prompt parameters
    new ssm.StringParameter(this, 'PromptV1', {
      parameterName: '/oriole/prompts/v1',
      stringValue: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction (line-of-sight: walls block vision). Use move_north, move_south, move_east, move_west to navigate. Use recall_all to review what you have seen. You start knowing the grid size and your starting position. Think carefully about your position and plan your route efficiently.',
      description: 'Basic navigation prompt',
      tier: ssm.ParameterTier.STANDARD
    });

    // ====================
    // Bedrock Agents
    // ====================

    // Claude 3.5 Haiku Agent (cheapest tool-using model)
    const claude35Agent = new BedrockAgentConstruct(this, 'Claude35HaikuAgent', {
      agentName: 'oriole-claude-35-haiku',
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      instruction: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // ====================
    // Orchestration Lambdas
    // ====================

    // Grant SSM access to Lambda role
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/prompts/*`]
    }));

    // Grant Bedrock Agent Runtime access
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeAgent'],
      resources: ['*']
    }));

    // Start Experiment Lambda
    const startExperimentLambda = new lambda.Function(this, 'StartExperimentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'start-experiment.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/orchestration')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30)
    });

    // Invoke Agent Lambda
    const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'invoke-agent.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/orchestration')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5)
    });

    // Finalize Experiment Lambda
    const finalizeExperimentLambda = new lambda.Function(this, 'FinalizeExperimentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'finalize-experiment.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/orchestration')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(30)
    });

    // ====================
    // Step Functions
    // ====================

    // Start step
    const startStep = new tasks.LambdaInvoke(this, 'StartExperiment', {
      lambdaFunction: startExperimentLambda,
      resultPath: '$.experimentData',
      outputPath: '$.experimentData.Payload'
    });

    // Invoke agent step
    const invokeAgentStep = new tasks.LambdaInvoke(this, 'InvokeAgent', {
      lambdaFunction: invokeAgentLambda,
      resultPath: '$.agentResult',
      outputPath: '$'
    });

    // Finalize step
    const finalizeStep = new tasks.LambdaInvoke(this, 'FinalizeExperiment', {
      lambdaFunction: finalizeExperimentLambda,
      inputPath: '$.agentResult.Payload',
      resultPath: '$.finalResult',
      outputPath: '$.finalResult.Payload'
    });

    // Define the state machine workflow
    const definition = startStep
      .next(invokeAgentStep)
      .next(finalizeStep);

    // Create state machine
    const stateMachine = new sfn.StateMachine(this, 'ExperimentStateMachine', {
      definition,
      timeout: cdk.Duration.minutes(10),
      stateMachineName: 'oriole-experiment-runner'
    });

    // ====================
    // EventBridge Trigger
    // ====================

    // EventBridge rule to manually trigger experiments
    // Can be invoked with custom event data
    const experimentTriggerRule = new events.Rule(this, 'ExperimentTriggerRule', {
      eventPattern: {
        source: ['oriole.experiments'],
        detailType: ['RunExperiment']
      },
      description: 'Trigger Oriole maze experiments'
    });

    experimentTriggerRule.addTarget(new targets.SfnStateMachine(stateMachine));

    // ====================
    // Outputs
    // ====================

    new cdk.CfnOutput(this, 'ViewerApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'Viewer API Gateway URL'
    });

    new cdk.CfnOutput(this, 'ActionRouterLambdaArn', {
      value: actionRouterLambda.functionArn,
      description: 'Action Router Lambda ARN'
    });

    new cdk.CfnOutput(this, 'Claude35AgentId', {
      value: claude35Agent.agent.attrAgentId,
      description: 'Claude 3.5 Haiku Agent ID'
    });

    new cdk.CfnOutput(this, 'Claude35AgentAliasId', {
      value: claude35Agent.agentAlias.attrAgentAliasId,
      description: 'Claude 3.5 Haiku Agent Alias ID'
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Experiment Runner State Machine ARN'
    });
  }
}

module.exports = { OrioleStack };
