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

    // ====================================================================
    // Infrastructure Configuration Constants
    // ====================================================================
    // These timeouts/retries are hardcoded in CDK (require redeployment to change)
    // For runtime-configurable parameters, see Parameter Store:
    //   - /oriole/gameplay/vision-range (how far agents can see)
    //   - /oriole/experiments/recall-interval (min moves between recalls)
    //   - /oriole/experiments/max-moves (max actions per experiment)
    //   - /oriole/experiments/max-duration-minutes (max runtime)
    //
    // Why hardcoded here?
    // CDK's valueFromLookup() requires context during synthesis, making it unsuitable
    // for Lambda timeouts and Step Functions retry configs
    const defaultTimeoutSeconds = 30;
    const invokeAgentTimeoutMinutes = 5; // Bedrock Agent calls can be slow
    const retryIntervalSeconds = 6; // Bedrock rate limits ~10 req/min for Haiku
    const retryMaxAttempts = 3;
    const retryBackoffRate = 2.0; // Exponential backoff for rate limiting

    // Database configuration for Lambda environment variables
    // Note: DB_PASSWORD is fetched from Parameter Store at runtime by Lambdas
    const dbEnvVars = {
      DB_HOST: 'continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com',
      DB_PORT: '5432',
      DB_NAME: 'oriole',
      DB_USER: 'oriole_user'
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
      handler: 'actions/router.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(defaultTimeoutSeconds)
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
      role: lambdaRole,
      timeout: cdk.Duration.seconds(defaultTimeoutSeconds)
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

    // Import existing Cognito User Pool Client
    const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      'UserPoolClient',
      userPoolClientId
    );

    // Cognito Authorizer
    const authorizer = new authorizers.HttpUserPoolAuthorizer(
      'CognitoAuthorizer',
      userPool,
      {
        userPoolClients: [userPoolClient]
      }
    );

    // Add route to API Gateway
    // /viewer endpoint is public (serves HTML with login form)
    httpApi.addRoutes({
      path: '/viewer',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'ViewerIntegration',
        viewerLambda
      )
    });

    // /experiments endpoint requires auth (protected data)
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

    // Grant SSM access to Lambda role for runtime configuration
    // All Lambdas share this role and need access to:
    //  - /oriole/db/password (database credentials)
    //  - /oriole/prompts/* (agent instructions)
    //  - /oriole/experiments/* (max moves, duration, recall interval)
    //  - /oriole/gameplay/* (vision range)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/prompts/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/db/password`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/experiments/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/gameplay/*`
      ]
    }));

    // Grant Bedrock Agent Runtime access
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeAgent'],
      resources: ['*']
    }));

    // Start Experiment Lambda
    const startExperimentLambda = new lambda.Function(this, 'StartExperimentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/start-experiment.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(defaultTimeoutSeconds)
    });

    // Invoke Agent Lambda
    const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/invoke-agent.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(invokeAgentTimeoutMinutes)
    });

    // Finalize Experiment Lambda
    const finalizeExperimentLambda = new lambda.Function(this, 'FinalizeExperimentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/finalize-experiment.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(defaultTimeoutSeconds)
    });

    // Check Progress Lambda
    const checkProgressLambda = new lambda.Function(this, 'CheckProgressFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/check-progress.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(defaultTimeoutSeconds)
    });

    // ====================
    // Step Functions Workflow
    // ====================
    // Orchestrates the experiment loop:
    // 1. StartExperiment: Create DB record, return initial state
    // 2. InvokeAgent: Call Bedrock Agent to perform one action
    // 3. CheckProgress: Count moves, check stop conditions, fetch position
    // 4. Choice: Continue looping or finalize based on shouldContinue
    // 5. FinalizeExperiment: Update DB with results when done
    //
    // State flow:
    //   Start → InvokeAgent → CheckProgress → [shouldContinue?]
    //                              ↑                ↓ true
    //                              └────────────────┘
    //                                         ↓ false
    //                                    Finalize → End

    // Start step - Creates experiment record in DB
    const startStep = new tasks.LambdaInvoke(this, 'StartExperiment', {
      lambdaFunction: startExperimentLambda,
      resultPath: '$.experimentData',
      outputPath: '$.experimentData.Payload' // Extract just the payload for next step
    });

    // Invoke agent step - Calls Bedrock Agent for one iteration
    // Retry logic handles Bedrock rate limiting (~10 req/min for Haiku)
    const invokeAgentStep = new tasks.LambdaInvoke(this, 'InvokeAgent', {
      lambdaFunction: invokeAgentLambda,
      resultPath: '$.agentResult', // Store result in state
      outputPath: '$', // Pass through entire state (needed for check-progress)
      retryOnServiceExceptions: true,
      taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(invokeAgentTimeoutMinutes))
    }).addRetry({
      errors: ['States.TaskFailed', 'ThrottlingException', 'TooManyRequestsException'],
      interval: cdk.Duration.seconds(retryIntervalSeconds),
      maxAttempts: retryMaxAttempts,
      backoffRate: retryBackoffRate // Exponential backoff: 6s, 12s, 24s
    });

    // Check progress step - Determines if experiment should continue
    const checkProgressStep = new tasks.LambdaInvoke(this, 'CheckProgress', {
      lambdaFunction: checkProgressLambda,
      resultPath: '$.progressResult',
      outputPath: '$.progressResult.Payload' // Extract payload with shouldContinue flag
    });

    // Choice state - Branch based on stop conditions
    // If shouldContinue=true: Loop back to InvokeAgent
    // If shouldContinue=false: Go to FinalizeExperiment
    const shouldContinueChoice = new sfn.Choice(this, 'ShouldContinue?')
      .when(
        sfn.Condition.booleanEquals('$.shouldContinue', true),
        invokeAgentStep // Loop back
      )
      .otherwise(
        new tasks.LambdaInvoke(this, 'FinalizeExperiment', {
          lambdaFunction: finalizeExperimentLambda,
          resultPath: '$.finalResult',
          outputPath: '$.finalResult.Payload'
        })
      );

    // Chain the workflow steps together
    const definition = startStep
      .next(invokeAgentStep)
      .next(checkProgressStep)
      .next(shouldContinueChoice);

    // Create the state machine
    // Timeout allows 1 hour for 100 moves (worst case: 36 seconds/move with retries)
    const stateMachine = new sfn.StateMachine(this, 'ExperimentStateMachine', {
      definition,
      timeout: cdk.Duration.hours(1),
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

    // Alias managed manually - aliasId: 54HMIQZHQ9
    // new cdk.CfnOutput(this, 'Claude35AgentAliasId', {
    //   value: claude35Agent.agentAlias.attrAgentAliasId,
    //   description: 'Claude 3.5 Haiku Agent Alias ID'
    // });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Experiment Runner State Machine ARN'
    });
  }
}

module.exports = { OrioleStack };
