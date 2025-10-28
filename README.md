# Oriole 🐦

A/B testing framework for evaluating AI model performance on spatial reasoning tasks using AWS Bedrock Agents.

## Overview

Oriole runs AI agents through 2D mazes and captures detailed telemetry:
- Every move and reasoning step
- Tokens consumed
- Success metrics
- Spatial memory queries

Data flows to RDS Postgres for analysis via QuickSight dashboards and an interactive viewer app.

## Architecture

```
EventBridge → SQS FIFO Queue → Queue Processor Lambda → Step Functions → Bedrock Agent
              (serializes)       (fail-fast)              (rate limits)        ↓
                                                                         Action Lambdas
                                                                               ↓
                                                                         RDS Postgres
                                                                               ↓
                                                                  QuickSight + Viewer App
```

### Components

- **SQS FIFO Queue**: Serializes experiment requests to prevent concurrent runs and rate limiting
- **Queue Processor Lambda**: Starts Step Functions executions one at a time
- **Step Functions**: Orchestrate experiment lifecycle with deterministic rate limiting
- **Bedrock Agents**: Claude 3.5 Haiku and Amazon Nova models navigate mazes autonomously
- **Action Groups**: Lambda functions handling `move_north`, `move_south`, `move_east`, `move_west`, `recall_all`
- **RDS Postgres**: Store all moves, reasoning, and metrics
- **Viewer App**: Web UI to replay experiments step-by-step
- **QuickSight**: Analytics dashboards for model comparison

### Rate Limiting Strategy

**Problem**: AWS Bedrock has per-model rate limits (e.g., 10 RPM for Claude 3.5 Haiku) that apply account-wide.

**Solution**:
1. **SQS FIFO Queue** ensures only ONE experiment runs at a time (prevents concurrent API calls)
2. **Calculated Wait Times** between InvokeAgent calls based on model's RPM limit (stored in Parameter Store)
3. **Fail-Fast** approach - any throttling error immediately fails the experiment (no retries masking issues)

This combination guarantees we stay under rate limits while maintaining predictable experiment execution.

## Project Structure

```
oriole/
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definitions
├── lambda/
│   ├── actions/           # Bedrock agent action handlers
│   ├── orchestration/     # Experiment lifecycle management
│   │   ├── queue-processor.js    # SQS → Step Functions bridge
│   │   ├── start-experiment.js   # Initialize DB record
│   │   ├── invoke-agent.js       # Call Bedrock Agent (fail-fast)
│   │   ├── check-progress.js     # Calculate rate limits, check stop conditions
│   │   └── finalize-experiment.js # Update DB with results
│   ├── viewer/            # Web UI Lambda
│   └── shared/            # DB and vision utilities
├── db/
│   ├── migrations/        # SQL schema
│   └── mazes/             # Maze generators and data
├── scripts/               # Helper scripts
├── test/                  # Integration tests
└── docs/                  # Additional documentation
```

## Prerequisites

- AWS Account with Bedrock access
- Node.js 20+
- AWS CLI configured
- CDK CLI: `npm install -g aws-cdk`
- RDS Postgres instance (already set up)

## Setup

### 1. Install Dependencies

```bash
npm install
cd lambda/actions && npm install && cd ../..
cd lambda/orchestration && npm install && cd ../..
cd lambda/viewer && npm install && cd ../..
```

### 2. Load Mazes into Database

```bash
# Generate mazes
node db/mazes/generator.js

# Load into Postgres
node db/mazes/load-mazes.js
```

### 3. Set up Cognito Parameters

```bash
# Option 1: Use the helper script to find and set automatically
./scripts/setup-cognito-params.sh <user-pool-id> <client-id>

# Option 2: Set manually if you know your values
aws ssm put-parameter \
  --name /oriole/cognito/user-pool-id \
  --value <your-pool-id> \
  --type String

aws ssm put-parameter \
  --name /oriole/cognito/user-pool-client-id \
  --value <your-client-id> \
  --type String
```

### 4. Deploy Infrastructure

```bash
# Set environment variables
export AWS_PROFILE=bobby
export CDK_DEFAULT_ACCOUNT=<your-account-id>
export CDK_DEFAULT_REGION=us-west-2

# Synth to preview
npm run synth

# Deploy (no parameters needed - reads from Parameter Store)
npm run deploy
```

