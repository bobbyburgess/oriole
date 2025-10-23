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
EventBridge → Step Functions → Bedrock Agent
                    ↓
          [Start | Invoke | Finalize]
                    ↓
              RDS Postgres ← Action Lambdas (move, recall)
                    ↓
         QuickSight + Viewer App
```

### Components

- **Bedrock Agents**: Claude 3.5 Haiku (cheapest tool-using model) navigates mazes autonomously
- **Action Groups**: Lambda functions handling `move_north`, `move_south`, `move_east`, `move_west`, `recall_all`
- **Step Functions**: Orchestrate experiment lifecycle
- **RDS Postgres**: Store all moves, reasoning, and metrics
- **Viewer App**: Web UI to replay experiments step-by-step
- **QuickSight**: Analytics dashboards for model comparison

## Project Structure

```
oriole/
├── bin/                    # CDK app entry point
├── lib/                    # CDK stack definitions
├── lambda/
│   ├── actions/           # Bedrock agent action handlers
│   ├── orchestration/     # Experiment lifecycle management
│   ├── viewer/            # Web UI Lambda
│   └── shared/            # DB and vision utilities
├── db/
│   ├── migrations/        # SQL schema
│   └── mazes/             # Maze generators and data
├── scripts/               # Helper scripts
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

### 5. Configure Bedrock Agent Action Groups

**Option A: Automated (AWS CLI)**

```bash
# Get outputs from deployment
AGENT_ID=$(aws cloudformation describe-stacks --stack-name OrioleStack \
  --query 'Stacks[0].Outputs[?OutputKey==`Claude35AgentId`].OutputValue' --output text)

LAMBDA_ARN=$(aws cloudformation describe-stacks --stack-name OrioleStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ActionRouterLambdaArn`].OutputValue' --output text)

# Run setup script
./scripts/setup-agent-actions.sh "$AGENT_ID" "$LAMBDA_ARN"
```

**Option B: Manual (AWS Console)**

See [docs/BEDROCK_AGENT_SETUP.md](docs/BEDROCK_AGENT_SETUP.md) for step-by-step console instructions.

## Running Experiments

### Trigger via Script

```bash
./scripts/trigger-experiment.sh \
  <agent-id> \
  <agent-alias-id> \
  "claude-3-5-haiku" \
  1
```

### Trigger via AWS CLI

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

### Infrastructure Parameters (Require Redeployment)

These parameters are stored in Parameter Store but changes require running `npm run deploy`:

```bash
# Lambda timeouts (in seconds)
aws ssm put-parameter --name /oriole/lambda/default-timeout-seconds \
  --value "30" --type String --overwrite

aws ssm put-parameter --name /oriole/lambda/invoke-agent-timeout-seconds \
  --value "300" --type String --overwrite  # 5 minutes

# Action router concurrency (1 = serialize all tool calls)
aws ssm put-parameter --name /oriole/lambda/action-router-concurrency \
  --value "1" --type String --overwrite

# Step Functions retry configuration
aws ssm put-parameter --name /oriole/orchestration/retry-interval-seconds \
  --value "6" --type String --overwrite

aws ssm put-parameter --name /oriole/orchestration/retry-max-attempts \
  --value "3" --type String --overwrite

aws ssm put-parameter --name /oriole/orchestration/retry-backoff-rate \
  --value "2.0" --type String --overwrite
```

After changing any of these, redeploy with `npm run deploy`.

## Development

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

2. Deploy and configure action groups

### Adding New Mazes

1. Edit `db/mazes/generator.js` to add new maze type
2. Run generator: `node db/mazes/generator.js`
3. Load into DB: `node db/mazes/load-mazes.js`

## Troubleshooting

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
- Check execution history in Step Functions console
- Verify database connectivity from Lambda
- Ensure agent ID and alias ID are correct
- Check for rate limiting (Bedrock Haiku has ~10 req/min limit)

**EventBridge not triggering experiments?**
- Verify `--region us-west-2` flag is set in trigger script
- Check EventBridge rule is active
- Verify state machine ARN is correct

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
