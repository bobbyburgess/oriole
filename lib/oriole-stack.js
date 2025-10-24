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
const sqs = require('aws-cdk-lib/aws-sqs');
const { SqsEventSource } = require('aws-cdk-lib/aws-lambda-event-sources');
const path = require('path');
const { BedrockAgentConstruct } = require('./bedrock-agent-construct');
const { OrioleDashboardConstruct } = require('./dashboard-construct');

class OrioleStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // ====================================================================
    // Infrastructure Configuration from Parameter Store
    // ====================================================================
    // Lambda configuration - can be changed in Parameter Store but requires redeployment
    // Note: All timeouts must be in seconds when using tokens (CDK limitation)
    const defaultTimeoutSeconds = cdk.Token.asNumber(
      ssm.StringParameter.valueForStringParameter(this, '/oriole/lambda/default-timeout-seconds')
    );
    const invokeAgentTimeoutSeconds = cdk.Token.asNumber(
      ssm.StringParameter.valueForStringParameter(this, '/oriole/lambda/invoke-agent-timeout-seconds')
    );

    // No retry configuration - experiments fail fast
    // No Lambda concurrency limits - PostgreSQL advisory locks handle experiment-level serialization

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
      // No concurrency limit - PostgreSQL advisory locks handle serialization per experiment
      // This allows Bedrock Agent to make concurrent tool calls without 429 errors
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

    // Amazon Nova Micro Agent (AWS's smallest, fastest model)
    // IMPORTANT: Nova models REQUIRE inference profiles - they cannot be invoked with direct model IDs
    const novaMicroAgent = new BedrockAgentConstruct(this, 'NovaMicroAgent', {
      agentName: 'oriole-nova-micro',
      modelId: 'us.amazon.nova-micro-v1:0',
      instruction: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Lite Agent (AWS's fast, cost-effective model)
    const novaLiteAgent = new BedrockAgentConstruct(this, 'NovaLiteAgent', {
      agentName: 'oriole-nova-lite',
      modelId: 'us.amazon.nova-lite-v1:0',
      instruction: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Pro Agent (AWS's most capable text model)
    const novaProAgent = new BedrockAgentConstruct(this, 'NovaProAgent', {
      agentName: 'oriole-nova-pro',
      modelId: 'us.amazon.nova-pro-v1:0',
      instruction: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Premier Agent (AWS's most advanced reasoning model)
    const novaPremierAgent = new BedrockAgentConstruct(this, 'NovaPremierAgent', {
      agentName: 'oriole-nova-premier',
      modelId: 'us.amazon.nova-premier-v1:0',
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
    //  - /oriole/pricing/* (model pricing for cost calculation)
    //  - /oriole/models/* (model-specific rate limits)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/prompts/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/db/password`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/experiments/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/gameplay/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/pricing/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/models/*`
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
    // TODO: Once Lambda concurrency quota is increased to 1000, add:
    //       reservedConcurrentExecutions: 1  // Serialize Bedrock Agent invocations to avoid throttling
    const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/invoke-agent.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(invokeAgentTimeoutSeconds)
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
    // 3. CheckProgress: Count moves, check stop conditions, fetch position, calculate wait time
    // 4. Choice: Continue looping or finalize based on shouldContinue
    // 5. RateLimitWait: Wait for model-specific duration to prevent throttling
    // 6. FinalizeExperiment: Update DB with results when done
    //
    // State flow:
    //   Start → InvokeAgent → CheckProgress → [shouldContinue?]
    //                              ↑                ↓ true
    //                              |           RateLimitWait
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
    // No retries - SQS queue serialization prevents rate limits
    const invokeAgentStep = new tasks.LambdaInvoke(this, 'InvokeAgent', {
      lambdaFunction: invokeAgentLambda,
      resultPath: '$.agentResult', // Store result in state
      outputPath: '$', // Pass through entire state (needed for check-progress)
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(invokeAgentTimeoutSeconds))
    });

    // Check progress step - Determines if experiment should continue
    const checkProgressStep = new tasks.LambdaInvoke(this, 'CheckProgress', {
      lambdaFunction: checkProgressLambda,
      resultPath: '$.progressResult',
      outputPath: '$.progressResult.Payload' // Extract payload with shouldContinue flag
    });

    // Rate limiting wait - Enforces model-specific rate limits
    // Duration comes from check-progress Lambda via $.waitSeconds
    // Calculated as: 60 / rate-limit-rpm (stored in Parameter Store)
    // Example: Claude 3.5 Haiku at 3 RPM = 20 seconds between requests
    const rateLimitWait = new sfn.Wait(this, 'RateLimitWait', {
      time: sfn.WaitTime.secondsPath('$.waitSeconds')
    });

    // Choice state - Branch based on stop conditions
    // If shouldContinue=true: Loop back to InvokeAgent
    // If shouldContinue=false: Go to FinalizeExperiment
    const shouldContinueChoice = new sfn.Choice(this, 'ShouldContinue?')
      .when(
        sfn.Condition.booleanEquals('$.shouldContinue', true),
        rateLimitWait // Wait before next invocation to enforce rate limits
      )
      .otherwise(
        new tasks.LambdaInvoke(this, 'FinalizeExperiment', {
          lambdaFunction: finalizeExperimentLambda,
          resultPath: '$.finalResult',
          outputPath: '$.finalResult.Payload'
        })
      );

    // Chain wait back to invoke agent
    rateLimitWait.next(invokeAgentStep);

    // Chain the workflow steps together
    const definition = startStep
      .next(invokeAgentStep)
      .next(checkProgressStep)
      .next(shouldContinueChoice);

    // Create the state machine
    // Timeout allows 1 hour for 100 moves (typical: 20 seconds/move at 3 RPM)
    const stateMachine = new sfn.StateMachine(this, 'ExperimentStateMachine', {
      definition,
      timeout: cdk.Duration.hours(1),
      stateMachineName: 'oriole-experiment-runner'
    });

    // ====================
    // SQS Queue for Experiment Serialization
    // ====================

    // FIFO queue ensures ALL experiments run sequentially (one at a time globally)
    // MessageGroupId = "all-experiments" (static - serializes everything)
    // This prevents rate limit conflicts by ensuring only one experiment runs at a time
    const experimentQueue = new sqs.Queue(this, 'ExperimentQueue', {
      queueName: 'oriole-experiment-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true, // Auto-dedupe based on message body
      visibilityTimeout: cdk.Duration.minutes(35), // Longer than max experiment duration (30 min)
      retentionPeriod: cdk.Duration.days(14) // Keep failed messages visible for debugging
      // No DLQ, no retries - if it fails, it fails
    });

    // ====================
    // Queue Processor Lambda
    // ====================

    // Dedicated role for queue processor (avoids circular dependency with shared role)
    const queueProcessorRole = new iam.Role(this, 'QueueProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    // Lambda that polls SQS and starts Step Function executions
    const queueProcessorLambda = new lambda.Function(this, 'QueueProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/queue-processor.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn
      },
      role: queueProcessorRole,
      timeout: cdk.Duration.seconds(30), // Just needs to start Step Function
      reservedConcurrentExecutions: 1 // Process one message at a time per MessageGroupId
    });

    // Grant permission to start Step Function executions
    stateMachine.grantStartExecution(queueProcessorLambda);

    // Connect Lambda to SQS queue
    queueProcessorLambda.addEventSource(new SqsEventSource(experimentQueue, {
      batchSize: 1 // Process one experiment request at a time
      // No reportBatchItemFailures - if Lambda fails, SQS will requeue after visibility timeout
    }));

    // ====================
    // EventBridge Trigger
    // ====================

    // EventBridge rule to manually trigger experiments
    // Now routes to SQS queue instead of directly to Step Functions
    const experimentTriggerRule = new events.Rule(this, 'ExperimentTriggerRule', {
      eventPattern: {
        source: ['oriole.experiments'],
        detailType: ['RunExperiment']
      },
      description: 'Trigger Oriole maze experiments'
    });

    // Send events to SQS queue (queue will serialize by model)
    // For now, use a static MessageGroupId - all experiments serialize
    // TODO: Find proper way to dynamically set MessageGroupId in CDK
    experimentTriggerRule.addTarget(new targets.SqsQueue(experimentQueue, {
      messageGroupId: 'all-experiments' // All experiments in one FIFO group (serialized)
    }));

    // ====================
    // CloudWatch Dashboard
    // ====================

    new OrioleDashboardConstruct(this, 'OrioleDashboard', {
      invokeAgentLambda,
      checkProgressLambda,
      actionRouterLambda,
      stateMachine
    });

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

    new cdk.CfnOutput(this, 'NovaMicroAgentId', {
      value: novaMicroAgent.agent.attrAgentId,
      description: 'Amazon Nova Micro Agent ID'
    });

    new cdk.CfnOutput(this, 'NovaLiteAgentId', {
      value: novaLiteAgent.agent.attrAgentId,
      description: 'Amazon Nova Lite Agent ID'
    });

    new cdk.CfnOutput(this, 'NovaProAgentId', {
      value: novaProAgent.agent.attrAgentId,
      description: 'Amazon Nova Pro Agent ID'
    });

    new cdk.CfnOutput(this, 'NovaPremierAgentId', {
      value: novaPremierAgent.agent.attrAgentId,
      description: 'Amazon Nova Premier Agent ID'
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