### 5. Configure Agent IDs

After deployment completes, run the setup script to prepare agents and store their IDs:

```bash
./scripts/setup-agent-ids.sh
```

This script will:
- Extract agent and alias IDs from CDK outputs
- Store them in Parameter Store for easy lookup
- Prepare all Bedrock Agents for invocation

**What CDK automatically configured:**
- ✅ Bedrock Agents with inline action groups (move_north, move_south, move_east, move_west, recall_all)
- ✅ Lambda resource policy permissions for Bedrock to invoke action handlers
- ✅ IAM roles with proper Bedrock model access
- ✅ Agent aliases pointing to the latest version
- ✅ CDK outputs for all agent/alias IDs

**After setup script:**
- ✅ Agent IDs stored in Parameter Store
- ✅ All agents prepared and ready for invocation

## Running Experiments

### Trigger by Model Name (Recommended)

The simplest way to trigger experiments - no need to remember cryptic agent IDs:

```bash
# Basic usage
./scripts/trigger-by-name.sh <model-name> <maze-id> [prompt-version]

# Examples
./scripts/trigger-by-name.sh claude-3.5-haiku 1 v2
./scripts/trigger-by-name.sh nova-pro 3 v3-react-basic
./scripts/trigger-by-name.sh claude-3-haiku 5 v1
```

**Available models:**
- `claude-3.5-haiku`
- `claude-3-haiku`
- `nova-micro`
- `nova-lite`
- `nova-pro`
- `nova-premier`

The script automatically looks up agent/alias IDs from Parameter Store.

### Trigger with Agent IDs (Advanced)

If you need to specify exact agent/alias IDs:

```bash
./scripts/trigger-experiment.sh \
  <agent-id> \
  <agent-alias-id> \
  <model-name> \
  <maze-id> \
  [prompt-version]
```

### Ollama Experiments (Local LLMs)

Run experiments on local Ollama models with custom configuration:

```bash
# Basic usage with config (context, temperature, repeat_penalty)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 32768 0.2 1.4

# Small context window (2K)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 2048 0.2 1.4

# High creativity (temperature 0.7)
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 32768 0.7 1.4

# Run parameter sweep (12 experiments with varying configs)
./scripts/run-parameter-sweep.sh
```

**Configuration is atomic** - passed in the event message, not Parameter Store. This prevents race conditions during parameter sweeps.

See [docs/OLLAMA_INTEGRATION.md](docs/OLLAMA_INTEGRATION.md) for full setup and usage details.

### Trigger via AWS CLI (Advanced)

```bash
aws events put-events --entries '[{
  "Source": "oriole.experiments",
  "DetailType": "RunExperiment",
  "Detail": "{
    \"agentId\": \"ABCD1234\",
    \"agentAliasId\": \"EFGH5678\",
    \"modelName\": \"claude-3-5-haiku\",
    \"promptVersion\": \"v1\",
    \"mazeId\": 1,
    \"goalDescription\": \"Find the goal marker\",
    \"startX\": 2,
    \"startY\": 2
  }"
}]'
```

### Available Mazes

| ID | Name | Description |
|----|------|-------------|
| 1  | Sparse Maze | ~10% walls, very open |
| 2  | Light Maze | ~20% walls |
| 3  | Medium Maze | ~30% walls, balanced |
| 4  | Dense Maze | ~40% walls, tight corridors |
| 5  | Very Dense Maze | ~50% walls |
| 6  | Extreme Maze | ~60% walls, barely passable |
| 7  | Open Field | Scattered obstacles |
| 8  | Spiral | Circular navigation pattern |
| 9  | Rooms & Corridors | Large rooms connected by hallways |
| 10 | Multiple Paths | Multiple valid routes |
| 11 | Diagonal Bias | Diagonal wall lines |
| 12 | Random Scatter | Clustered obstacles |

## Viewing Results

### Viewer App

Access the viewer at the URL from CDK outputs:

```bash
# Get viewer URL
aws cloudformation describe-stacks \
  --stack-name OrioleStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ViewerApiUrl`].OutputValue' \
  --output text
```

Navigate to `/viewer` and enter an experiment ID to watch the replay.

### QuickSight

Connect QuickSight to the RDS Postgres instance to create dashboards:

Example queries:
- Success rate by model and maze
- Average moves to completion
- Token usage per experiment
- Most frequently used recall_all tool

### Direct Database Query

```bash
psql -h <rds-host> -U oriole_user -d oriole

