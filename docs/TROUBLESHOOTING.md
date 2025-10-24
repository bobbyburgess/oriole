# Oriole Troubleshooting Guide

## Monitoring Experiments

### Preferred Workflow: Use Step Functions & CloudWatch (NOT Database)

The Step Functions execution state is the source of truth for experiment progress. Direct database queries can be misleading due to async updates.

### 1. Trigger an Experiment

```bash
./scripts/trigger-experiment.sh <agent-id> <agent-alias-id> <model-name> <maze-id> [prompt-version]

# Example:
./scripts/trigger-experiment.sh PJZEQWQPBA F1RX42FBS2 claude-3-haiku 1 v1
```

### 2. Check Step Functions Status (Immediately, No Waiting)

**List recent executions:**
```bash
aws stepfunctions list-executions \
  --state-machine-arn arn:aws:states:us-west-2:864899863517:stateMachine:oriole-experiment-runner \
  --max-results 1
```

**Get execution status:**
```bash
aws stepfunctions describe-execution \
  --execution-arn <execution-arn> \
  --query '{status: status, startDate: startDate, stopDate: stopDate}'
```

### 3. View Detailed Execution History

**See turn-by-turn progress:**
```bash
aws stepfunctions get-execution-history \
  --execution-arn <execution-arn> \
  --max-results 100 \
  --reverse-order
```

**What you can see in the execution history:**
- `turnNumber`: Which turn the agent is on
- `cumulativeInputTokens`/`cumulativeOutputTokens`: Token usage
- `cumulativeCost`: Running cost in USD
- `totalMoves`: Actions taken (from agent_actions table count)
- `elapsedMinutes`: Time since experiment started
- `shouldContinue`: Whether experiment will continue
- `currentX`/`currentY`: Agent's current position
- `agentResponse`: What the agent said in each turn

**Key states to look for:**
- `InvokeAgent`: Calling the Bedrock Agent
- `CheckProgress`: Counting moves, checking termination conditions
- `RateLimitWait`: Enforcing rate limits (15s for 4 RPM)
- `ShouldContinue?`: Decision point (continue loop or finalize)

### 4. Check CloudWatch Logs for Errors

```bash
# InvokeAgent Lambda
aws logs tail /aws/lambda/OrioleStack-InvokeAgentFunctionAD5BFB56-n2hiHRIF3VPR --since 5m --format short

# CheckProgress Lambda
aws logs tail /aws/lambda/OrioleStack-CheckProgressFunction71CADFD2-pInvMMWSJ4yD --since 5m --format short

# Look for specific patterns
aws logs tail /aws/lambda/<function> --since 5m | grep -A 2 "ERROR\|cumulativeInputTokens"
```

## Common Issues

### Token Counts Look Wrong (String Concatenation Bug)

**Symptom:** In Step Functions state, you see values like:
- `cumulativeInputTokens`: `"137322612506"` (should be ~13K)
- Growing exponentially each turn

**Root Cause:** JavaScript type coercion - adding a string to a number results in string concatenation:
```javascript
// WRONG:
const total = dbValue + newTokens;  // If dbValue is "1373", result is "13732809"

// RIGHT:
const total = parseInt(dbValue || 0) + Number(newTokens);
```

**Fix Location:** `lambda/orchestration/check-progress.js` - ensure ALL numeric operations use explicit `Number()`, `parseInt()`, or `parseFloat()`.

### Experiment Starts But No Actions Appear

**Check:**
1. Step Functions execution status - is it RUNNING or FAILED?
2. If FAILED, check the `error` and `cause` fields
3. Common causes:
   - JSON parsing errors (Payload as object vs string)
   - Agent permissions issues
   - Database connection failures

### Rate Limiting / Throttling

**Expected behavior with current architecture:**
- `reservedConcurrentExecutions: 1` on InvokeAgentLambda serializes ALL agent invocations
- SQS FIFO queue with `MessageGroupId: "all-experiments"` serializes experiment starts
- 15-second wait between agent turns for 4 RPM rate limit

**If seeing throttling errors:**
- Check Lambda concurrency: `aws lambda get-function-concurrency --function-name <name>`
- Check SQS queue depth: `aws sqs get-queue-attributes --queue-url <url>`
- Verify rate limit in Parameter Store: `/oriole/models/<model>/rate-limit-rpm`

#### Deep Dive: Debugging Rate Limit Failures

**Key Insight:** Rate limits apply to *individual Bedrock API calls*, not just orchestration turns. A single turn can make 6-20 Bedrock API calls (one per tool invocation), so the wait time between turns may be insufficient.

**Complete Debugging Workflow:**

**Step 1: Get the error details from Step Functions**
```bash
AWS_PROFILE=bobby aws stepfunctions describe-execution \
  --execution-arn "arn:aws:states:us-west-2:864899863517:execution:oriole-experiment-runner:..." \
  --query '{status: status, error: error, cause: cause}' \
  --output json
```

