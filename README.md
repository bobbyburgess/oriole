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

- **Bedrock Agents**: Claude models navigate mazes autonomously
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

### 3. Deploy Infrastructure

```bash
# Set environment variables
export AWS_PROFILE=bobby
export CDK_DEFAULT_ACCOUNT=<your-account-id>
export CDK_DEFAULT_REGION=us-west-2

# Synth to preview
npm run synth

# Deploy
npm run deploy \
  --parameters CognitoUserPoolId=<your-pool-id> \
  --parameters CognitoUserPoolClientId=<your-client-id>
```

### 4. Configure Bedrock Agent Action Groups

**Important**: Action groups must be added manually (CDK doesn't support this yet).

See [docs/BEDROCK_AGENT_SETUP.md](docs/BEDROCK_AGENT_SETUP.md) for detailed instructions.

Quick steps:
1. Navigate to Bedrock → Agents in AWS Console
2. Select `oriole-claude-35-sonnet`
3. Add Action Group with the OpenAPI schema from the docs
4. Point it to the ActionRouterLambda
5. Click "Prepare"

## Running Experiments

### Trigger via Script

```bash
./scripts/trigger-experiment.sh \
  <agent-id> \
  <agent-alias-id> \
  "claude-3-5-sonnet" \
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
    \"modelName\": \"claude-3-5-sonnet\",
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
SELECT id, model_name, maze_id, total_moves, success
FROM experiments
ORDER BY id DESC
LIMIT 10;

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

### Perception
- **Vision Range**: 3 blocks in each cardinal direction
- **Line-of-Sight**: Walls block vision
- **Starting Knowledge**: Grid size (60x60), starting position

### Constraints
- No `getCurrentLocation` tool (agents must track position mentally)
- Walls block movement and vision
- Grid boundaries are hard limits

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
- Verify Lambda permissions in IAM
- Check CloudWatch logs for the ActionRouterLambda

**Step Function failing?**
- Check execution history in Step Functions console
- Verify database connectivity from Lambda
- Ensure agent ID and alias ID are correct

**No data in database?**
- Verify RDS security group allows Lambda connections
- Check Lambda environment variables
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