# List experiments
SELECT id, model_name, maze_id, success
FROM experiments
ORDER BY id DESC
LIMIT 10;

# Get move count for an experiment
SELECT COUNT(*) as move_count
FROM agent_actions
WHERE experiment_id = 1;

# View an experiment's moves
SELECT step_number, action_type, from_x, from_y, to_x, to_y, success, reasoning
FROM agent_actions
WHERE experiment_id = 1
ORDER BY step_number;
```

## Prompts

Prompts are stored in AWS Systems Manager Parameter Store at `/oriole/prompts/v1`.

To add a new prompt version:

```bash
aws ssm put-parameter \
  --name /oriole/prompts/v2 \
  --value "Your new prompt text here..." \
  --type String
```

## Agent Capabilities

### Actions
- **move_north/south/east/west**: Navigate one step in the given direction
- **recall_all**: Query spatial memory of all seen tiles
  - **Cooldown**: Minimum 10 moves between recalls (configurable)
  - Prevents analysis paralysis loops

### Perception
- **Vision Range**: 3 blocks in each cardinal direction (configurable)
- **Line-of-Sight**: Walls block vision
- **Starting Knowledge**: Grid size (60x60), starting position

### Constraints
- No `getCurrentLocation` tool (agents must track position mentally)
- Walls block movement and vision
- Grid boundaries are hard limits
- **Max Moves**: 100 actions per experiment (configurable)
- **Max Duration**: 30 minutes per experiment (configurable)

## Data Model Glossary

Understanding the hierarchy of concepts in Oriole:

### Terminology

- **Experiment**: A complete maze navigation run from start to finish (or timeout/max moves). Tracked in the `experiments` table. Each experiment has:
  - One maze
  - One AI model
  - One prompt version
  - Start and end positions
  - Success/failure outcome
  - Aggregate metrics (tokens, cost, duration)

- **Turn**: One invocation of the Bedrock Agent (one call to `InvokeAgent` API). During a turn, the agent may:
  - Make multiple tool calls (steps)
  - Receive tool results
  - Internally reason about next actions (inferences)
  - Eventually respond or call more tools

  Tracked via `agent_actions.turn_number`. Useful for analyzing: "Does Model A make more tool calls per turn than Model B?"

- **Step**: One tool call (action). Examples:
  - `move_north`
  - `move_south`
  - `recall_all`

  Tracked as `agent_actions.step_number`. Each step records:
  - Action type
  - Success/failure
  - Position before/after
  - Tiles visible from new position
  - Agent's reasoning for this action

- **Inference**: Internal model forward pass(es) during an agent turn. Mostly opaque to us - happens inside Bedrock. We observe the *effects* (tool calls, responses) but not the internal reasoning process.

### Database Hierarchy

```
experiments (1)
  └─ turns (N) ← agent_actions.turn_number
      └─ steps (N) ← agent_actions.step_number
          └─ inferences (N, partially opaque)
```

### Example

An experiment might look like:
```
Experiment #42 (maze_id=3, model="claude-3-5-haiku")
  Turn 1:
    Step 1: move_north  (visible: 3 walls, 2 empty)
    Step 2: move_east   (visible: 1 wall, 4 empty)
  Turn 2:
    Step 3: move_north  (visible: goal tile!)
    Step 4: recall_all  (memory: 12 tiles seen)
  Turn 3:
    Step 5: move_west   (reached goal)
```

In this example:
- 1 experiment
- 3 turns (3 agent invocations)
- 5 steps (5 tool calls total)
- Unknown number of inferences (internal model reasoning)

### Querying by Turn

```sql
-- Average steps per turn by model
SELECT
  model_name,
  COUNT(*) as total_steps,
  COUNT(DISTINCT turn_number) as total_turns,
  ROUND(COUNT(*)::numeric / COUNT(DISTINCT turn_number), 2) as avg_steps_per_turn
FROM agent_actions aa
JOIN experiments e ON aa.experiment_id = e.id
GROUP BY model_name;

