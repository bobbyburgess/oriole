# AWS Bedrock Agent Learnings & Technical Deep Dive

Technical insights, behavioral observations, and hard-won lessons from building a stateless orchestration system for Bedrock Agents.

---

## Table of Contents
1. [Stateless Orchestration Architecture](#stateless-orchestration-architecture)
2. [Position Tracking Pitfalls](#position-tracking-pitfalls)
3. [Bedrock Agent Behavior Patterns](#bedrock-agent-behavior-patterns)
4. [Error Handling & Debugging](#error-handling--debugging)
5. [Rate Limiting & Performance](#rate-limiting--performance)
6. [Configuration Management](#configuration-management)
7. [Cost Optimization](#cost-optimization)
8. [Best Practices](#best-practices)

---

## Stateless Orchestration Architecture

### The Core Challenge

**Bedrock Agents don't preserve spatial state between invocations.**

Even though `sessionId` provides conversation continuity (the agent remembers tool results and can reference them), the agent has **no inherent memory of its position in the maze**. This creates a fundamental architectural challenge:

> How do you maintain state across multiple agent invocations when the agent itself is stateless?

### Our Solution: Database as Source of Truth + Queue Serialization

**High-level flow:**
```
EventBridge → SQS FIFO Queue → Queue Processor → Step Functions → Bedrock Agent
   (trigger)    (serializes)      (one at a time)   (orchestrates)      (acts)
                                                           ↓
                                                      Action Lambdas
                                                           ↓
                                                      RDS Postgres
                                                  (source of truth)
```

**Within each Step Functions execution:**
```
┌─────────────────────────────────────────────────────────┐
│  Step Functions Orchestration Loop (per experiment)      │
│                                                          │
│  1. check-progress → fetch currentX/currentY from DB     │
│  2. wait 20s       → rate limit delay (3 RPM)            │
│  3. invoke-agent   → pass position in prompt             │
│  4. Agent executes → tools log actions to DB             │
│  5. check-progress → fetch UPDATED position from DB      │
│  6. Loop back to step 2 (wait + invoke)                  │
└─────────────────────────────────────────────────────────┘
```

**Key Insights:**

1. **Position must be explicitly provided in every prompt**
   - Can't rely on agent memory: "You are at position (X, Y)"
   - Must be fetched fresh from DB after each iteration

2. **Session ID provides tool result continuity**
   - Agent remembers "I called move_north and saw a wall"
   - Agent doesn't remember "I'm now at (3, 5)"
   - Position is data, not conversation context

3. **Database is the single source of truth**
   - Every action updates position in `agent_actions` table
   - `getCurrentPosition()` reads most recent action
   - State machine passes position forward between steps

### Why This Architecture?

**Alternative Approaches Considered:**

❌ **Store position in Step Functions state only**
- Problem: No audit trail
- Problem: Lost on retry/failure
- Problem: Can't analyze experiments after completion

❌ **Let agent track position implicitly**
- Problem: Agents don't have this capability
- Problem: Would require perfect mental map maintenance
- Problem: No way to verify correctness

✅ **Database + explicit position passing**
- Audit trail in `agent_actions` table
- Recoverable from failures
- Can replay experiments
- Can verify position correctness
- Enables debugging "teleporting" bugs

---

## Position Tracking Pitfalls

### The "Teleporting Agent" Bug

**Symptom:** Agent would suddenly jump back to start position (2, 2) after calling `recall_all`.

**Root Cause:**
```javascript
// BROKEN CODE (original implementation)
async function getCurrentPosition(experimentId) {
  const result = await db.query(
    `SELECT to_x, to_y FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number DESC
     LIMIT 1`,
    [experimentId]
  );

  if (result.rows.length > 0) {
    return { x: result.rows[0].to_x, y: result.rows[0].to_y };
  }

  // Fallback to start position
  return { x: experiment.start_x, y: experiment.start_y };
}
```

**Why it failed:**
1. Movement actions (move_north, etc.) populate `to_x` and `to_y`
2. Non-movement actions (recall_all) set `to_x` and `to_y` to **NULL** (agent didn't move)
3. When reading position after recall_all, `to_x/to_y` are NULL
4. Code falls through to start position fallback
5. Agent "teleports" back to (2, 2)

**The Fix:**
```javascript
// FIXED CODE
async function getCurrentPosition(experimentId) {
  const result = await db.query(
    `SELECT to_x, to_y, from_x, from_y FROM agent_actions
     WHERE experiment_id = $1
     ORDER BY step_number DESC
     LIMIT 1`,
    [experimentId]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];

    // If to_x/to_y exist (movement action), use them
    if (row.to_x !== null && row.to_y !== null) {
      return { x: row.to_x, y: row.to_y };
    }

    // Otherwise use from_x/from_y (non-movement action stayed in place)
    if (row.from_x !== null && row.from_y !== null) {
      return { x: row.from_x, y: row.from_y };
    }
  }

  // Only fallback to start if no actions exist
  const experiment = await getExperiment(experimentId);
  return { x: experiment.start_x, y: experiment.start_y };
}
```

**Lesson:** When designing state tracking, **consider all action types**, not just the common case.

### Action Schema Design

Our `agent_actions` table schema captures movement semantics:

```sql
CREATE TABLE agent_actions (
  from_x INT NOT NULL,     -- Where agent was before action
  from_y INT NOT NULL,
  to_x INT,                -- Where agent is after action (NULL if didn't move)
  to_y INT,
  action_type VARCHAR(50), -- 'move_north', 'recall_all', etc.
  success BOOLEAN,         -- Did the action succeed?
  ...
);
```

**Why this works:**
- Movement actions: `from_x/y` = old position, `to_x/y` = new position
- Non-movement actions: `from_x/y` = current position, `to_x/y` = NULL
- Failed movements: `from_x/y` and `to_x/y` are the same (stayed in place)

---

## Bedrock Agent Behavior Patterns

### Analysis Paralysis: The Recall Loop Problem

**Observed Behavior:**

Without intervention, agents would call `recall_all` repeatedly:

```
Step 1: recall_all (see 15 tiles)
Step 2: recall_all (see same 15 tiles)
Step 3: recall_all (see same 15 tiles)
Step 4: recall_all (see same 15 tiles)
Step 5: recall_all (see same 15 tiles)
Step 6: recall_all (see same 15 tiles)
```

The agent would "think" for 6-10 turns without actually exploring!

**Why this happens:**
1. Agent prompt emphasizes "think carefully"
2. Agent has access to memory tool
3. Agent gets stuck in planning/analysis mode
4. Doesn't realize it needs NEW information (via movement)

**Solution: Enforced Cooldown**

```javascript
// Count MOVEMENT actions since last recall
const movesSinceRecall = await db.query(`
  SELECT COUNT(*) FROM agent_actions
  WHERE experiment_id = $1
    AND step_number > $2
    AND action_type LIKE 'move_%'
`, [experimentId, lastRecallStep]);

if (movesSinceRecall < RECALL_INTERVAL) {
  return {
    error: "Recall cooldown active. Make 7 more moves before recalling."
  };
}
```

**Parameters:**
- Recall interval: 10 moves (configurable via `/oriole/experiments/recall-interval`)
- First recall always allowed
- Only counts MOVEMENT actions (not other recalls)

**Impact:**
- Experiment 15 (before fix): 6 consecutive recalls, minimal exploration
- Experiment 17 (after fix): 2 recalls across 104 actions, good exploration pattern

### Prompt Engineering Insights

**What Works:**

✅ **Explicit position in every iteration**
```
Your Current Position: (12, 5)
```

✅ **Grid coordinate system explanation**
```
North = negative Y, South = positive Y
East = positive X, West = negative X
```

✅ **Actionable guidance**
```
Use your vision and continue exploring!
```

✅ **Parameter passing reminder**
```
When you call any action, always include experimentId=16 in your request.
```

**What Doesn't Work:**

❌ **Expecting positional awareness from conversation**
```
"Remember where you are and navigate carefully"
```
(Agent has no spatial memory without explicit prompting)

❌ **Vague instructions**
```
"Explore efficiently"
```
(Too abstract - agents need concrete action guidance)

❌ **Overemphasizing thinking**
```
"Think very carefully about each move"
```
(Leads to analysis paralysis)

### Tool Usage Patterns

**Observed agent behavior:**

1. **Initial recall pattern**
   - Almost always calls `recall_all` first
   - Even when memory is empty (start of experiment)
   - Seems to be establishing baseline

2. **Exploration strategy**
   - Generally tries systematic sweep (left-to-right or up-down)
   - When hitting walls, tends to backtrack rather than try alternate routes
   - Does NOT implement perfect maze-solving algorithms (depth-first search, etc.)

3. **Failed move handling**
   - When a move fails (wall), often tries same direction again
   - Doesn't always learn from failed moves
   - Sometimes gets stuck in "bounce" patterns (north-south-north-south)

---

## Error Handling & Debugging

### Fail-Fast Philosophy: No Retries, Ever

**Core principle:** This codebase does **NOT** retry anything. All errors fail immediately.

**Why no retries?**

1. **Rate limits are deterministic, not transient**
   - ThrottlingException means you're over quota
   - Retrying won't help - you'll just hit the limit again
   - Better to fail fast and fix the rate limit configuration

2. **Retries mask configuration problems**
   - If something works "eventually" via retries, the root cause stays hidden
   - You won't know if your rate limits are too aggressive
   - Flaky behavior becomes normalized

3. **Deterministic behavior is paramount**
   - User explicitly requested: "i don't want my app depending on fast/slow aws is running"
   - Either the configuration is correct (works every time) or it's wrong (fails every time)
   - No "sometimes works, sometimes doesn't"

**Where retries were removed:**

❌ **Step Functions InvokeAgent task** - No retry configuration at all
```javascript
// No addRetry() calls, no retryOnServiceExceptions
const invokeAgentStep = new tasks.LambdaInvoke(this, 'InvokeAgent', {
  lambdaFunction: invokeAgentLambda,
  resultPath: '$.agentResult'
  // Fails immediately on any error
});
```

❌ **Queue Processor Lambda** - No try/catch masking errors
```javascript
// If StartExecutionCommand fails, Lambda fails
// SQS message goes back to queue after visibility timeout
const result = await sfnClient.send(command);
```

❌ **Invoke-Agent Lambda** - Throws errors instead of returning them
```javascript
} catch (error) {
  console.error('Error invoking agent:', error);
  throw error;  // ← Fail fast, propagate to Step Functions
}
```

**Result:** Zero tolerance for rate limiting errors. If you see a ThrottlingException, reduce the rate limit parameter immediately.

### DependencyFailedException: The Generic Error

**What you see:**
```javascript
DependencyFailedException: Received failed response from API execution
```

**What it actually means:**
"One of your action Lambdas threw an error."

This is Bedrock Agent's generic error wrapper. The **actual** error is buried in the action Lambda's CloudWatch logs.

### Common Failure Modes

#### 1. AccessDeniedException in Action Lambda

**Symptom:** Agent invokes, immediately fails with DependencyFailedException

**Root cause:** IAM permissions missing

**Example from our project:**
```
AccessDeniedException: User is not authorized to perform: ssm:GetParameter
on resource: arn:aws:ssm:...:parameter/oriole/gameplay/vision-range
```

**Fix:** Add SSM permissions to Lambda role:
```javascript
lambdaRole.addToPolicy(new iam.PolicyStatement({
  actions: ['ssm:GetParameter'],
  resources: [
    `arn:aws:ssm:${region}:${account}:parameter/oriole/gameplay/*`
  ]
}));
```

#### 2. Bedrock Agent Can't Find Action Group

**Symptom:** Agent responds with text instead of calling tools

**Root cause:** Action group not properly configured

**How to verify:**
```bash
aws bedrock-agent get-agent --agent-id AGENT_ID --region us-west-2
```

Check `actionGroups` field - should show your Lambda ARN.

#### 3. Lambda Invocation Permissions

**Symptom:** Action group configured but tools not being called

**Root cause:** Bedrock doesn't have permission to invoke Lambda

**Fix:**
```bash
aws lambda add-permission \
  --function-name ActionRouterFunction \
  --statement-id AllowBedrockAgent \
  --action lambda:InvokeFunction \
  --principal bedrock.amazonaws.com
```

### Debugging Workflow

**Step 1: Check Step Functions execution**
```bash
aws stepfunctions describe-execution \
  --execution-arn "arn:..." \
  --region us-west-2
```

**Step 2: Check invoke-agent Lambda logs**
```bash
aws logs tail /aws/lambda/InvokeAgentFunction \
  --since 30m --region us-west-2
```

Look for `DependencyFailedException` errors.

**Step 3: Check action router Lambda logs**
```bash
aws logs tail /aws/lambda/ActionRouterFunction \
  --since 30m --region us-west-2
```

This shows the **actual** error (AccessDeniedException, database errors, etc.)

**Step 4: Check database state**
```sql
-- How many actions were logged?
SELECT COUNT(*) FROM agent_actions WHERE experiment_id = X;

-- What was the last action?
SELECT * FROM agent_actions
WHERE experiment_id = X
ORDER BY step_number DESC LIMIT 1;

-- Position tracking working?
SELECT step_number, action_type, from_x, from_y, to_x, to_y
FROM agent_actions
WHERE experiment_id = X
ORDER BY step_number;
```

---

## Rate Limiting & Performance

### Bedrock Rate Limits

**Default quota:** 10 requests per minute (RPM) for Claude 3.5 Haiku

This is a **hard limit** - requests beyond this receive `ThrottlingException` errors immediately.

### The Rate Limiting Problem

**Challenge:** AWS Bedrock rate limits are applied **account-wide** per model. Multiple concurrent experiments would compete for the same quota, causing unpredictable throttling.

**Initial naive approach:**
- Multiple experiments running concurrently
- Retry logic attempting to handle throttling
- Unpredictable behavior depending on "how fast AWS is running"

**Why retries don't work:**
- Rate limits are deterministic, not transient failures
- Retries mask the underlying issue (too many concurrent requests)
- Experiments become dependent on timing luck

### Our Solution: Queue-Based Serialization

**Architecture:**
```
EventBridge → SQS FIFO Queue → Queue Processor Lambda → Step Functions
              (serializes)        (one at a time)         (rate limited)
```

**Key components:**

1. **SQS FIFO Queue with Static MessageGroupId**
   - All experiments use MessageGroupId = "all-experiments"
   - FIFO + same MessageGroupId = strict serialization
   - Only ONE experiment runs at a time globally
   - Prevents concurrent API calls to Bedrock

2. **Calculated Wait Times (No Retries)**
   - Conservative rate: 3 RPM (30% of AWS quota)
   - Calculated wait: `waitSeconds = 60 / rate-limit-rpm` = 20 seconds
   - Step Functions waits between InvokeAgent calls
   - Accounts for execution overhead and timing jitter

3. **Fail-Fast Approach**
   - **NO retries** anywhere in the system
   - ThrottlingException immediately fails the experiment
   - Makes rate limiting issues visible instantly
   - No masking of configuration problems

**Rate limit parameters stored in Parameter Store:**
```bash
# Conservative 3 RPM (uses only 30% of AWS quota)
/oriole/models/claude-3-5-haiku/rate-limit-rpm = "3"
```

**Why 30% of quota instead of 100%?**
- Execution overhead (each InvokeAgent call takes 2-4 seconds)
- Network timing jitter
- Clock synchronization variance
- Better safe than sorry - zero throttling is the goal

### Timeout Configuration

```javascript
const invokeAgentTimeoutMinutes = 5;
```

**Why 5 minutes?**

- Agent may call multiple tools per invocation
- Each tool call needs database round-trip
- Recall_all can be slow with large memory
- Vision calculation involves SSM parameter lookup
- Network latency to Bedrock + RDS adds up

**Observed performance:**
- Simple move: 2-4 seconds
- Recall with 50+ tiles seen: 5-8 seconds
- Move + vision calculation: 3-6 seconds

### Throughput Optimization

**Current design:** Fully serialized execution (one experiment at a time, globally)

```
Experiment A → Complete → Experiment B → Complete → ...
  ├─ Turn 1 → Wait 20s
  ├─ Turn 2 → Wait 20s
  └─ Turn 3 → ...
```

**Why fully serialized?**
1. **Experiment-level:** One experiment at a time (SQS FIFO queue)
2. **Turn-level:** One turn at a time within experiment (sequential Step Functions)
3. **Action-level:** One action at a time within turn (Lambda concurrency = 1)

**Why not parallel?**
- Each iteration depends on previous position
- Can't invoke agent with stale position
- Database writes must complete before next read
- Rate limits prevent concurrent agent invocations anyway

**Actual throughput with 3 RPM:**
- 3 agent invocations per minute
- 100 max moves (turns) per experiment
- Minimum ~33 minutes per experiment (100 / 3 = 33.3 minutes)
- Realistic: 35-40 minutes including overhead

**Trade-offs:**
- ✅ Zero throttling errors
- ✅ Deterministic behavior
- ✅ Predictable experiment duration
- ❌ Slower than theoretical maximum (if we used full 10 RPM)
- ❌ Experiments must queue behind each other

---

## Configuration Management

### The Two-Tier Configuration Pattern

We use two distinct configuration approaches:

#### Tier 1: Infrastructure (CDK Hardcoded)

**Location:** `lib/oriole-stack.js`

**Parameters:**
- Lambda timeouts
- Step Functions retry intervals
- Maximum attempts
- Backoff rates

**Why hardcoded?**

CDK's `valueForStringParameter()` and `valueFromLookup()` don't work well for these:

1. `valueForStringParameter()` returns CloudFormation tokens (not actual values)
2. Can't use tokens in `Duration.seconds()` - needs literal numbers
3. `valueFromLookup()` requires context, adds complexity
4. These values rarely change (infrastructure stability)

**Example:**
```javascript
const retryIntervalSeconds = 6;  // Hardcoded
timeout: cdk.Duration.seconds(retryIntervalSeconds)
```

#### Tier 2: Runtime (Parameter Store)

**Location:** AWS Systems Manager Parameter Store

**Parameters:**
- `/oriole/gameplay/vision-range` (default: 3)
- `/oriole/experiments/recall-interval` (default: 10)
- `/oriole/experiments/max-moves` (default: 100)
- `/oriole/experiments/max-duration-minutes` (default: 30)

**Why Parameter Store?**

1. **No redeployment needed** - change immediately
2. **A/B testing** - easily compare different values
3. **Difficulty tuning** - adjust gameplay on the fly
4. **Cost efficiency** - tune for cost vs quality

**Implementation pattern:**
```javascript
// Module-level caching
let cachedVisionRange = null;

async function getVisionRange() {
  if (cachedVisionRange !== null) {
    return cachedVisionRange;  // Reuse across warm invocations
  }

  const response = await ssmClient.send(new GetParameterCommand({
    Name: '/oriole/gameplay/vision-range'
  }));

  cachedVisionRange = parseInt(response.Parameter.Value);
  return cachedVisionRange;
}
```

**Cold start cost:** ~100ms SSM lookup
**Warm invocation cost:** 0ms (cached)

### Parameter Tuning Guide

**Vision Range:**
- Lower (1-2): Harder, forces more exploration
- Medium (3-4): Balanced
- Higher (5+): Easier, can plan longer paths

**Recall Interval:**
- Lower (5-7): More memory access, less exploration forced
- Medium (8-12): Balanced
- Higher (15+): More exploration, less planning

**Max Moves:**
- Lower (50): Quick experiments, may not complete
- Medium (100): Good for testing
- Higher (200+): Allows full maze exploration

**Trade-offs:**
- Vision ↑ + Recall ↓ = Agent can "see" more but "remember" less frequently
- Vision ↓ + Recall ↑ = Agent must build strong memory, but can access it often

---

## Cost Optimization

### Current Costs (Claude 3.5 Haiku)

**Per experiment (100 moves):**
- Bedrock: ~$0.0001 - $0.001 (depends on thinking time)
- Lambda: ~$0.000001 (negligible)
- Step Functions: ~$0.002 (100 state transitions)
- RDS: Fixed monthly cost, not per-experiment

**Total: < $0.01 per experiment**

### Cost Reduction Strategies

**1. Choose cheapest tool-using model**

We switched from Claude 3 Opus to Claude 3.5 Haiku:
- Opus: ~$0.01 per experiment
- Haiku: ~$0.001 per experiment
- **90% cost reduction**

**2. Optimize max moves**

Experiments that hit max moves still cost money:
- Set appropriate limits based on maze complexity
- Sparse mazes: 50-75 moves sufficient
- Dense mazes: 100-150 moves needed

**3. Recall cooldown**

Without cooldown:
- Agents waste moves on repeated recalls
- Each recall = action = cost
- 6 wasted recalls per experiment adds up

With cooldown:
- Force exploration between recalls
- Get value from each action
- Reduce total actions needed

**4. Vision range optimization**

Higher vision = fewer moves needed (agent can see further ahead)
- Vision 5: ~60 avg moves to completion
- Vision 3: ~80 avg moves to completion
- Vision 1: ~120 avg moves to completion

Trade-off: Higher vision may reduce learning value for AI research

---

## Best Practices

### 1. Always Log Actions with Full Context

```javascript
await db.logAction(
  experimentId,
  stepNumber,
  actionType,
  reasoning,        // Agent's reasoning (valuable for debugging!)
  fromX, fromY,     // Starting position
  toX, toY,         // Ending position (NULL for non-movement)
  success,          // Did action succeed?
  tilesSeenJSON,    // Vision data (enables replay)
  tokensUsed        // Cost tracking
);
```

**Why this matters:**
- Can replay entire experiment from database
- Can debug "why did agent choose this move?"
- Can analyze patterns (does agent always turn right?)
- Can build training datasets

### 2. Handle NULL Gracefully

```javascript
// BAD: Assumes to_x/to_y always exist
const position = { x: row.to_x, y: row.to_y };

// GOOD: Handles all action types
const position = row.to_x !== null
  ? { x: row.to_x, y: row.to_y }
  : { x: row.from_x, y: row.from_y };
```

### 3. Use Module-Level Caching

```javascript
let cachedDbPassword = null;
let cachedVisionRange = null;

// Lambda containers are reused (warm starts)
// Cache expensive lookups across invocations
```

**Impact:**
- First invocation: ~100ms SSM lookup
- Next 100 invocations: 0ms (cached)
- Significant cost savings

### 4. Make Functions Async When Needed

```javascript
// Before: Synchronous, couldn't fetch parameters
function calculateVision(grid, x, y) {
  const visionRange = 3;  // Hardcoded
  // ...
}

// After: Async, fetches from Parameter Store
async function calculateVision(grid, x, y) {
  const visionRange = await getVisionRange();  // Dynamic
  // ...
}
```

**Don't forget to update callers:**
```javascript
// Must add await!
const visible = await vision.calculateVision(grid, x, y);
```

### 5. Comprehensive Error Messages

```javascript
// BAD
throw new Error("Invalid recall");

// GOOD
return {
  statusCode: 400,
  body: JSON.stringify({
    error: `Recall cooldown active. You must make ${remaining} more movement actions before calling recall_all again. Use your vision and continue exploring!`,
    movesSinceLastRecall: moveCount,
    movesRequired: recallInterval
  })
};
```

Agents can read error messages and adjust behavior!

### 6. Verify IAM Permissions Thoroughly

**Required permissions checklist:**

- ✅ Lambda → Bedrock (InvokeAgent)
- ✅ Lambda → SSM (GetParameter for all param paths)
- ✅ Lambda → RDS (network access via security group)
- ✅ Lambda → CloudWatch Logs (AWSLambdaBasicExecutionRole)
- ✅ Bedrock → Lambda (bedrock.amazonaws.com principal)
- ✅ Step Functions → Lambda (states.amazonaws.com principal)
- ✅ EventBridge → Step Functions (events.amazonaws.com principal)

**Test with:**
```bash
# Dry-run invocation
aws lambda invoke \
  --function-name ActionRouterFunction \
  --payload '{"test": true}' \
  --region us-west-2 \
  output.json
```

### 7. Comment Complex Logic

Especially for position tracking, state management, and edge cases:

```javascript
// Historical bug: Originally only checked to_x/to_y, causing agent to "teleport"
// back to start position after recall_all actions set them to NULL
if (row.to_x !== null && row.to_y !== null) {
  return { x: row.to_x, y: row.to_y };
}
```

Future you (and teammates) will thank you!

---

## Appendix: Key Files Reference

### State Management
- `lambda/shared/db.js::getCurrentPosition()` - Position tracking logic
- `lambda/orchestration/check-progress.js` - Loop control and position passing

### Rate Limiting & Queuing
- `lib/oriole-stack.js` - SQS FIFO queue definition and rate limit configuration
- `lambda/orchestration/queue-processor.js` - Bridges SQS to Step Functions (serialization)
- Parameter Store: `/oriole/models/*/rate-limit-rpm` - Per-model rate limits

### Configuration
- `lib/oriole-stack.js` - Infrastructure constants (hardcoded)
- `lambda/shared/vision.js::getVisionRange()` - Runtime parameter lookup pattern
- `lambda/actions/recall_all.js::getRecallInterval()` - Runtime cooldown config

### Bedrock Integration
- `lambda/orchestration/invoke-agent.js` - Bedrock Agent invocation (fail-fast error handling)
- `lambda/actions/router.js` - Action group routing
- `lib/bedrock-agent-construct.js` - CDK agent definition

### Debugging
- CloudWatch Logs: `/aws/lambda/QueueProcessorFunction` - Experiment queue processing
- CloudWatch Logs: `/aws/lambda/ActionRouterFunction` - Action handler errors
- CloudWatch Logs: `/aws/lambda/InvokeAgentFunction` - Bedrock invocation errors
- Step Functions: Execution history shows which step failed
- Database: `agent_actions` table - full action history
- SQS Console: Queue depth and message attributes

---

## Final Thoughts

Building a stateless orchestration system for Bedrock Agents taught us:

1. **Explicit state management is critical** - Don't rely on agent memory for position
2. **Tool cooldowns prevent pathological behavior** - Agents need guardrails
3. **Runtime configuration enables rapid iteration** - Parameter Store > hardcoding
4. **Error messages matter** - Agents read them and adjust
5. **Always plan for NULL** - Non-movement actions are easy to forget
6. **Database is your debug tool** - Log everything, analyze later
7. **Rate limiting requires serialization** - Queue experiments, don't retry throttling errors
8. **Fail-fast > retry logic** - Deterministic behavior reveals configuration issues immediately
9. **Use 30% of quota, not 100%** - Execution overhead and timing jitter are real

Most importantly: **Bedrock Agents are powerful but require careful architectural design**. They're not "drop-in" AI - they need infrastructure that respects their stateless nature, stays within rate limits, and provides the guardrails they can't provide themselves.

The biggest lesson? **Don't fight AWS rate limits with retries**. Embrace them with deterministic configuration and queue-based serialization. Your experiments will be slower but infinitely more reliable.

---

**Document Version:** 2.0
**Last Updated:** 2025-10-23
**Author:** Claude Code Session (Debugging & Implementation)
**Major Changes in v2.0:**
- Added SQS FIFO queue architecture for experiment serialization
- Documented fail-fast approach (no retries)
- Updated rate limiting strategy (3 RPM conservative approach)
- Added queue processor Lambda documentation