This shows you **what** failed (e.g., `ThrottlingException`) and **why** (e.g., "Your request rate is too high").

**Step 2: View the execution timeline**
```bash
AWS_PROFILE=bobby aws stepfunctions get-execution-history \
  --execution-arn "arn:..." \
  --max-results 50 \
  --query 'events[*].{id: id, type: type, timestamp: timestamp}' \
  --output json | jq -r '.[] | "\(.id) | \(.timestamp) | \(.type)"' | tail -20
```

This shows you **when** things happened. Look for patterns like:
- Turn 1: `TaskStateEntered` → `TaskSucceeded` (success)
- Turn 2: `TaskStateEntered` → `TaskFailed` (throttled immediately)
- Calculate time delta between turn 1 completion and turn 2 start

**Step 3: Check CloudWatch Logs for internal API call timing**
```bash
AWS_PROFILE=bobby aws logs tail /aws/lambda/OrioleStack-InvokeAgentFunctionAD5BFB56-n2hiHRIF3VPR \
  --since 2h --format short | grep -i "experiment.*<id>"
```

Look for `[TIMING]` markers to see individual tool calls:
```
21:47:24 - Tool call: /recall_all (chunk 4, elapsed 6910ms)
21:47:29 - Tool call: /move_east (chunk 9, elapsed 12054ms)
21:47:33 - Tool call: /move_west (chunk 14, elapsed 16016ms)
...
21:47:59 - ERROR: ThrottlingException
```

**Step 4: Correlate with database actions**
```bash
PGPASSWORD='...' psql -h continuum-prod1... -U oriole_user -p 5432 -d oriole \
  -c "SELECT turn_number, COUNT(*) as actions_in_turn
      FROM agent_actions
      WHERE experiment_id = <id>
      GROUP BY turn_number
      ORDER BY turn_number;"
```

This shows how many successful actions were logged before the throttle.

**Step 5: Calculate rate limit consumption**
```bash
AWS_PROFILE=bobby aws ssm get-parameter \
  --name /oriole/models/claude-3-haiku/rate-limit-rpm \
  --query 'Parameter.Value' \
  --output text
```

**Example Analysis (Experiment 96):**
- **Rate limit**: 4 RPM = 15 seconds between *each API call*
- **Turn 1 duration**: 39 seconds (7 tool calls = 7 Bedrock API calls)
- **Wait time before turn 2**: Only 3 seconds
- **Result**: Turn 2 immediately throttled because turn 1 consumed the quota

**The Problem:** The wait time is applied *between orchestration turns*, but each turn makes multiple Bedrock API calls. At 4 RPM, you need ~15 seconds between each individual Bedrock invocation, not just between turns.

**Solutions:**
1. **Increase RPM quota** with AWS (if available)
2. **Add per-action delays** within a turn (not just between turns)
3. **Reduce agent verbosity** to minimize tool calls per turn
4. **Use prompt engineering** to encourage fewer, more strategic actions

## Timings & Performance Rules

- **Never wait >10 seconds** in monitoring scripts
- Use `--max-results` to limit output size
- Step Functions history can be large - use `--reverse-order` for recent events
- Rate limit wait: `60 / rate_limit_rpm` seconds (e.g., 15s for 4 RPM)

## Data Flow

```
EventBridge → SQS FIFO Queue → QueueProcessor Lambda → Step Functions
                                                              ↓
                                                      StartExperiment
                                                              ↓
                                                      ┌──────────────┐
                                                      │ InvokeAgent  │
                                                      └──────┬───────┘
                                                             │
                                                      ┌──────▼───────┐
                                                      │CheckProgress │
                                                      └──────┬───────┘
                                                             │
                                                      ┌──────▼────────┐
                                                      │ShouldContinue?│
                                                      └──┬────────┬───┘
                                            Continue ───┘        └─── Stop
                                               (loop back)    (Finalize)
```

## Agent Configuration

Agent and alias IDs are stored in Parameter Store:
```bash
aws ssm get-parameters-by-path --path "/oriole/models/claude-3-haiku" --recursive
```

To update:
```bash
aws ssm put-parameter \
  --name "/oriole/models/claude-3-haiku/agent-id" \
  --value "NEWAGENTID" \
  --type "String" \
  --overwrite
```

## Useful Queries

**Count events by type:**
```bash
aws stepfunctions get-execution-history --execution-arn <arn> | \
  jq '.events | group_by(.type) | map({type: .[0].type, count: length})'
```

**Extract all agent responses:**
```bash
aws stepfunctions get-execution-history --execution-arn <arn> | \
  jq '.events[] | select(.type == "TaskSucceeded" and .taskSucceededEventDetails.resource == "invoke") |
      .taskSucceededEventDetails.output | fromjson | .Payload.agentResponse' -r
```

**See current state without full history:**
```bash
aws stepfunctions describe-execution --execution-arn <arn> | \
  jq '{status, input: .input | fromjson, startDate, stopDate}'
```