-- View all actions in a specific turn
SELECT step_number, action_type, success, reasoning
FROM agent_actions
WHERE experiment_id = 42 AND turn_number = 2
ORDER BY step_number;
```

## Runtime Configuration

These parameters can be changed without redeployment via AWS Systems Manager Parameter Store:

### Gameplay Parameters
```bash
# Vision range (how far agents can see)
aws ssm put-parameter --name /oriole/gameplay/vision-range \
  --value "3" --type String --overwrite

# Recall cooldown (minimum moves between recall_all calls)
aws ssm put-parameter --name /oriole/experiments/recall-interval \
  --value "10" --type String --overwrite
```

### Experiment Limits
```bash
# Maximum actions per experiment
aws ssm put-parameter --name /oriole/experiments/max-moves \
  --value "100" --type String --overwrite

# Maximum duration in minutes
aws ssm put-parameter --name /oriole/experiments/max-duration-minutes \
  --value "30" --type String --overwrite
```

### Rate Limiting (No Redeployment Required)

**IMPORTANT**: Rate limits prevent Bedrock API throttling. Adjust these based on your account's quotas.

```bash
# Claude 3.5 Haiku - Conservative 3 RPM (20-second waits)
# AWS quota is 10 RPM, but we use 30% to account for timing overhead
aws ssm put-parameter --name /oriole/models/claude-3-5-haiku/rate-limit-rpm \
  --value "3" --type String --overwrite

# Nova Lite - Adjust based on your quota
aws ssm put-parameter --name /oriole/models/nova-lite/rate-limit-rpm \
  --value "6" --type String --overwrite

# Add more models as needed
```

**How it works**:
- The system calculates `waitSeconds = 60 / rate-limit-rpm`
- Step Functions waits this duration between InvokeAgent calls
- SQS FIFO queue ensures only one experiment runs at a time
- Fail-fast approach: Any throttling error immediately fails the experiment

**Finding your rate limits**:
```bash
# Check Bedrock quotas for your account
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-west-2 \
  --query "Quotas[?contains(QuotaName, 'Haiku')]"
```

### Infrastructure Parameters (Require Redeployment)

These parameters are stored in Parameter Store but changes require running `npm run deploy`:

```bash
# Lambda timeouts (in seconds)
aws ssm put-parameter --name /oriole/lambda/default-timeout-seconds \
  --value "30" --type String --overwrite

aws ssm put-parameter --name /oriole/lambda/invoke-agent-timeout-seconds \
  --value "300" --type String --overwrite  # 5 minutes

# Action router concurrency (1 = serialize all tool calls within a turn)
# This prevents race conditions in position tracking
aws ssm put-parameter --name /oriole/lambda/action-router-concurrency \
  --value "1" --type String --overwrite
```

After changing any of these, redeploy with `npm run deploy`.

## Development

### Redeploying from Scratch

If you need to completely redeploy (new account, disaster recovery, etc.):

```bash
# 1. Deploy infrastructure
npm run deploy

# 2. Setup agent IDs and prepare agents
./scripts/setup-agent-ids.sh

# 3. Start running experiments
./scripts/trigger-by-name.sh claude-3.5-haiku 1 v2
```

That's it! The setup script handles:
- ✅ Extracting agent/alias IDs from CDK outputs
- ✅ Storing them in Parameter Store
- ✅ Preparing all Bedrock Agents
- ✅ Verifying everything is ready

### Adding New Models

1. Create new agent in `lib/oriole-stack.js`:

```javascript
const claude3OpusAgent = new BedrockAgentConstruct(this, 'Claude3OpusAgent', {
  agentName: 'oriole-claude-3-opus',
  modelId: 'anthropic.claude-3-opus-20240229-v1:0',
  instruction: '...',
  actionLambda: actionRouterLambda
});
```

2. Add CDK outputs for the agent ID and alias ID
3. Update `scripts/setup-agent-ids.sh` with the new model mapping
4. Update `scripts/trigger-by-name.sh` available models list
5. Deploy and run setup script

### Adding New Mazes

1. Edit `db/mazes/generator.js` to add new maze type
2. Run generator: `node db/mazes/generator.js`
3. Load into DB: `node db/mazes/load-mazes.js`

## Monitoring Experiments

### Preferred Method: Step Functions (Not Database)

The Step Functions execution state is the authoritative source for experiment progress. Database polling can be misleading due to async updates.

**Check running experiments:**
```bash
# List recent executions
aws stepfunctions list-executions \
  --state-machine-arn $(aws cloudformation describe-stacks --stack-name OrioleStack \
    --query 'Stacks[0].Outputs[?OutputKey==`StateMachineArn`].OutputValue' --output text) \
  --max-results 5

