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
8. [Nova Model Compatibility Issues](#nova-model-compatibility-issues)
9. [Bedrock Agent Versioning & Deployment](#bedrock-agent-versioning--deployment)
10. [Model Comparisons & Selection](#model-comparisons--selection)
11. [JavaScript Type Coercion Bugs](#javascript-type-coercion-bugs)
12. [Two-Level Prompting Architecture](#two-level-prompting-architecture)
13. [Lambda Concurrency for Serialization](#lambda-concurrency-for-serialization)
14. [Best Practices](#best-practices)

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

## Nova Model Compatibility Issues

### The Problem: Nova Models + Bedrock Agents = Incompatible

**Symptom:** Nova models (nova-micro, nova-lite, nova-pro) fail immediately when used with Bedrock Agents orchestration.

**Error observed:**
```
DependencyFailedException: model timeout/error exception from Bedrock
Failure code: 424
Duration: ~1000ms (fails after exactly 1 second)
```

**What's happening:**
```
Bedrock Agent Event Trace:
1. modelInvocationInput sent with temperature=0.0 ✅
2. Followed immediately by failureTrace after 1008ms ❌
3. failureCode: 424 (Dependency Failed)
```

### Root Cause: Orchestration Prompt Format

Nova models have **specific requirements for tool calling**:
1. Must use temperature = 0.0 (greedy decoding)
2. Tool schemas must be in Converse API format
3. Incompatible with Bedrock Agents' orchestration prompt structure

**Proof that Nova works:**
```python
# Direct Converse API call with Nova Micro - SUCCESS
response = client.converse(
    modelId="us.amazon.nova-micro-v1:0",
    messages=[{"role": "user", "content": [{"text": "What's the weather?"}]}],
    toolConfig={
        "tools": [{
            "toolSpec": {
                "name": "get_weather",
                "description": "Get weather for a location",
                "inputSchema": {"json": {...}}
            }
        }]
    },
    inferenceConfig={"maxTokens": 1000, "temperature": 0}
)
# Returns: stopReason="tool_use" ✅
```

The issue is **NOT** with Nova's tool calling capability - it's with how Bedrock Agents formats its orchestration prompts.

### Attempted Solutions That Didn't Work

#### 1. Prompt Override Configuration
```javascript
promptOverrideConfiguration: {
  promptCreationMode: 'OVERRIDDEN',
  basePromptTemplate: customPrompt,
  inferenceConfiguration: {
    temperature: 0,
    maximumLength: 2048,
    topP: 1,
    topK: 250
  }
}
```

**Result:** Still failed with 424 after 1 second. Bedrock Agents adds orchestration wrapper that Nova can't parse.

#### 2. Different Prompt Creation Modes
- `DEFAULT`: AWS orchestration (failed)
- `OVERRIDDEN`: Custom prompt (failed)

**Result:** Mode doesn't matter - the underlying Bedrock Agents format is incompatible.

### The Solution: Use Converse API Directly

For Nova models, **bypass Bedrock Agents entirely** and use Converse API:

```javascript
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

// Define tools in Converse API format
const toolConfig = {
  tools: [
    {
      toolSpec: {
        name: "move_north",
        description: "Move one step north",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              reasoning: { type: "string" }
            }
          }
        }
      }
    }
    // ... more tools
  ]
};

// Conversation loop
while (!complete && turnCount < maxTurns) {
  const response = await bedrockClient.send(new ConverseCommand({
    modelId: "us.amazon.nova-micro-v1:0",
    messages,
    toolConfig,
    inferenceConfig: { maxTokens: 2048, temperature: 0 }
  }));

  if (response.stopReason === 'tool_use') {
    // Execute tools, add results to messages
    // Continue loop
  } else if (response.stopReason === 'end_turn') {
    complete = true;
  }
}
```

**Pros:**
- ✅ Nova models work perfectly
- ✅ Direct control over conversation flow
- ✅ Full token usage tracking
- ✅ Works with any Bedrock model

**Cons:**
- ❌ Hits rate limits quickly (8-15 turns before ThrottlingException)
- ❌ Tight loop within single Lambda invocation
- ❌ Must implement tool routing yourself
- ❌ Loses Bedrock Agents' managed orchestration

### Architectural Trade-Off: Converse API vs Bedrock Agents

| Feature | Bedrock Agents | Converse API |
|---------|---------------|--------------|
| **Nova Compatibility** | ❌ Fails with 424 | ✅ Works perfectly |
| **Rate Limiting** | ✅ Natural spacing via Step Functions | ❌ Tight loop hits limits |
| **Multi-Tool Burst Protection** | ✅ Handles internally (one API call) | ❌ Each tool call = separate API call |
| **Turn Structure** | ✅ One turn per Lambda invocation | ❌ Multiple turns in one invocation |
| **Tool Routing** | ✅ Managed action groups | ❌ Must implement yourself |
| **Token Tracking** | ⚠️ Via event traces | ✅ Direct from response |
| **Setup Complexity** | ⚠️ Console/CLI config needed | ✅ Pure code |

### The Critical Advantage: Multi-Tool Call Bursts

**The problem with Converse API:**

When an agent decides to call multiple tools in sequence, each is a separate API call:

```javascript
// Converse API approach - Multiple API calls
Turn 1:
  ConverseCommand call 1 → model says "call move_north"
  Execute move_north
  ConverseCommand call 2 → model says "call recall_all"
  Execute recall_all
  ConverseCommand call 3 → model says "call move_east"
  ... 8-9 rapid calls → ThrottlingException ❌
```

**How Bedrock Agents solves this:**

```javascript
// Bedrock Agents approach - ONE API call per turn
Turn 1 (single InvokeAgent call):
  1. Model decides → call move_north
  2. Execute move_north Lambda
  3. Model processes result → call recall_all
  4. Execute recall_all Lambda
  5. Model processes result → call move_east
  ... 13 tool calls in one turn
  6. Model decides to end turn

Duration: ~13 seconds (all internal to Bedrock)
Rate limit impact: 1 API call ✅
```

**Real example from experiment 73:**
- **Turn 1:** 13 tool calls in one InvokeAgent call
- **Turn 2:** 6 tool calls in one InvokeAgent call
- **No throttling!** Because we only made 2 Bedrock API calls total

**The key insight:**

Our rate limit (6 RPM = 10 seconds between turns) controls the time between **turns**, not between individual tool calls. Bedrock's internal orchestration handles multiple tool invocations within a turn without exposing them as separate API calls.

**Alternative solutions (without Bedrock Agents):**

If you use Converse API directly, you'd need to implement:

1. **Token bucket rate limiter** on the client side
   - Track API calls per minute
   - Block new calls when approaching limit
   - Complex state management

2. **Exponential backoff with retries**
   - Catch ThrottlingException
   - Wait increasingly longer periods
   - Unreliable and slow

3. **Queue tool calls with artificial delays**
   - Add 1-2 second delay between each ConverseCommand
   - Very slow (13 tool calls = 13-26 seconds just in delays)
   - Wasteful when under limit

4. **Accept throttling and abandon turn**
   - Let it fail, retry the whole turn later
   - Wasted tokens and time
   - Poor user experience

**None of these are as elegant as Bedrock Agents' approach.** This is arguably the single biggest architectural benefit of using Bedrock Agents over direct Converse API.

**Design Philosophy: Proactive vs Reactive Rate Limiting**

All the alternatives above share a fatal flaw: **they rely on hitting rate limits and reacting to them**. This violates a core design principle:

> **Never design a system that depends on hitting limits and adjusting.**

Why this matters:

- **Reactive approaches are non-deterministic**: Sometimes work, sometimes fail, depending on timing
- **Can't predict experiment duration**: Will it take 10 minutes or 30 minutes? Depends on throttling luck
- **Error handling becomes business logic**: Catching exceptions shouldn't be part of normal operation
- **Wastes resources**: Failed API calls cost tokens and time
- **Unreliable for production**: Users can't trust the system

**Bedrock Agents enables proactive design:**

- Calculate safe rate limit (6 RPM for 10 RPM AWS limit)
- Wait 10 seconds between turns (deterministic)
- Agent makes as many tool calls as it wants per turn (unpredictable)
- **Never hit the limit** because we control turn frequency, not tool frequency
- **Predictable behavior**: Every experiment behaves the same way
- **Production-ready**: Reliable, deterministic, trustworthy

This is the difference between "hope it works and retry if it doesn't" versus "design it to never fail in the first place."

### Recommendation

**For Claude models:** Use Bedrock Agents
- **Critical:** Handles multi-tool bursts automatically
- Better rate limit handling
- Managed orchestration
- Natural pacing prevents throttling
- **Worth the setup complexity**

**For Nova models:** Accept they don't work well for this use case
- Poor spatial reasoning (loops, no mental map)
- Would require Converse API (loses burst protection)
- Not worth the architectural complexity

### Nova Spatial Reasoning Results

**Experiment:** Nova Micro with working Converse API implementation (experiment ID 66)

**Result:** 77 actions, agent stuck in loop

**Observed behavior:**
```
Visited positions: (1,2) → (2,2) → (1,3) → (2,3) → (1,4)
Then loops back:    (1,2) → (2,2) → (1,3) → (2,3) → (1,4)
Then again:         (1,2) → (2,2) → (1,3) → (2,3) → (1,4)
```

**Reasoning paradox:**
```
Step 15: "avoid repeating the same path" → moves to (1,2)
Step 16: "continue exploring" → moves to (2,2) [already visited]
Step 17: "explore new areas" → moves to (1,3) [already visited]
```

**Analysis:** Nova Micro can call tools but lacks spatial reasoning. No mental map building despite having access to recall_all.

---

## Bedrock Agent Versioning & Deployment

### CDK Inline Action Groups (Recommended Approach)

**As of CDK v2.220+, action groups can be defined inline in the agent configuration:**

```javascript
const agent = new bedrock.CfnAgent(this, 'Agent', {
  agentName: 'my-agent',
  agentResourceRoleArn: role.roleArn,
  foundationModel: 'anthropic.claude-3-haiku-20240307-v1:0',
  instruction: 'You are a helpful assistant...',
  actionGroups: [
    {
      actionGroupName: 'my-actions',
      actionGroupExecutor: {
        lambda: actionLambda.functionArn
      },
      apiSchema: {
        payload: JSON.stringify(openApiSchema)
      },
      actionGroupState: 'ENABLED'
    }
  ]
});

// CRITICAL: Add Lambda resource policy permission
actionLambda.addPermission(`AllowBedrockAgent-${id}`, {
  principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
  action: 'lambda:InvokeFunction',
  sourceArn: `arn:aws:bedrock:${region}:${account}:agent/${agent.attrAgentId}`
});
```

**Benefits:**
- ✅ Zero manual configuration steps
- ✅ Action groups deployed atomically with agent
- ✅ No configuration drift
- ✅ Full infrastructure-as-code
- ✅ Version controlled OpenAPI schemas

**Two permissions required:**
1. **IAM role permission**: `actionLambda.grantInvoke(agentRole)` - allows the agent's IAM role to invoke Lambda
2. **Lambda resource policy**: `actionLambda.addPermission(...)` - allows Bedrock service to invoke the Lambda

Both are necessary! The resource policy is scoped to the specific agent ARN for security.

### Understanding Agent Versions (Legacy Approach)

AWS Bedrock Agents use a two-tier system:

**DRAFT:**
- Active development version
- Where you add/modify action groups
- Where you update prompts and configuration
- NOT accessible via aliases
- Cannot be invoked in production

**Numbered Versions (1, 2, 3, ...):**
- Immutable snapshots created from DRAFT
- What aliases point to
- What you invoke in production
- Created automatically when you create an alias
- Cannot be modified after creation

**Aliases:**
- Named pointers (e.g., "prod", "test")
- Route to specific numbered versions
- Can be updated to point to different versions
- **Cannot point to DRAFT**

### The Version Creation Problem

**Challenge:** There is NO CLI command to create a version from DRAFT.

**Available commands:**
```bash
aws bedrock-agent list-agent-versions       # List existing versions
aws bedrock-agent get-agent-version         # Get version details
aws bedrock-agent delete-agent-version      # Delete a version
aws bedrock-agent create-agent-version      # ❌ DOES NOT EXIST
```

**Why this is problematic:**
1. CDK creates agent and initial alias (points to version 1)
2. You add action groups via CLI to DRAFT
3. Action groups are in DRAFT, but alias points to version 1 (no action groups)
4. Agent doesn't call tools because alias isn't using DRAFT
5. Can't update alias to point to DRAFT (not allowed)
6. Can't create version 2 from DRAFT (no command)

### The Workaround: Create Temporary Alias

**Solution:** Creating a new alias automatically creates a numbered version from DRAFT.

**Step-by-step:**

```bash
# 1. Agent starts at version 1 (created by CDK)
aws bedrock-agent list-agent-versions --agent-id AGENT_ID
# Output: version 1 (PREPARED)

# 2. Add action groups to DRAFT
./scripts/setup-agent-actions.sh AGENT_ID LAMBDA_ARN

# 3. Prepare DRAFT (packages latest changes)
aws bedrock-agent prepare-agent --agent-id AGENT_ID

# 4. Create temporary alias - this creates version 2 from DRAFT!
aws bedrock-agent create-agent-alias \
  --agent-id AGENT_ID \
  --agent-alias-name temp \
  --description "Temporary alias to create version 2"

# 5. Verify version 2 was created
aws bedrock-agent list-agent-versions --agent-id AGENT_ID
# Output: version 1, version 2 (PREPARED)

# 6. Update prod alias to use version 2
aws bedrock-agent update-agent-alias \
  --agent-id AGENT_ID \
  --agent-alias-id PROD_ALIAS_ID \
  --agent-alias-name prod \
  --routing-configuration agentVersion=2

# 7. Delete temporary alias (optional)
aws bedrock-agent delete-agent-alias \
  --agent-id AGENT_ID \
  --agent-alias-id TEMP_ALIAS_ID
```

### Common Pitfalls

#### 1. Alias Points to Old Version

**Symptom:** Agent doesn't call tools, or uses old prompt/configuration

**Diagnosis:**
```bash
aws bedrock-agent get-agent-alias \
  --agent-id AGENT_ID \
  --agent-alias-id ALIAS_ID \
  --query 'agentAlias.routingConfiguration'
```

**Fix:** Update alias to point to newer version (see workaround above)

#### 2. Action Groups on Wrong Version

**Symptom:** `list-agent-action-groups` shows empty for your version

**Check DRAFT:**
```bash
aws bedrock-agent list-agent-action-groups \
  --agent-id AGENT_ID \
  --agent-version DRAFT
```

**Check numbered version:**
```bash
aws bedrock-agent list-agent-action-groups \
  --agent-id AGENT_ID \
  --agent-version 2
```

**Fix:** If action groups only in DRAFT, create new version (see workaround)

#### 3. Lambda Permission Missing for New Agent

**Symptom:**
```
DependencyFailedException: Access denied while invoking Lambda function
```

**Check permissions:**
```bash
aws lambda get-policy --function-name ACTION_ROUTER_LAMBDA
```

**Fix:**
```bash
aws lambda add-permission \
  --function-name ACTION_ROUTER_LAMBDA \
  --statement-id AllowBedrockAgent-AGENT_NAME \
  --action lambda:InvokeFunction \
  --principal bedrock.amazonaws.com \
  --source-arn "arn:aws:bedrock:REGION:ACCOUNT:agent/AGENT_ID"
```

### Best Practices for Agent Versioning

1. **Always prepare-agent before creating versions**
   ```bash
   aws bedrock-agent prepare-agent --agent-id AGENT_ID
   ```

2. **Verify action groups are in DRAFT before versioning**
   ```bash
   aws bedrock-agent list-agent-action-groups \
     --agent-id AGENT_ID \
     --agent-version DRAFT
   ```

3. **Document version history**
   ```bash
   # version 1: Initial setup, no action groups
   # version 2: Added maze navigation action groups
   # version 3: Updated prompt for better spatial reasoning
   ```

4. **Keep temp aliases for debugging**
   - Don't delete immediately
   - Can test new versions before updating prod

5. **Check alias routing after updates**
   ```bash
   aws bedrock-agent get-agent-alias --agent-id AGENT_ID --agent-alias-id ALIAS_ID \
     | jq '.agentAlias.routingConfiguration'
   ```

---

## Model Comparisons & Selection

### Cost per 1000 Maze Steps

Based on actual token usage from experiments:

| Model | Input per Mtok | Output per Mtok | Cost per 1000 Steps | Relative Cost |
|-------|----------------|-----------------|---------------------|---------------|
| Claude 3.5 Sonnet | $3.00 | $15.00 | ~$3.36 | 15x |
| Claude 3.5 Haiku | $0.80 | $4.00 | ~$0.90 | 4x |
| **Claude 3 Haiku** | **$0.25** | **$1.25** | **~$0.22** | **1x** ✅ |
| Nova Micro | $0.035 | $0.14 | N/A | ❌ Poor reasoning |
| Nova Lite | $0.06 | $0.24 | N/A | ❌ Untested |
| Nova Pro | $0.80 | $3.20 | N/A | ❌ Untested |

**Calculation example (Claude 3 Haiku):**
- Average per action: ~1,500 input tokens, 150 output tokens
- Input cost: (1,500 / 1,000,000) × $0.25 = $0.000375
- Output cost: (150 / 1,000,000) × $1.25 = $0.0001875
- Total per action: ~$0.00056
- Per 1000 actions: ~$0.22

### Rate Limit Configurations

| Model | AWS Limit (RPM) | Configured Limit | Wait Between Turns |
|-------|----------------|------------------|-------------------|
| Claude 3.5 Haiku | 10 | 6 (60%) | 10 seconds |
| Claude 3 Haiku | 10 | 8 (80%) | 7.5 seconds |
| Nova Micro | Unknown | 9 | 6.7 seconds |
| Nova Lite | Unknown | 9 | 6.7 seconds |
| Nova Pro | Unknown | 9 | 6.7 seconds |

**Why not 100% of AWS limit?**
- Execution overhead (2-4 seconds per call)
- Network timing jitter
- Clock synchronization variance
- Better to never hit limits than squeeze maximum throughput

**Finding your rate limits:**
```bash
aws service-quotas list-service-quotas \
  --service-code bedrock \
  --region us-west-2 \
  --query "Quotas[?contains(QuotaName, 'Claude 3 Haiku')]"
```

### Spatial Reasoning Comparison

From actual experiments:

**Claude 3.5 Sonnet (Experiment 67):**
- 8 actions before ThrottlingException
- Intelligent exploration: straight line east from (2,1) to (6,1)
- Purposeful navigation with clear strategy
- **Verdict:** ✅ Excellent but expensive and hits rate limits

**Claude 3 Haiku (Experiment 72):**
- 17 actions (ongoing)
- Systematic exploration with recall_all first
- Successful navigation with sensible backtracking
- Cost so far: $0.0019 (~11 cents per 1000 steps)
- **Verdict:** ✅ Best balance of cost and capability

**Nova Micro (Experiment 66):**
- 77 actions, got stuck in loop
- Visited same 5 positions repeatedly
- Reasoning says "avoid repeating" then repeats immediately
- No mental map building
- **Verdict:** ❌ Poor spatial reasoning despite tool calling working

### Model Selection Guide

**For production/large-scale experiments:**
→ **Claude 3 Haiku**
- 3-4x cheaper than Haiku 3.5
- Good spatial reasoning
- Works with Bedrock Agents (no rate limit issues)
- 8 RPM configured rate

**For highest quality results:**
→ **Claude 3.5 Sonnet** (with throttle workarounds)
- Best reasoning capability
- Requires 6 RPM rate limit (10s between turns)
- 15x cost vs Claude 3 Haiku
- Use for final evaluation runs only

**Not recommended:**
→ **Nova models**
- Incompatible with Bedrock Agents
- Poor spatial reasoning (Nova Micro tested)
- Converse API architecture hits rate limits
- Not worth architectural complexity

### Adding New Models

When adding a new model to Oriole:

1. **Update CDK stack:**
```javascript
const claude3Agent = new BedrockAgentConstruct(this, 'Claude3HaikuAgent', {
  agentName: 'oriole-claude-3-haiku',
  modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
  instruction: '...',
  actionLambda: actionRouterLambda
});
```

2. **Add pricing to Parameter Store:**
```bash
aws ssm put-parameter \
  --name /oriole/pricing/models \
  --value '{
    "claude-3-haiku": {
      "input_per_mtok": 0.25,
      "output_per_mtok": 1.25
    },
    ...
  }' \
  --overwrite
```

3. **Configure rate limit:**
```bash
aws ssm put-parameter \
  --name /oriole/models/claude-3-haiku/rate-limit-rpm \
  --value "8" \
  --type String
```

4. **Update invoke-agent.js model mapping:**
```javascript
function getModelId(modelName) {
  const modelMap = {
    'claude-3-haiku': 'anthropic.claude-3-haiku-20240307-v1:0',
    // ...
  };
  return modelMap[modelName] || modelName;
}
```

5. **Deploy and configure:**
```bash
npm run deploy
./scripts/setup-agent-actions.sh AGENT_ID LAMBDA_ARN
```

6. **Create version via temp alias** (see Versioning section above)

7. **Add Lambda permissions:**
```bash
aws lambda add-permission \
  --function-name ACTION_ROUTER \
  --statement-id AllowBedrockAgent-AGENT_NAME \
  --action lambda:InvokeFunction \
  --principal bedrock.amazonaws.com \
  --source-arn "arn:aws:bedrock:REGION:ACCOUNT:agent/AGENT_ID"
```

---

## JavaScript Type Coercion Bugs

### The Token Counting Catastrophe

**Symptom:** Token counts in database and Step Functions state grow exponentially:
```
Turn 1: cumulativeInputTokens: "01373"
Turn 2: cumulativeInputTokens: "13732261"
Turn 3: cumulativeInputTokens: "137322612506"
Turn 4: cumulativeInputTokens: "1373226125062809"
...eventually → 26494517640081199905 (exceeds PostgreSQL bigint max!)
```

**Root Cause: String Concatenation Instead of Addition**

JavaScript's type coercion silently converts addition to string concatenation when one operand is a string:

```javascript
// BROKEN CODE
const cumulativeInputTokens = experiment.total_input_tokens + invocationTokensIn;
// If total_input_tokens is "1373" (string from DB) and invocationTokensIn is 2261:
// Result: "13732261" (string concatenation!)

// What we expected: 1373 + 2261 = 3634 (addition)
// What JavaScript did: "1373" + 2261 → "1373" + "2261" = "13732261" (concat)
```

### Why This Happens

**Multiple sources of type ambiguity:**

1. **PostgreSQL Node Driver** may return numbers as strings for large integers
2. **Step Functions Lambda Integration** can wrap payloads as JSON strings: `{Payload: "{...}"}`
3. **Previous Turn Values** already corrupted as strings get concatenated with new numbers

### The Complete Fix

```javascript
// FIXED CODE in check-progress.js

// 1. Handle both Lambda payload types (string vs object)
let agentPayload = {};
if (agentResult?.Payload) {
  if (typeof agentResult.Payload === 'string') {
    agentPayload = JSON.parse(agentResult.Payload);  // Parse if string
  } else {
    agentPayload = agentResult.Payload;  // Use directly if object
  }
}

// 2. Force invocation values to Number
const invocationTokensIn = Number(agentPayload.inputTokens || 0);
const invocationTokensOut = Number(agentPayload.outputTokens || 0);
const invocationCost = Number(agentPayload.cost || 0);

// 3. Parse database values explicitly as integers
const cumulativeInputTokens = parseInt(experiment.total_input_tokens || 0) + invocationTokensIn;
const cumulativeOutputTokens = parseInt(experiment.total_output_tokens || 0) + invocationTokensOut;
const cumulativeCost = parseFloat(experiment.total_cost_usd || 0) + invocationCost;
```

### Detection Strategy

**How to spot this bug:**

1. **Step Functions execution history** shows string values with exponential growth:
   ```bash
   aws stepfunctions get-execution-history --execution-arn <arn> --reverse-order
   ```
   Look for `cumulativeInputTokens` that are clearly too large or have leading zeros.

2. **Database integer overflow errors:**
   ```
   ERROR: value "26494517640081199905" is out of range for type bigint
   ```

3. **Cost calculations are impossibly high:**
   ```
   cumulativeCost: $3000 for a 5-turn experiment
   ```

### Prevention Checklist

For ANY numeric accumulation in JavaScript:

- ✅ Use `parseInt()`, `parseFloat()`, or `Number()` on ALL inputs
- ✅ Never trust database values to be numbers (they might be strings)
- ✅ Never trust Lambda payloads without type checking
- ✅ Test with actual data from Step Functions (not just unit tests with literals)
- ✅ Add monitoring for anomalous values (e.g., token counts > 1M per turn)

### Broader Lesson: Always Validate Numeric Types

This bug class appears anywhere numeric data crosses system boundaries:

- Database → Application (driver type conversion)
- Step Functions → Lambda (JSON serialization)
- Lambda → Lambda (payload wrapping)
- API responses → Application (JSON parsing)

**Golden Rule:** If you're doing math on it, explicitly convert it to a number first.

---

## Two-Level Prompting Architecture

### The Confusion: Two Types of "Prompts"

When working with Bedrock Agents, there are **two distinct prompt layers** that serve different purposes:

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: Agent Instruction (Bedrock Agent Config)      │
│  - Hardcoded in CDK (lib/oriole-stack.js)               │
│  - Defines WHO the agent is                              │
│  - Rarely changes                                        │
│  - Example: "You are navigating a 2D maze..."            │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Layer 2: Turn Input (Parameter Store)                  │
│  - Dynamic per-experiment (from /oriole/prompts/v*)      │
│  - Injected into each turn's input                       │
│  - Changes between experiments                           │
│  - Example: "You have 45 actions remaining. Think..."    │
└─────────────────────────────────────────────────────────┘
```

### Layer 1: Agent Instruction (Identity)

**Where it's defined:**
```javascript
// lib/oriole-stack.js
const claude3Agent = new BedrockAgentConstruct(this, 'Claude3HaikuAgent', {
  agentName: 'oriole-claude-3-haiku',
  modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
  instruction: 'You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory.',
  actionLambda: actionRouterLambda
});
```

**How it's used:**
- Passed to `CfnAgent` constructor (line 82 in `lib/bedrock-agent-construct.js`)
- Baked into the Bedrock Agent configuration
- **This is OUR code**, not AWS boilerplate
- Changing this requires redeploying the CDK stack

**Purpose:**
- Establishes agent's role and capabilities
- Provides unchanging context (grid size, vision mechanics)
- Sets behavioral expectations

### Layer 2: Turn Input (Dynamic Guidance)

**Where it's defined:**
```bash
# Parameter Store
/oriole/prompts/v1
/oriole/prompts/v2
/oriole/prompts/v3-react-basic
```

**Where it's injected:**
```javascript
// lambda/orchestration/invoke-agent.js (lines 81-95)
const promptText = await getPrompt(promptVersion);

const input = `You are continuing a maze navigation experiment.

Experiment ID: ${experimentId}
Your Current Position: (${currentX}, ${currentY})
Goal: ${goalDescription}

${promptText}  // ← Injected from Parameter Store

When you call any action, always include experimentId=${experimentId} in your request.`;
```

**How it's used:**
- Fetched from Parameter Store at runtime
- Combined with current state (position, experiment ID)
- Sent as input to `InvokeAgent` API call
- Different for each turn (can include action budget, ReAct prompts, etc.)

**Purpose:**
- Provide turn-specific guidance
- Test different prompting strategies (A/B testing)
- Include dynamic state that changes each turn
- Add constraints or framing (e.g., "You have 8 actions left")

### Why Two Levels?

**Architectural benefits:**

1. **Experiment Efficiency:** Can test different prompts without recreating agents
   ```bash
   # Test v1 prompt
   ./trigger-experiment.sh AGENT_ID ALIAS_ID claude-3-haiku 1 v1

   # Test v2 prompt (same agent!)
   ./trigger-experiment.sh AGENT_ID ALIAS_ID claude-3-haiku 1 v2
   ```

2. **Separation of Concerns:**
   - Agent instruction = stable identity
   - Turn input = variable guidance

3. **Rapid Iteration:** Change Parameter Store value, no redeployment needed

### Common Mistake: Expecting Agent to Remember Instructions

**Misconception:**
```javascript
// Turn 1 input
"You are at (2, 2). Remember your position and navigate carefully."

// Turn 2 input
"Continue navigating."  // ❌ Agent doesn't remember position!
```

**Correct approach:**
```javascript
// EVERY turn must include position
"Your Current Position: (5, 7)"
```

The agent instruction provides the base context, but critical state (like position) must be re-stated in every turn input.

### Example: ReAct Prompting via Turn Input

Layer 1 (Agent Instruction): "You are navigating a maze..."

Layer 2 (Turn Input from `/oriole/prompts/v3-react-strict`):
```
For each decision, structure your thinking as:

THOUGHT: [Analyze current situation]
ACTION: [Call one tool]
OBSERVATION: [Reflect on tool result]

You have [X/8 actions] remaining in this turn.
```

This allows testing different cognitive frameworks (ReAct, Chain-of-Thought, etc.) without touching infrastructure.

---

## Lambda Concurrency for Serialization

### The Problem: Account-Wide Rate Limits

AWS Bedrock rate limits apply **per model per account per region**:
- Claude 3 Haiku: 10 RPM
- Claude 3.5 Haiku: 10 RPM
- Nova Micro: Unknown (varies)

**What this means:**
- All experiments targeting Claude 3 Haiku share the same 10 RPM quota
- Running 2 experiments in parallel = each gets ~5 RPM effective limit
- Random throttling depending on timing

### The Solution: Reserved Concurrent Executions

```javascript
// lib/oriole-stack.js (line 274)
const invokeAgentLambda = new lambda.Function(this, 'InvokeAgentFunction', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'orchestration/invoke-agent.handler',
  code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
  environment: dbEnvVars,
  role: lambdaRole,
  timeout: cdk.Duration.seconds(invokeAgentTimeoutSeconds),
  reservedConcurrentExecutions: 1  // ← Only ONE invocation at a time
});
```

**What `reservedConcurrentExecutions: 1` does:**

1. AWS Lambda reserves exactly 1 execution environment for this function
2. If function is already running, new invocations **wait in queue**
3. No two invocations run simultaneously
4. Effectively serializes all Bedrock Agent API calls

### Architecture: Three Layers of Serialization

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: SQS FIFO Queue                                  │
│ - MessageGroupId = "all-experiments" (static)            │
│ - Only one experiment starts at a time                   │
│ - Serializes experiment INITIATION                       │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Layer 2: Step Functions Sequential Workflow              │
│ - InvokeAgent → Wait → CheckProgress → Loop             │
│ - Only one turn at a time within experiment              │
│ - Serializes TURNS within an experiment                  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Layer 3: Lambda Reserved Concurrency = 1                 │
│ - Only one InvokeAgent call executing globally          │
│ - Prevents parallel Bedrock API calls                   │
│ - Serializes BEDROCK INVOCATIONS across all experiments │
└─────────────────────────────────────────────────────────┘
```

### Why Not Just Use SQS?

**SQS alone doesn't prevent concurrent API calls:**

```
Experiment A (Step Functions):
  Turn 1 → InvokeAgent ──┐
                           ├→ Both hit Bedrock at same time!
Experiment B (Step Functions):  │
  Turn 1 → InvokeAgent ──┘
```

Even though SQS ensures experiments start sequentially, within each experiment's Step Functions execution, agent turns could overlap if Experiment A is long-running.

**Lambda concurrency ensures:**
```
Experiment A: InvokeAgent (running) ───────────────▶
Experiment B: InvokeAgent (QUEUED, waits) ─────────────▶
```

### Verification

**Check the setting:**
```bash
aws lambda get-function-concurrency \
  --function-name OrioleStack-InvokeAgentFunctionAD5BFB56-n2hiHRIF3VPR

# Output:
# {
#   "ReservedConcurrentExecutions": 1
# }
```

**Note:** `get-function-configuration` does NOT always show this value. Use `get-function-concurrency` for authoritative answer.

### Trade-offs

**Pros:**
- ✅ Zero rate limiting errors (never hit Bedrock limits)
- ✅ Deterministic behavior (no timing-dependent failures)
- ✅ Predictable experiment duration
- ✅ Simple to reason about (strict serialization)

**Cons:**
- ❌ Lower throughput (can't use full 10 RPM quota)
- ❌ Experiments queue behind each other
- ❌ Long-running experiment blocks all others

### Alternative: Per-Model Concurrency

**Not implemented, but possible:**

```javascript
// Separate Lambda per model
const claude3HaikuInvokeLambda = new lambda.Function(this, 'Claude3HaikuInvoke', {
  reservedConcurrentExecutions: 1
});

const claude35HaikuInvokeLambda = new lambda.Function(this, 'Claude35HaikuInvoke', {
  reservedConcurrentExecutions: 1
});
```

This would allow:
- Claude 3 Haiku experiments run serially (no conflicts)
- Claude 3.5 Haiku experiments run serially (no conflicts)
- **But** different models can run in parallel (separate quotas)

**Why we didn't do this:**
- More complex routing logic
- More Lambdas to manage
- Current approach is simpler and works well enough

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

**Document Version:** 5.0
**Last Updated:** 2025-10-24
**Author:** Claude Code Session (Debugging & Implementation)
**Major Changes in v5.0:**
- **CDK Inline Action Groups**: Documented how to use `actionGroups` property in CfnAgent (CDK v2.220+)
- **Lambda Resource Policy**: Added critical requirement for `addPermission()` in addition to `grantInvoke()`
- **Zero Manual Steps**: Agents now fully deployable via `cdk deploy` with no CLI configuration
- **Eliminated Configuration Drift**: Action groups, permissions, and schemas all in version control
- Marked legacy versioning/alias workarounds as deprecated
**Major Changes in v4.0:**
- Added JavaScript Type Coercion Bugs section (token counting string concatenation)
- Documented Two-Level Prompting Architecture (agent instruction vs turn input)
- Added Lambda Concurrency for Serialization section (reservedConcurrentExecutions)
- Updated monitoring workflows to prefer Step Functions over database
- Added comprehensive troubleshooting guide (TROUBLESHOOTING.md)
**Major Changes in v3.0:**
- Added comprehensive Nova model compatibility analysis
- Documented Bedrock Agent versioning challenges and workarounds
- Added detailed model comparison and cost analysis
- Documented Claude 3 Haiku setup and configuration
- Added Converse API vs Bedrock Agents trade-off analysis
**Major Changes in v2.0:**
- Added SQS FIFO queue architecture for experiment serialization
- Documented fail-fast approach (no retries)
- Updated rate limiting strategy (3 RPM conservative approach)
- Added queue processor Lambda documentation
