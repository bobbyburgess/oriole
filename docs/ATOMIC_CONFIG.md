# Atomic Configuration Architecture

This document explains the atomic config-in-event pattern used for Ollama experiments in Oriole.

## Problem Statement

### The Parameter Store Race Condition

**Original Architecture** (using Parameter Store):

```
Trigger 1 → writes /oriole/ollama/num-ctx = 2048 to Parameter Store
           ↓
           EventBridge → SQS → Lambda (reads Parameter Store)

Trigger 2 → writes /oriole/ollama/num-ctx = 8192 to Parameter Store  ← OVERWRITES!
           ↓
           EventBridge → SQS → Lambda (reads Parameter Store)  ← might get 8192!
```

**The Problem:**
1. Parameter Store is **shared mutable state** across all experiments
2. When running parameter sweeps, experiments trigger rapidly (seconds apart)
3. Later triggers overwrite config before earlier experiments read it
4. Experiments capture **wrong config** - destroys reproducibility
5. Timing-dependent - requires "magic number" delays (180s+) with no atomicity guarantee

**Example Bug:**
```sql
-- Expected: Varied configs
SELECT id, model_config->>'num_ctx' FROM experiments WHERE id IN (3,4,5,6);

-- Actual: All captured the SAME config!
 id | num_ctx
----+---------
  3 | 32768    ← Should be 2048 (Series A1)
  4 | 32768    ← Should be 8192 (Series A2)
  5 | 32768    ← Correct (Series A3)
  6 | 32768    ← Should be 0.0 temp (Series B1)
```

All experiments captured `32768` because the last trigger wrote that value before earlier experiments read Parameter Store.

## Solution: Atomic Config-in-Event

### Architecture

Configuration flows **with the event message** through the entire system:

```
trigger-experiment.sh (builds config JSON)
    ↓
EventBridge event (config embedded in Detail)
    ↓
SQS FIFO Queue (message contains config)
    ↓
Queue Processor Lambda (passes event through)
    ↓
Step Functions (receives config in event)
    ↓
start-experiment.js (extracts config from event, writes to DB)
    ↓
check-progress.js (passes config through workflow)
    ↓
invoke-agent-ollama.js (uses config from event)
```

### Key Principle

**Config is immutable and atomic** - embedded in the event message at trigger time, travels with the message through the entire workflow.

## Implementation

### 1. Trigger Script (Entry Point)

`scripts/trigger-experiment.sh` accepts config parameters and builds JSON:

```bash
#!/bin/bash
NUM_CTX=${7:-""}
TEMPERATURE=${8:-""}
REPEAT_PENALTY=${9:-""}
NUM_PREDICT=${10:-""}

# Build config JSON if parameters provided
if [ -n "$NUM_CTX" ] || [ -n "$TEMPERATURE" ] || [ -n "$REPEAT_PENALTY" ] || [ -n "$NUM_PREDICT" ]; then
  CONFIG_PARTS=()
  [ -n "$NUM_CTX" ] && CONFIG_PARTS+=("\"maxContextWindow\": $NUM_CTX")
  [ -n "$TEMPERATURE" ] && CONFIG_PARTS+=("\"temperature\": $TEMPERATURE")
  [ -n "$REPEAT_PENALTY" ] && CONFIG_PARTS+=("\"repeatPenalty\": $REPEAT_PENALTY")
  [ -n "$NUM_PREDICT" ] && CONFIG_PARTS+=("\"maxOutputTokens\": $NUM_PREDICT")

  CONFIG_ITEMS=$(printf '%s\n' "${CONFIG_PARTS[@]}" | paste -sd ',' -)
  CONFIG_JSON=",
  \"config\": {
    $CONFIG_ITEMS
  }"
fi

# Send to EventBridge
aws events put-events --entries "[{
  \"Source\": \"oriole.experiments\",
  \"DetailType\": \"RunExperiment\",
  \"Detail\": \"{
    ...
    \\\"llmProvider\\\": \\\"ollama\\\",
    \\\"modelName\\\": \\\"$MODEL_NAME\\\"$CONFIG_JSON
  }\"
}]"
```

**Usage:**
```bash
# Trigger with config
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 2048 0.1 1.0
```

**Event JSON:**
```json
{
  "Source": "oriole.experiments",
  "DetailType": "RunExperiment",
  "Detail": {
    "llmProvider": "ollama",
    "modelName": "qwen2.5:7b",
    "mazeId": 1,
    "promptVersion": "v1",
    "config": {
      "maxContextWindow": 2048,
      "temperature": 0.1,
      "repeatPenalty": 1.0
    }
  }
}
```

### 2. Start Experiment Lambda

`lambda/orchestration/start-experiment.js` extracts config from event and stores in DB:

```javascript
// Extract config from event payload
const {
  agentId,
  modelName,
  mazeId,
  promptVersion = 'v1',
  llmProvider = 'bedrock',
  config  // Ollama config passed in event (atomic!)
} = payload;

if (llmProvider === 'ollama') {
  // Config MUST be provided for Ollama experiments
  if (!config || Object.keys(config).length === 0) {
    throw new Error('Config must be provided in event for Ollama experiments.');
  }

  console.log('Using Ollama config from event:', config);

  // Fetch stable system params from Parameter Store
  const [recallInterval, maxRecallActions, maxMoves, maxDurationMinutes] = await Promise.all([
    ssmClient.send(new GetParameterCommand({ Name: '/oriole/experiments/recall-interval' })),
    // ... other system params
  ]);

  modelConfig = {
    // Model-specific config from event (varies per experiment)
    num_ctx: config.maxContextWindow || 32768,
    temperature: config.temperature !== undefined ? config.temperature : 0.2,
    num_predict: config.maxOutputTokens || 2000,
    repeat_penalty: config.repeatPenalty || 1.4,
    // System config from Parameter Store (stable across experiments)
    recall_interval: recallInterval,
    max_recall_actions: maxRecallActions,
    max_moves: maxMoves,
    max_duration_minutes: maxDurationMinutes
  };
}

// Store in database (experiments.model_config JSONB column)
const insertQuery = `
  INSERT INTO experiments (model_name, model_config, ...)
  VALUES ($1, $2, ...)
`;
await dbClient.query(insertQuery, [modelName, modelConfig, ...]);

// Return config for Step Functions workflow
return {
  experimentId,
  modelName,
  mazeId,
  // ... other fields
  config  // Pass through for Step Functions
};
```

### 3. Check Progress Lambda

`lambda/orchestration/check-progress.js` passes config through workflow:

```javascript
return {
  experimentId,
  modelName,
  currentX,
  currentY,
  turnNumber,
  llmProvider: event.llmProvider || 'bedrock',
  // Pass config through for atomic configuration (no Parameter Store race conditions)
  config: event.config
};
```

### 4. Invoke Agent Lambda

`lambda/orchestration/invoke-agent-ollama.js` uses config from event (NO Parameter Store fallback):

```javascript
/**
 * Get Ollama model options from event config
 * Config MUST be passed in event - no Parameter Store fallback.
 */
async function getOllamaOptions(eventConfig) {
  if (!eventConfig || Object.keys(eventConfig).length === 0) {
    throw new Error('Config must be provided in event. Pass config parameters when triggering experiment.');
  }

  console.log('Using config from event:', eventConfig);
  return {
    num_ctx: eventConfig.maxContextWindow || 32768,
    temperature: eventConfig.temperature !== undefined ? eventConfig.temperature : 0.2,
    num_predict: eventConfig.maxOutputTokens || 2000,
    repeat_penalty: eventConfig.repeatPenalty || 1.4
  };
}

// In handler
exports.handler = async (event) => {
  const { config = null } = event;
  const modelOptions = await getOllamaOptions(config);  // Pass config from event

  // Call Ollama with config
  const response = await fetch(`${OLLAMA_ENDPOINT}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': OLLAMA_API_KEY
    },
    body: JSON.stringify({
      model: event.modelName,
      messages: conversationHistory,
      options: modelOptions,  // From event config!
      tools: getOllamaTools()
    })
  });
};
```

### 5. Parameter Sweep Script

`scripts/run-parameter-sweep.sh` passes config atomically:

```bash
run_experiment() {
  local series=$1
  local name=$2
  local context=$3
  local temp=$4
  local rep_penalty=$5

  echo "🚀 Triggering experiment with config in event..."

  # Pass config as parameters (NOT Parameter Store!)
  ./scripts/trigger-experiment.sh \
    OLLAMA \
    NOTUSED \
    $MODEL \
    $MAZE_ID \
    $PROMPT_VERSION \
    "" \
    $context \
    $temp \
    $rep_penalty

  echo "⏳ Waiting 5 seconds before next experiment..."
  sleep 5  # Down from 180s! No race conditions = short delays
}

# Series A: Context window impact
run_experiment "A" "Small Context (2K)"  2048  0.2 1.4
run_experiment "A" "Medium Context (8K)" 8192  0.2 1.4
run_experiment "A" "Large Context (32K)" 32768 0.2 1.4

# Series B: Temperature (randomness)
run_experiment "B" "Pure Determinism"    32768 0.0 1.4
run_experiment "B" "Very Focused"        32768 0.1 1.4
run_experiment "B" "Focused (baseline)"  32768 0.2 1.4
# ...
```

## Benefits

### 1. Perfect Reproducibility

Each experiment's config is permanently stored in `experiments.model_config`:

```sql
SELECT
  id,
  model_name,
  model_config->>'num_ctx' as ctx,
  model_config->>'temperature' as temp,
  model_config->>'repeat_penalty' as rep_penalty
