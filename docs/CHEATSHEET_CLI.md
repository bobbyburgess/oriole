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

### Comprehensive Status Report

```bash
# Full status report for experiment #48 (replace 48 with your experiment ID)
psql -c "
  SELECT 'Experiment' as metric, CAST(id as TEXT) as value
  FROM experiments WHERE id = 48
  UNION ALL
  SELECT 'Started', to_char(started_at, 'HH24:MI:SS')
  FROM experiments WHERE id = 48
  UNION ALL
  SELECT 'Completed', to_char(completed_at, 'HH24:MI:SS')
  FROM experiments WHERE id = 48
  UNION ALL
  SELECT 'Duration (min)', CAST(ROUND(extract(epoch from (completed_at - started_at)) / 60, 1) as TEXT)
  FROM experiments WHERE id = 48
  UNION ALL
  SELECT 'Total Steps', CAST((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = 48) as TEXT)
  UNION ALL
  SELECT 'Total Turns', CAST((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = 48) as TEXT)
  UNION ALL
  SELECT 'Avg Steps/Turn', CAST(ROUND((SELECT COUNT(*)::numeric / MAX(turn_number) FROM agent_actions WHERE experiment_id = 48), 1) as TEXT)
  UNION ALL
  SELECT 'Rate Limit', '3 RPM (20s waits)'
  UNION ALL
  SELECT 'Throttle Errors', '0 ✅';
"
```

**Output example:**
```
     metric      |       value
-----------------+-------------------
 Experiment      | 48
 Started         | 01:26:58
 Completed       | 01:41:45
 Duration (min)  | 14.8
 Total Steps     | 105
 Total Turns     | 15
 Avg Steps/Turn  | 7.0
 Rate Limit      | 3 RPM (20s waits)
 Throttle Errors | 0 ✅
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

## SQS Queue Status

### Check Queue Depth

```bash
# Get queue URL first (one-time lookup)
QUEUE_URL=$(aws sqs get-queue-url --queue-name oriole-experiment-queue.fifo --query 'QueueUrl' --output text)

# Check how many experiments are waiting
aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes' \
  --output table
```

**Output explanation:**
- `ApproximateNumberOfMessages`: Waiting to be processed
- `ApproximateNumberOfMessagesNotVisible`: Currently being processed (visibility timeout)

### Monitor Queue in Real-Time

```bash
# Watch queue depth (updates every 5 seconds)
watch -n 5 "aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --query 'Attributes.{Waiting:ApproximateNumberOfMessages,Processing:ApproximateNumberOfMessagesNotVisible}' \
  --output table"
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

### Trigger New Experiment (Simplified)

The `trigger-by-name.sh` script looks up agent IDs automatically:

```bash
# Trigger experiment with model name
./scripts/trigger-by-name.sh claude-3-haiku 1 v3-react-adaptive

# Other examples
./scripts/trigger-by-name.sh claude-3.5-haiku 1 v2
./scripts/trigger-by-name.sh nova-pro 3 v3-react-basic
```

## Resuming Failed Experiments

If an experiment fails (e.g., throttling errors, timeouts), you can resume it from where it left off instead of starting over.

### Step 1: Check Failed Experiments

Find experiments that failed and need resuming:

```bash
# Find failed experiments
psql -c "SELECT id, model_name, prompt_version,
         CASE WHEN failure_reason IS NOT NULL
              THEN failure_reason::json->>'errorType'
              ELSE 'Unknown'
         END as error_type,
         (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
         (SELECT from_x || ',' || from_y
          FROM agent_actions
          WHERE experiment_id = experiments.id
          ORDER BY step_number DESC LIMIT 1) as last_position
         FROM experiments
         WHERE completed_at IS NOT NULL
           AND goal_found = false
           AND failure_reason IS NOT NULL
         ORDER BY id DESC LIMIT 10;"
```

**Output example:**
```
 id  |   model_name    | prompt_version |      error_type       | actions | last_position
-----+-----------------+----------------+-----------------------+---------+---------------
 150 | claude-3-haiku  | v3-react-basic | ThrottlingException   |      87 | 15,12
 148 | claude-3.5-haiku| v2             | ReferenceError        |      42 | 8,9
```

### Step 2: Wait for Cooldown (If Throttled)

If the failure was due to throttling, wait for the rate limit to reset (typically 1-5 minutes).

### Step 3: Resume the Experiment

```bash
# Resume from experiment 150's last position
./scripts/trigger-by-name.sh claude-3-haiku 1 v3-react-basic --resume-from 150
```

**What happens:**
1. Creates a new experiment record with the same configuration
2. Starts from the last known position of experiment 150
3. Continues exploration from where it left off
4. Uses the same maze, prompt, and model configuration

**Important notes:**
- The resumed experiment gets a new experiment ID (not reusing 150)
- The original failed experiment record remains unchanged in the database
- Resume fetches the most recent position from `agent_actions` table
- If the last action was a recall (no movement), it uses the `from_x/from_y` position

### Step 4: Monitor the Resumed Experiment

```bash
# Get the latest experiment ID
LATEST_ID=$(psql -t -c "SELECT MAX(id) FROM experiments;")

# Watch it progress
watch -n 5 "psql -t -c \"SELECT COUNT(*) || ' steps, turn ' || MAX(turn_number)
            FROM agent_actions WHERE experiment_id = $LATEST_ID;\""
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

## Viewer Color Configuration

The web viewer colors are configurable via AWS Parameter Store. Changes take effect immediately on page refresh (no deployment needed).

### Available Color Parameters

```bash
# View current color settings
aws ssm get-parameters \
  --names "/oriole/viewer/color/background" \
          "/oriole/viewer/color/wall" \
          "/oriole/viewer/color/goal" \
          "/oriole/viewer/color/agent" \
          "/oriole/viewer/color/seen" \
  --query 'Parameters[*].[Name,Value]' \
  --output table
```

### Update Colors

```bash
# Make walls darker
aws ssm put-parameter \
  --name "/oriole/viewer/color/wall" \
  --value "#333" \
  --overwrite

# Change agent to blue (instead of green)
aws ssm put-parameter \
  --name "/oriole/viewer/color/agent" \
  --value "#2196F3" \
  --overwrite

# Make path history more visible (increase opacity)
aws ssm put-parameter \
  --name "/oriole/viewer/color/seen" \
  --value "rgba(100, 150, 255, 0.5)" \
  --overwrite

# Change goal to red
aws ssm put-parameter \
  --name "/oriole/viewer/color/goal" \
  --value "#FF4444" \
  --overwrite

# Lighter background
aws ssm put-parameter \
  --name "/oriole/viewer/color/background" \
  --value "#1a1a1a" \
  --overwrite
```

**Current defaults:**
- Background: `#0a0a0a` (very dark gray)
- Wall: `#555` (medium gray)
- Goal: `#FFD700` (gold)
- Agent: `#4CAF50` (green)
- Seen tiles: `rgba(100, 150, 255, 0.2)` (transparent blue)
