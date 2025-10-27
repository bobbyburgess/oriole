const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const iam = require('aws-cdk-lib/aws-iam');
const ec2 = require('aws-cdk-lib/aws-ec2');
const apigatewayv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const authorizers = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const cognito = require('aws-cdk-lib/aws-cognito');
const acm = require('aws-cdk-lib/aws-certificatemanager');
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
    const maxExecutionSeconds = cdk.Token.asNumber(
      ssm.StringParameter.valueForStringParameter(this, '/oriole/lambda/max-execution-seconds')
    );
    const invokeAgentMaxExecutionSeconds = cdk.Token.asNumber(
      ssm.StringParameter.valueForStringParameter(this, '/oriole/lambda/invoke-agent-max-execution-seconds')
    );
    const cooldownSeconds = cdk.Token.asNumber(
      ssm.StringParameter.valueForStringParameter(this, '/oriole/experiments/cooldown-seconds')
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
      timeout: cdk.Duration.seconds(maxExecutionSeconds)
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
      timeout: cdk.Duration.seconds(maxExecutionSeconds)
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
      description: 'Oriole Grid Exploration Viewer API',
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
    // Root path redirects to /viewer
    httpApi.addRoutes({
      path: '/',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'RootRedirectIntegration',
        viewerLambda
      )
    });

    // /viewer endpoint is public (serves HTML with login form)
    httpApi.addRoutes({
      path: '/viewer',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'ViewerIntegration',
        viewerLambda
      )
    });

    // /experiments endpoint requires auth (returns list of experiments)
    httpApi.addRoutes({
      path: '/experiments',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'ExperimentsListIntegration',
        viewerLambda
      ),
      authorizer: authorizer
    });

    // /experiments/{experimentId} endpoint requires auth (protected data)
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
    // Custom Domain for Viewer API
    // ====================

    // Request ACM certificate for custom domain
    const certificate = new acm.Certificate(this, 'GridDomainCertificate', {
      domainName: 'grid.bb443.com',
      validation: acm.CertificateValidation.fromDns()
    });

    // Create custom domain name for API Gateway
    const domainName = new apigatewayv2.DomainName(this, 'GridCustomDomain', {
      domainName: 'grid.bb443.com',
      certificate: certificate
    });

    // Map custom domain to the HTTP API
    new apigatewayv2.ApiMapping(this, 'GridApiMapping', {
      api: httpApi,
      domainName: domainName,
      stage: httpApi.defaultStage
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

    // Claude 3.5 Haiku Agent (newer, more capable)
    const claude35Agent = new BedrockAgentConstruct(this, 'Claude35HaikuAgent', {
      agentName: 'oriole-claude-35-haiku',
      modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Claude 3 Haiku Agent (cheaper option for long experiments)
    const claude3Agent = new BedrockAgentConstruct(this, 'Claude3HaikuAgent', {
      agentName: 'oriole-claude-3-haiku',
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Micro Agent (AWS's smallest, fastest model)
    // IMPORTANT: Nova models REQUIRE inference profiles - they cannot be invoked with direct model IDs
    // Using DEFAULT mode - AWS will provide the orchestration prompt with built-in tool calling
    const novaMicroAgent = new BedrockAgentConstruct(this, 'NovaMicroAgent', {
      agentName: 'oriole-nova-micro',
      modelId: 'us.amazon.nova-micro-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Lite Agent (AWS's fast, cost-effective model)
    const novaLiteAgent = new BedrockAgentConstruct(this, 'NovaLiteAgent', {
      agentName: 'oriole-nova-lite',
      modelId: 'us.amazon.nova-lite-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Pro Agent (AWS's most capable text model)
    const novaProAgent = new BedrockAgentConstruct(this, 'NovaProAgent', {
      agentName: 'oriole-nova-pro',
      modelId: 'us.amazon.nova-pro-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // Amazon Nova Premier Agent (AWS's most advanced reasoning model)
    const novaPremierAgent = new BedrockAgentConstruct(this, 'NovaPremierAgent', {
      agentName: 'oriole-nova-premier',
      modelId: 'us.amazon.nova-premier-v1:0',
      instruction: 'You are exploring a 60x60 grid with walls to find a target object. You can see 3 blocks in each cardinal direction (walls block vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
      actionLambda: actionRouterLambda
    });

    // ====================
    // Orchestration Lambdas
    // ====================

    // Grant SSM access to Lambda role for runtime configuration
    // All Lambdas share this role and need access to:
    //  - /oriole/db/password (database credentials)
    //  - /oriole/prompts/* (agent instructions)
    //  - /oriole/max-moves (global max moves limit)
    //  - /oriole/max-duration-minutes (global max duration)
    //  - /oriole/experiments/* (cooldown, recall interval)
    //  - /oriole/gameplay/* (vision range)
    //  - /oriole/pricing/* (model pricing for cost calculation)
    //  - /oriole/models/* (model-specific rate limits)
    //  - /oriole/ollama/endpoint (local Ollama webhook URL)
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/prompts/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/db/password`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/max-moves`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/max-duration-minutes`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/experiments/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/gameplay/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/pricing/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/models/*`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/ollama/endpoint`
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
      timeout: cdk.Duration.seconds(maxExecutionSeconds)
    });

    // Invoke Agent Lambda (Bedrock)
    // Serialize Bedrock Agent invocations to avoid throttling
    // Lambda concurrency quota has been increased to 1000, so we can now use reserved concurrency
    const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/invoke-agent.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(invokeAgentMaxExecutionSeconds),
      reservedConcurrentExecutions: 1  // Process one agent invocation at a time
    });

    // Invoke Agent Lambda (Ollama)
    // Create separate role to avoid circular dependency with actionRouterLambda
    const ollamaLambdaRole = new iam.Role(this, 'OllamaLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Ollama agent Lambda function'
    });

    // Grant CloudWatch Logs permissions
    ollamaLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Grant VPC execution permissions (if needed)
    ollamaLambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );

    // Grant SSM Parameter Store access for Ollama endpoint and API key
    ollamaLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/ollama/endpoint`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/ollama/api-key`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/prompts/*`
      ]
    }));

    // Grant database access (same as other Lambdas)
    ollamaLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'rds:DescribeDBInstances',
        'rds:Connect'
      ],
      resources: ['*']
    }));

    // ==========================================
    // INVOKE AGENT (Ollama): Local LLM Integration
    // ==========================================
    //
    // ARCHITECTURE: Separate Lambda for local Ollama calls
    // Why not use the same invoke-agent Lambda?
    //   1. Different infrastructure: HTTPS webhook to home server vs AWS Bedrock API
    //   2. Different response format: Ollama returns {response, prompt_eval_count, eval_count}
    //      vs Bedrock returns {inputTokens, outputTokens, stopReason}
    //   3. Different action execution: Ollama must manually invoke action router
    //      vs Bedrock orchestrates tool calls automatically
    //   4. Different credentials: Ollama needs endpoint + API key from Parameter Store
    //      vs Bedrock needs bedrock:InvokeAgent IAM permission
    //
    // FLOW:
    //   1. Step Functions AgentProviderRouter routes based on llmProvider field
    //   2. This Lambda calls Ollama via HTTPS (auth proxy on home server)
    //   3. Parses actions from raw text response (no structured tool calling)
    //   4. Sequentially invokes action router for each action
    //   5. Returns same format as invoke-agent (for check-progress compatibility)
    //
    // RATE LIMITING:
    //   No concurrency limit needed - local calls are fast and free
    //   Rate limiting happens at Step Functions level (RateLimitWait state)
    //   This is different from Bedrock which has reserved concurrency of 1
    //
    // SECURITY:
    //   Separate IAM role (ollamaLambdaRole) isolates permissions:
    //     - NO bedrock:InvokeAgent permission (doesn't need it)
    //     - SSM read for /oriole/ollama/endpoint and /oriole/ollama/api-key
    //     - SSM read for /oriole/prompts/* (same as Bedrock path)
    //     - lambda:InvokeFunction for action router (manual action execution)
    const invokeAgentOllamaLambda = new lambda.Function(this, 'InvokeAgentOllamaFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/invoke-agent-ollama.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        ...dbEnvVars,
        ACTION_ROUTER_FUNCTION_NAME: actionRouterLambda.functionName
      },
      role: ollamaLambdaRole,
      timeout: cdk.Duration.seconds(invokeAgentMaxExecutionSeconds)
      // No concurrency limit - webhook calls are fast and local
    });

    // Grant Ollama Lambda permission to invoke action router
    // This is done AFTER both functions are created to avoid circular dependency
    ollamaLambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [actionRouterLambda.functionArn, `${actionRouterLambda.functionArn}:*`]
    }));

    // Finalize Experiment Lambda
    const finalizeExperimentLambda = new lambda.Function(this, 'FinalizeExperimentFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/finalize-experiment.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(maxExecutionSeconds)
    });

    // Check Progress Lambda
    const checkProgressLambda = new lambda.Function(this, 'CheckProgressFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/check-progress.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: dbEnvVars,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(maxExecutionSeconds)
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

    // Finalize on error - Marks experiment as failed with error details
    const finalizeOnError = new tasks.LambdaInvoke(this, 'FinalizeOnError', {
      lambdaFunction: finalizeExperimentLambda,
      payload: sfn.TaskInput.fromObject({
        experimentId: sfn.JsonPath.numberAt('$.experimentId'),
        success: false,
        failureReason: sfn.JsonPath.stringAt('$.errorInfo.Cause')
      }),
      resultPath: '$.finalResult',
      outputPath: '$.finalResult.Payload'
    });

    // Invoke agent step - Routes to either Bedrock or Ollama based on llmProvider
    // Bedrock agent invocation
    const invokeBedrockAgentStep = new tasks.LambdaInvoke(this, 'InvokeBedrockAgent', {
      lambdaFunction: invokeAgentLambda,
      resultPath: '$.agentResult', // Store result in state
      outputPath: '$', // Pass through entire state (needed for check-progress)
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(invokeAgentMaxExecutionSeconds))
    }).addCatch(finalizeOnError, {
      errors: ['States.TaskFailed'],
      resultPath: '$.errorInfo'
    });

    // Ollama agent invocation
    const invokeOllamaAgentStep = new tasks.LambdaInvoke(this, 'InvokeOllamaAgent', {
      lambdaFunction: invokeAgentOllamaLambda,
      resultPath: '$.agentResult', // Store result in state
      outputPath: '$', // Pass through entire state (needed for check-progress)
      taskTimeout: sfn.Timeout.duration(cdk.Duration.seconds(invokeAgentMaxExecutionSeconds))
    }).addCatch(finalizeOnError, {
      errors: ['States.TaskFailed'],
      resultPath: '$.errorInfo'
    });

    // ==========================================
    // AGENT PROVIDER ROUTER: Route based on llmProvider field
    // ==========================================
    //
    // This Choice state enables the SAME state machine to support both:
    //   - AWS Bedrock Agents (full tool orchestration, AWS-managed inference)
    //   - Local Ollama (raw LLM, manual action parsing and execution)
    //
    // The llmProvider field is set in start-experiment and flows through the entire state machine:
    //   start-experiment -> check-progress -> [loop back] -> AgentProviderRouter -> invoke-agent-*
    //
    // Routing logic:
    //   llmProvider='ollama'  -> InvokeOllamaAgent (local HTTPS calls, manual action execution)
    //   llmProvider='bedrock' -> InvokeBedrockAgent (AWS API, automatic tool orchestration)
    //   default/missing       -> InvokeBedrockAgent (backwards compatibility)
    //
    // Why this design?
    //   - Single experiment launcher (trigger-by-name.sh) works for all models
    //   - Shared state machine logic (cooldown, rate limiting, progress checking)
    //   - Model-specific behavior isolated to invoke-agent-* Lambdas
    //   - Easy to add new LLM providers (e.g., OpenAI) by adding another branch
    //
    // See start-experiment.js for full LLM Provider Routing documentation
    const agentRouterChoice = new sfn.Choice(this, 'AgentProviderRouter')
      .when(
        sfn.Condition.stringEquals('$.llmProvider', 'ollama'),
        invokeOllamaAgentStep
      )
      .otherwise(invokeBedrockAgentStep);

    // Check progress step - Determines if experiment should continue
    const checkProgressStep = new tasks.LambdaInvoke(this, 'CheckProgress', {
      lambdaFunction: checkProgressLambda,
      resultPath: '$.progressResult',
      outputPath: '$.progressResult.Payload' // Extract payload with shouldContinue flag
    });

    // Cooldown wait - Delay after experiment start to prevent concurrent API load
    // Duration from Parameter Store: /oriole/experiments/cooldown-seconds
    // This ensures rate limits reset between experiments
    const cooldownWait = new sfn.Wait(this, 'CooldownWait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(cooldownSeconds))
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

    // Connect both agent paths to check progress
    invokeBedrockAgentStep.next(checkProgressStep);
    invokeOllamaAgentStep.next(checkProgressStep);

    // Chain progress check back to should continue choice
    checkProgressStep.next(shouldContinueChoice);

    // Chain wait back to agent router
    rateLimitWait.next(agentRouterChoice);

    // Chain the workflow steps together
    // Start -> Cooldown (from param store) -> AgentRouter -> (Bedrock|Ollama) -> CheckProgress -> Choice
    const definition = startStep
      .next(cooldownWait)
      .next(agentRouterChoice);

    // Create the state machine
    // Timeout allows 1 hour for 100 moves (typical: 20 seconds/move at 3 RPM)
    const stateMachine = new sfn.StateMachine(this, 'ExperimentStateMachine', {
      definition,
      timeout: cdk.Duration.hours(1),
      stateMachineName: 'oriole-experiment-runner'
    });

    // ====================
    // SQS Queues for Experiment Serialization
    // ====================

    // FIFO queue for Bedrock experiments - runs sequentially (one at a time)
    // MessageGroupId = "bedrock-experiments" (static - serializes everything)
    // This prevents rate limit conflicts by ensuring only one Bedrock experiment runs at a time
    const bedrockExperimentQueue = new sqs.Queue(this, 'BedrockExperimentQueue', {
      queueName: 'oriole-bedrock-experiment-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true, // Auto-dedupe based on message body
      visibilityTimeout: cdk.Duration.seconds(60), // Fast retry when queue processor detects running experiment
      retentionPeriod: cdk.Duration.days(14) // Keep failed messages visible for debugging
      // No DLQ, no retries - if it fails, it fails
    });

    // FIFO queue for Ollama experiments - allows multiple concurrent (up to MAX_CONCURRENT_OLLAMA)
    // MessageGroupId = "ollama-experiments" (static)
    // No rate limits on local Ollama, so we can run multiple experiments in parallel
    const ollamaExperimentQueue = new sqs.Queue(this, 'OllamaExperimentQueue', {
      queueName: 'oriole-ollama-experiment-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(14)
    });

    // ====================
    // Queue Processor Lambdas
    // ====================

    // Dedicated role for queue processors (avoids circular dependency with shared role)
    const queueProcessorRole = new iam.Role(this, 'QueueProcessorRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    // Bedrock queue processor - enforces strict serialization (one at a time)
    const bedrockQueueProcessorLambda = new lambda.Function(this, 'BedrockQueueProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/queue-processor.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn
      },
      role: queueProcessorRole,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 1 // Only 1 Bedrock experiment at a time
    });

    stateMachine.grantStartExecution(bedrockQueueProcessorLambda);
    stateMachine.grantRead(bedrockQueueProcessorLambda);

    bedrockQueueProcessorLambda.addEventSource(new SqsEventSource(bedrockExperimentQueue, {
      batchSize: 1
    }));

    // Ollama queue processor - allows configurable concurrent experiments
    const ollamaQueueProcessorLambda = new lambda.Function(this, 'OllamaQueueProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'orchestration/ollama-queue-processor.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn
        // MAX_CONCURRENT is now read from /oriole/ollama/max-concurrent-experiments in Parameter Store
      },
      role: queueProcessorRole,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 10 // Allow enough for max possible concurrency
    });

    stateMachine.grantStartExecution(ollamaQueueProcessorLambda);
    stateMachine.grantRead(ollamaQueueProcessorLambda);

    // Grant SSM access to read max-concurrent-experiments parameter
    queueProcessorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/oriole/ollama/max-concurrent-experiments`
      ]
    }));

    ollamaQueueProcessorLambda.addEventSource(new SqsEventSource(ollamaExperimentQueue, {
      batchSize: 1
    }));

    // ====================
    // EventBridge Triggers
    // ====================

    // EventBridge rule for Bedrock experiments - routes to serial queue
    const bedrockExperimentTriggerRule = new events.Rule(this, 'BedrockExperimentTriggerRule', {
      eventPattern: {
        source: ['oriole.experiments'],
        detailType: ['RunExperiment'],
        detail: {
          llmProvider: ['bedrock'] // Only Bedrock experiments
        }
      },
      description: 'Trigger Bedrock experiments (serialized)'
    });

    bedrockExperimentTriggerRule.addTarget(new targets.SqsQueue(bedrockExperimentQueue, {
      messageGroupId: 'bedrock-experiments' // All Bedrock experiments serialize
    }));

    // EventBridge rule for Ollama experiments - routes to concurrent queue
    const ollamaExperimentTriggerRule = new events.Rule(this, 'OllamaExperimentTriggerRule', {
      eventPattern: {
        source: ['oriole.experiments'],
        detailType: ['RunExperiment'],
        detail: {
          llmProvider: ['ollama'] // Only Ollama experiments
        }
      },
      description: 'Trigger Ollama experiments (concurrent)'
    });

    ollamaExperimentTriggerRule.addTarget(new targets.SqsQueue(ollamaExperimentQueue, {
      messageGroupId: 'ollama-experiments' // All Ollama experiments can run concurrently (up to limit)
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
      description: 'Viewer API Gateway URL (default)'
    });

    new cdk.CfnOutput(this, 'GridCustomDomainUrl', {
      value: `https://grid.bb443.com`,
      description: 'Custom domain URL for viewer (after DNS setup)'
    });

    new cdk.CfnOutput(this, 'GridDomainTarget', {
      value: domainName.regionalDomainName,
      description: 'API Gateway domain for Route53 CNAME (grid.bb443.com -> this)'
    });

    new cdk.CfnOutput(this, 'ActionRouterLambdaArn', {
      value: actionRouterLambda.functionArn,
      description: 'Action Router Lambda ARN'
    });

    new cdk.CfnOutput(this, 'InvokeAgentOllamaLambdaArn', {
      value: invokeAgentOllamaLambda.functionArn,
      description: 'Invoke Agent Ollama Lambda ARN'
    });

    new cdk.CfnOutput(this, 'Claude35AgentId', {
      value: claude35Agent.agent.attrAgentId,
      description: 'Claude 3.5 Haiku Agent ID'
    });

    new cdk.CfnOutput(this, 'Claude3AgentId', {
      value: claude3Agent.agent.attrAgentId,
      description: 'Claude 3 Haiku Agent ID'
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

    // Agent Alias IDs - NOT EXPORTED due to CloudFormation drift
    // Use setup-agent-ids.sh script to discover alias IDs from Bedrock API

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Experiment Runner State Machine ARN'
    });
  }
}

module.exports = { OrioleStack };