FROM experiments
ORDER BY id;
```

**Output:**
```
 id | model_name | ctx   | temp | rep_penalty
----+------------+-------+------+-------------
  9 | qwen2.5:7b | 2048  | 0.2  | 1.4         ← Series A1
 10 | qwen2.5:7b | 8192  | 0.2  | 1.4         ← Series A2
 11 | qwen2.5:7b | 32768 | 0.2  | 1.4         ← Series A3
 12 | qwen2.5:7b | 32768 | 0.0  | 1.4         ← Series B1
```

Each experiment has exactly the config it was triggered with.

### 2. No Race Conditions

Config is **immutable** once embedded in event:

- Trigger 1 creates event with `{maxContextWindow: 2048}`
- Trigger 2 creates event with `{maxContextWindow: 8192}`
- Each event carries its own config through the workflow
- No shared state = no races

### 3. Fast Parameter Sweeps

**Before (Parameter Store):**
```bash
# Required 180s delays (magic number, no guarantee)
# Total time: 12 experiments × 180s = 36 minutes of dead time
```

**After (Atomic Config):**
```bash
# Only need 5s delays (queue processing time)
# Total time: 12 experiments × 5s = 1 minute of dead time
# 36x faster!
```

### 4. Fast-Fail Pattern

Lambda throws error immediately if config missing:

```javascript
if (!eventConfig || Object.keys(eventConfig).length === 0) {
  throw new Error('Config must be provided in event. Pass config parameters when triggering experiment.');
}
```

**Why?** Prevents accidentally using stale Parameter Store values. Ensures reproducibility.

### 5. Hybrid Configuration Model

**Per-experiment config** (from event, varies):
- Context window size
- Temperature
- Repeat penalty
- Max output tokens

**System config** (from Parameter Store, stable):
- Recall interval
- Max recall actions
- Max moves per experiment
- Max duration

This gives us the best of both worlds: atomic experiment tuning + centralized system settings.

## Configuration Hierarchy

```
┌─────────────────────────────────────────────────┐
│ Event Config (Atomic, Per-Experiment)          │
├─────────────────────────────────────────────────┤
│ • num_ctx: 2048 | 8192 | 32768                 │
│ • temperature: 0.0 | 0.1 | 0.2 | 0.5 | 0.7 | 1.0│
│ • repeat_penalty: 1.0 | 1.2 | 1.4 | 1.6        │
│ • num_predict: 2000                            │
└─────────────────────────────────────────────────┘
                    ↓ Merged at runtime
┌─────────────────────────────────────────────────┐
│ Parameter Store (Stable, System-Wide)          │
├─────────────────────────────────────────────────┤
│ • recall_interval: 10                          │
│ • max_recall_actions: 50                       │
│ • max_moves: 500                               │
│ • max_duration_minutes: 120                    │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ Stored in experiments.model_config (JSONB)     │
├─────────────────────────────────────────────────┤
│ {                                              │
│   "num_ctx": 2048,              ← from event   │
│   "temperature": 0.2,           ← from event   │
│   "repeat_penalty": 1.4,        ← from event   │
│   "num_predict": 2000,          ← from event   │
│   "recall_interval": 10,        ← from SSM     │
│   "max_recall_actions": 50,     ← from SSM     │
│   "max_moves": 500,             ← from SSM     │
│   "max_duration_minutes": 120   ← from SSM     │
│ }                                              │
└─────────────────────────────────────────────────┘
```

## Design Decisions

### Why Not Just Use Parameter Store for Everything?

Parameter Store works well for:
- ✅ Stable config that rarely changes (system settings)
- ✅ Centralized management (one place to update)
- ✅ Secrets (encrypted SecureString type)

Parameter Store FAILS for:
- ❌ Rapid config changes (parameter sweeps)
- ❌ Concurrent experiments with different configs
- ❌ Atomic guarantees (no read-after-write isolation)

### Why Not Version Parameter Store Params?

**Attempted solution:**
```
/oriole/global/v1_standard/temperature
/oriole/global/v2_high_temp/temperature
```

**Problems:**
- Still shared mutable state (can overwrite v1_standard accidentally)
- Path explosion (12 experiments = 12 param paths × 4 params = 48 params!)
- Doesn't solve the timing problem (experiments can still read wrong version)

### Why Not Use S3 for Config?

**Attempted solution:** Write config to S3, pass S3 key in event

**Problems:**
- S3 has eventual consistency (might read stale object)
- Extra latency (network call to fetch config)
- More complex (S3 permissions, error handling)
- Event message can already carry config (why add indirection?)

### Why Fast-Fail Instead of Fallback?

**Fallback approach:**
```javascript
const config = event.config || await fetchFromParameterStore();
```

**Problems:**
- Hidden bugs (experiment runs with wrong config, no error)
- Non-reproducible (can't tell which source was used)
- Defeats the purpose of atomic config

**Fast-fail approach:**
```javascript
if (!event.config) {
  throw new Error('Config required');
}
```

**Benefits:**
- Immediate feedback (fail at trigger time, not 30 minutes later)
- Reproducibility guaranteed (event must have config)
- No ambiguity (single source of truth)

## Testing the Pattern

### Verify Config Captured from Event

```bash
# Trigger experiment with distinctive config
./scripts/trigger-experiment.sh OLLAMA NOTUSED qwen2.5:7b 1 v1 "" 2048 0.1 1.0

