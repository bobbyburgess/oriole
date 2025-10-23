# Oriole CLI Cheatsheet

Quick reference for monitoring and managing experiments from the command line.

## Setup

First, load environment variables from `.env`:

```bash
# Load environment variables
source <(sed 's/^/export /' .env)

# Or add to your ~/.bashrc or ~/.zshrc:
set -a
source /Users/bobbyburgess/Documents/code/oriole/.env
set +a
```

This makes commands much shorter and keeps credentials out of your shell history.

## Monitoring Running Experiments

### Quick Status Check

```bash
# Check progress of experiment #41
psql -c "SELECT COUNT(*) as steps, MAX(turn_number) as turns,
         SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
         SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) as failed
         FROM agent_actions WHERE experiment_id = 41;"
```

### Auto-Refreshing Status (Watch Mode)

```bash
# Updates every 5 seconds
watch -n 5 "psql -t -c \"SELECT COUNT(*) || ' steps, turn ' || MAX(turn_number) || ', ' ||
            SUM(CASE WHEN success THEN 1 ELSE 0 END) || ' ok, ' ||
            SUM(CASE WHEN NOT success THEN 1 ELSE 0 END) || ' fail'
            FROM agent_actions WHERE experiment_id = 41;\""
```

Press `Ctrl+C` to exit watch mode.

### View Last 5 Actions

```bash
# See recent moves
psql -c "SELECT step_number, turn_number, action_type,
         from_x || ',' || from_y as from_pos,
         CASE WHEN to_x IS NOT NULL THEN to_x || ',' || to_y ELSE '[no move]' END as to_pos,
         success
         FROM agent_actions
         WHERE experiment_id = 41
         ORDER BY step_number DESC LIMIT 5;"
```

### View Last 5 Actions with Reasoning

```bash
psql -c "SELECT step_number, turn_number, action_type, success,
         LEFT(reasoning, 60) as reasoning
         FROM agent_actions
         WHERE experiment_id = 41
         ORDER BY step_number DESC LIMIT 5;"
```

## Step Functions Status

### Check Execution Status

```bash
# List recent executions
aws stepfunctions list-executions \
  --state-machine-arn $STEP_FUNCTIONS_ARN \
  --max-items 5 \
  --query 'executions[*].[name,status,startDate]' \
  --output table

# Check specific execution (replace EXECUTION_ARN)
aws stepfunctions describe-execution \
  --execution-arn "EXECUTION_ARN" \
  --query '[status,startDate,stopDate]' \
  --output table
```

## Finding Experiment IDs

### Get Latest Experiment

```bash
psql -c "SELECT id, model_name, maze_id, started_at
         FROM experiments
         ORDER BY id DESC LIMIT 5;"
```

### Find Running Experiments

```bash
psql -c "SELECT id, model_name, started_at
         FROM experiments
         WHERE completed_at IS NULL
         ORDER BY id DESC;"
```

## Triggering Experiments

### Trigger New Experiment

```bash
# Trigger experiment (Haiku on maze 1 with prompt v2)
./scripts/trigger-experiment.sh \
  $CLAUDE_HAIKU_AGENT_ID \
  $CLAUDE_HAIKU_ALIAS_ID \
  claude-3-5-haiku 1 v2
```

## Quick Reference: Agent IDs

Agent IDs are stored in `.env` as environment variables:

```bash
# View all agent IDs
echo "Claude Haiku: $CLAUDE_HAIKU_AGENT_ID / $CLAUDE_HAIKU_ALIAS_ID"
echo "Nova Lite: $NOVA_LITE_AGENT_ID"
echo "Nova Micro: $NOVA_MICRO_AGENT_ID"
echo "Nova Pro: $NOVA_PRO_AGENT_ID"
echo "Nova Premier: $NOVA_PREMIER_AGENT_ID"
```

## Using Different Models

```bash
# Nova Lite on maze 3
./scripts/trigger-experiment.sh \
  $NOVA_LITE_AGENT_ID \
  $(aws bedrock-agent list-agent-aliases --agent-id $NOVA_LITE_AGENT_ID --query 'agentAliasSummaries[0].agentAliasId' --output text) \
  nova-lite 3 v2

# Nova Pro on maze 1
./scripts/trigger-experiment.sh \
  $NOVA_PRO_AGENT_ID \
  $(aws bedrock-agent list-agent-aliases --agent-id $NOVA_PRO_AGENT_ID --query 'agentAliasSummaries[0].agentAliasId' --output text) \
  nova-pro 1 v2
```