# Get detailed status
aws stepfunctions describe-execution --execution-arn <arn>

# View turn-by-turn history (see token counts, costs, positions)
aws stepfunctions get-execution-history --execution-arn <arn> --reverse-order
```

**What you can see in Step Functions history:**
- Current turn number
- Cumulative token usage and costs
- Agent's current position (X, Y)
- Time elapsed and moves taken
- Whether experiment will continue or stop

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for detailed monitoring workflows.

## Troubleshooting

**Token counts look wrong (growing exponentially)?**
- **Symptom:** Values like `cumulativeInputTokens: "137322612506"` instead of normal numbers
- **Cause:** JavaScript string concatenation bug (adding string + number = concatenation)
- **Check:** Look at Step Functions execution history for cumulative token values
- **Fix:** Ensure all numeric operations in check-progress.js use `Number()`, `parseInt()`, or `parseFloat()`
- See [docs/BEDROCK_AGENT_LEARNINGS.md](docs/BEDROCK_AGENT_LEARNINGS.md#javascript-type-coercion-bugs) for details

**Agent not invoking actions?**
- Check that action groups are configured in Bedrock console
- Verify Lambda permissions in IAM (especially SSM GetParameter for /oriole/gameplay/*)
- Check CloudWatch logs for the ActionRouterLambda
- Look for AccessDeniedException errors indicating missing IAM permissions

**DependencyFailedException from Bedrock Agent?**
- This usually means the action Lambda is throwing errors
- Check ActionRouterLambda CloudWatch logs for the root cause
- Common issues:
  - Missing SSM permissions for parameter lookups
  - Database connection failures
  - Missing environment variables

**Agent "teleporting" or position tracking broken?**
- Check `getCurrentPosition()` logic in `lambda/shared/db.js`
- Verify both `to_x/to_y` and `from_x/from_y` are checked
- Recall actions set `to_x/to_y` to NULL (agent doesn't move)

**Agent stuck calling recall_all repeatedly?**
- Check recall cooldown is enforced (should require 10 moves between recalls)
- Verify `/oriole/experiments/recall-interval` parameter exists
- Look at `agent_actions` table to count moves between recalls

**Step Function failing?**
- **FIRST:** Check execution history in Step Functions console (NOT database)
- Look for the error in the failed task's output
- Common errors:
  - **SyntaxError: "not valid JSON"** → Type coercion bug in check-progress.js
  - **ThrottlingException** → Reduce rate limit in Parameter Store
  - **AccessDeniedException** → Missing IAM permissions
- Check CloudWatch logs for the specific Lambda that failed
- Verify agent ID and alias ID are correct in trigger

**Experiments queuing but not starting?**
- Check SQS queue depth: `aws sqs get-queue-attributes --queue-url <queue-url>`
- Verify queue processor Lambda has permissions to start Step Functions
- Check CloudWatch logs for queue processor Lambda
- Ensure Lambda concurrency settings allow processing (check reservedConcurrentExecutions)

**EventBridge not triggering experiments?**
- Verify `--region us-west-2` flag is set in trigger script
- Use correct event source: `oriole.experiments` (not `oriole.manual`)
- Use correct detail type: `RunExperiment` (not `TriggerExperiment`)
- Check EventBridge rule is active: `aws events describe-rule --name <rule>`

**No data in database?**
- Verify RDS security group allows Lambda connections
- Check Lambda environment variables (DB_HOST, DB_PORT, etc.)
- Ensure `/oriole/db/password` parameter exists in SSM
- Test database connection manually

## Cost Optimization

- **Lambda**: ~$0.20 per 1M requests
- **Step Functions**: $0.025 per 1K state transitions
- **Bedrock**: Variable by model (check AWS pricing)
- **RDS**: Depends on instance type (using free tier initially)

## Future Enhancements

- [ ] Scheduled batch experiments
- [ ] Multi-agent comparison runs
- [ ] Custom maze builder UI
- [ ] Real-time experiment streaming
- [ ] Model fine-tuning based on results

## License

ISC

## Contributing

This is an experimental research project. Feel free to fork and adapt!