# Wait for experiment to start
sleep 10

# Query database
psql -c "
SELECT
  id,
  model_config->>'num_ctx' as ctx,
  model_config->>'temperature' as temp,
  model_config->>'repeat_penalty' as rep_penalty
FROM experiments
ORDER BY id DESC LIMIT 1;
"
```

**Expected output:**
```
 id | ctx  | temp | rep_penalty
----+------+------+-------------
  8 | 2048 | 0.1  | 1.0
```

### Verify Lambda Logs

```bash
aws logs tail /aws/lambda/OrioleStack-InvokeAgentOllamaFunction... \
  --profile bobby \
  --region us-west-2 \
  --follow \
  --filter-pattern "config"
```

**Expected log:**
```
Using config from event: { maxContextWindow: 2048, temperature: 0.1, repeatPenalty: 1.0 }
```

**NOT:**
```
Fetching config from Parameter Store (fallback)  ← BAD! Shouldn't see this
```

### Run Parameter Sweep

```bash
./scripts/run-parameter-sweep.sh
```

**Expected:**
- 12 experiments trigger rapidly (5s apart)
- Each captures unique config in database
- No config bleed between experiments

**Verify:**
```sql
SELECT
  id,
  model_config->>'num_ctx' as ctx,
  model_config->>'temperature' as temp,
  model_config->>'repeat_penalty' as rep_penalty
FROM experiments
WHERE id BETWEEN 9 AND 20
ORDER BY id;
```

**Expected output shows varied configs:**
```
 id | ctx   | temp | rep_penalty
----+-------+------+-------------
  9 | 2048  | 0.2  | 1.4         ← Series A1 (small context)
 10 | 8192  | 0.2  | 1.4         ← Series A2 (medium context)
 11 | 32768 | 0.2  | 1.4         ← Series A3 (large context)
 12 | 32768 | 0.0  | 1.4         ← Series B1 (deterministic)
 13 | 32768 | 0.1  | 1.4         ← Series B2 (very focused)
 14 | 32768 | 0.2  | 1.4         ← Series B3 (focused)
 15 | 32768 | 0.5  | 1.4         ← Series B4 (balanced)
 16 | 32768 | 0.7  | 1.4         ← Series B5 (creative)
 17 | 32768 | 1.0  | 1.4         ← Series B6 (high randomness)
 18 | 32768 | 0.2  | 1.0         ← Series C1 (no penalty)
 19 | 32768 | 0.2  | 1.2         ← Series C2 (light penalty)
 20 | 32768 | 0.2  | 1.6         ← Series C3 (strong penalty)
```

## Migration Path

If you have existing experiments using Parameter Store:

### Phase 1: Add Event Config (Backward Compatible)

```javascript
// OLD: Parameter Store only
const config = await fetchFromParameterStore();

// NEW: Event config with fallback
const config = event.config || await fetchFromParameterStore();
```

### Phase 2: Prefer Event Config

```javascript
if (event.config) {
  console.log('Using config from event (atomic)');
  return event.config;
} else {
  console.log('Fetching from Parameter Store (legacy)');
  return await fetchFromParameterStore();
}
```

### Phase 3: Require Event Config (Current)

```javascript
if (!event.config || Object.keys(event.config).length === 0) {
  throw new Error('Config must be provided in event');
}
return event.config;
```

## Conclusion

The atomic config-in-event pattern solves the Parameter Store race condition by:

1. **Embedding config in event message** (immutable, atomic)
2. **Passing config through workflow** (no shared state)
3. **Storing config in database** (perfect reproducibility)
4. **Fast-failing if missing** (no hidden bugs)

This enables:
- ✅ Reliable parameter sweeps (no config bleed)
- ✅ 36x faster sweeps (5s delays vs 180s)
- ✅ Perfect reproducibility (config in DB)
- ✅ Concurrent experiments (no race conditions)

**Tradeoff:** Must pass config at trigger time (can't change retroactively). But this is actually a **feature** - ensures reproducibility and prevents accidental config pollution.
