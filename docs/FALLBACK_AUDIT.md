# Fallback Pattern Audit - Error Hiding Analysis

**Date:** 2025-10-28
**Scope:** Entire codebase (Lambda functions, CDK, scripts)
**Purpose:** Identify fallback patterns that could hide problems

## Executive Summary

Found **18 fallback patterns**, categorized by severity:
- **6 HIGH severity** - Silent failures that could hide critical bugs
- **6 MEDIUM severity** - Warnings logged but execution continues
- **6 LOW severity** - Acceptable defensive coding

## Critical Issues (HIGH Severity)

### 1. Parameter Store Failures with Silent Fallbacks
**File:** `lambda/orchestration/start-experiment.js:154-169`

```javascript
const [recallInterval, maxRecallActions, maxMoves, maxDurationMinutes, maxActionsPerTurn, visionRange] = await Promise.all([
  ssmClient.send(new GetParameterCommand({ Name: '/oriole/experiments/recall-interval' }))
    .then(r => parseInt(r.Parameter.Value))
    .catch(err => { console.warn('Failed to read /oriole/experiments/recall-interval:', err.message); return null; }),
  // ... 5 more similar patterns
]);
```

**Problem:** If Parameter Store is unavailable, experiments run with `null` values in config. These nulls get stored in database and cause undefined behavior later.

**What it hides:**
- Parameter Store misconfiguration
- AWS service outages
- Deleted parameters
- IAM permission issues

**Fix:** Fail fast - don't create experiment if config can't be loaded.

---

### 2. Token Usage Fallbacks to Zero
**File:** `lambda/orchestration/check-progress.js:133-135`

```javascript
const invocationTokensIn = Number(agentPayload.inputTokens || 0);
const invocationTokensOut = Number(agentPayload.outputTokens || 0);
const invocationCost = Number(agentPayload.cost || 0);
```

**Problem:** If agent fails to return token counts, this records 0 tokens. Cost tracking becomes silently inaccurate.

**What it hides:**
- API contract changes (new field names)
- Model-specific response format issues
- JSON parsing failures
- Missing token data from new models

**Fix:** Validate token fields exist, throw error if missing.

---

### 3. Token Field Name Fallback Chain
**File:** `lambda/orchestration/invoke-agent.js:209-210`

```javascript
inputTokens = usage.inputTokens || usage.inputToken || 0;
outputTokens = usage.outputTokens || usage.outputToken || 0;
```

**Problem:** Final fallback to `0` means if API changes field names again, cost tracking silently breaks.

**What it hides:**
- API breaking changes
- Response format changes
- Model incompatibility

**Fix:** Check for known field names, throw error if none found.

---

### 4. Ollama Token Count Fallbacks
**File:** `lambda/orchestration/invoke-agent-ollama.js:329-331`

```javascript
totalInputTokens += response.prompt_eval_count || 0;
totalOutputTokens += response.eval_count || 0;
```

**Problem:** If Ollama stops returning token counts, tracking silently breaks.

**What it hides:**
- Ollama API changes
- Model-specific token support
- Network/parsing issues

**Fix:** Validate token fields, fail if missing.

---

### 5. Action Result Fallback to Empty Object
**File:** `lambda/orchestration/invoke-agent-ollama.js:251`

```javascript
const result = typeof payload.response?.responseBody?.['application/json']?.body === 'string'
  ? JSON.parse(payload.response.responseBody['application/json'].body)
  : payload.response?.responseBody?.['application/json']?.body || {};
```

**Problem:** If action router fails or returns unexpected format, this defaults to `{}`. Agent receives no feedback about failed action.

**What it hides:**
- Action router failures
- Malformed responses
- Lambda invocation errors
- Vision calculation failures

**Fix:** Validate response structure, throw error if malformed.

---

### 6. Max Step Number Fallback
**File:** `lambda/shared/db.js:141`

```javascript
return (result.rows[0].max_step || 0) + 1;
```

**Problem:** If query returns null, this returns `1`, potentially causing step number collisions or data corruption.

**What it hides:**
- Database query failures
- Table corruption
- Race conditions

**Fix:** Check if result.rows[0] exists and max_step is a number.

---

## Significant Issues (MEDIUM Severity)

### 7. Max Actions Per Turn Parameter Failure
**File:** `lambda/orchestration/invoke-agent-ollama.js:68-70`

```javascript
} catch (error) {
  console.warn('Failed to load max-actions-per-turn from Parameter Store, using default of 50:', error.message);
  return 50;
}
```

**Problem:** If real value was 10 (cost control) or unlimited (0), behavior changes unexpectedly.

**Impact:** Cost overruns or artificial limits applied

---

### 8. Request Timeout Parameter Failure
**File:** `lambda/orchestration/invoke-agent-ollama.js:141-143`

```javascript
} catch (error) {
  console.warn('Failed to load request-timeout-ms from Parameter Store, using default of 120000ms:', error.message);
  return 120000;
}
```

**Problem:** If actual timeout was 10 minutes for slow models, experiments fail unexpectedly.

**Impact:** Timeouts for slow models

---

### 9. Rate Limit Default for Unknown Models
**File:** `lambda/orchestration/check-progress.js:85-87`

```javascript
} catch (error) {
  console.warn(`No rate limit found for model ${modelName}, defaulting to 10 rpm`);
  return 10;
}
```

**Problem:** Wrong rate limit causes throttling (if actual is 3 RPM) or wastes time (if actual is 60 RPM).

**Impact:** Throttling errors or slow experiments

---

### 10. Max Concurrent Experiments Fallback
**File:** `lambda/orchestration/ollama-queue-processor.js:38-40`

```javascript
} catch (error) {
  console.warn('Failed to get max-concurrent-experiments from SSM, using default of 1:', error.message);
  return 1;
}
```

**Problem:** Configured 5 for parallel processing? Now it's 1, silently reducing throughput.

**Impact:** Performance degradation

---

### 11. Pricing Model Not Found
**File:** `lambda/orchestration/invoke-agent.js:70-72`

```javascript
if (!modelPricing) {
  console.warn(`No pricing found for model: ${modelName}`);
  return 0;
}
```

**Problem:** Returns $0 cost for models without pricing. Financial reports become inaccurate.

**Impact:** Cost tracking failures

---

### 12. Lock Release Failure Swallowed
**File:** `lambda/actions/router.js:192-194`

```javascript
} catch (unlockError) {
  console.error(`Failed to release lock for experiment ${experimentId}:`, unlockError);
  // Don't throw - lock will be released when connection closes
}
```

**Problem:** Repeated failures indicate database issues that go unnoticed.

**Impact:** Infrastructure problems hidden

---

## Acceptable Patterns (LOW Severity)

These are reasonable defensive coding practices:

1. **Reasoning field default** (`invoke-agent-ollama.js:231`) - Optional metadata
2. **Turn number null fallback** (`move_handler.js:95,129`) - Backward compatibility
3. **Path fallback chain** (`viewer.js:73`) - API Gateway event format variations
4. **Session attribute parsing** (`router.js:98`) - Optional metadata
5. **Properties array default** (`router.js:84`) - Valid for no-parameter requests
6. **Test helper defaults** (`test/helpers/db.js:90-100`) - Test code, not production

---

## Recommendations

### Priority 1: Fix Critical Token Tracking (HIGH)

**Current pattern:**
```javascript
const tokens = response.inputTokens || 0;
```

**Recommended pattern:**
```javascript
if (response.inputTokens === undefined) {
  throw new Error(`Token count missing from ${modelName} response`);
}
const tokens = response.inputTokens;
```

**Why:** Cost tracking is critical for research budgets. Silent failures make data unreliable.

---

### Priority 2: Fix Parameter Store Fallbacks (HIGH)

**Current pattern:**
```javascript
.catch(err => { console.warn('Failed...'); return null; })
```

**Recommended pattern:**
```javascript
.catch(err => {
  throw new Error(`Required parameter missing: ${err.message}`);
})
```

**Why:** Experiments with null config produce garbage data. Better to fail fast.

---

### Priority 3: Validate Action Router Responses (HIGH)

**Current pattern:**
```javascript
const result = ... || {};
```

**Recommended pattern:**
```javascript
if (!payload.response?.responseBody?.['application/json']?.body) {
  throw new Error(`Invalid action router response for ${actionType}`);
}
const result = JSON.parse(payload.response.responseBody['application/json'].body);
```

**Why:** Agent needs feedback about failed actions to make correct decisions.

---

### Priority 4: Add CloudWatch Metrics for Warnings (MEDIUM)

For patterns where fallbacks are acceptable but should be monitored:

```javascript
// Instead of just console.warn
console.warn('Failed to load parameter, using default');
await cloudwatch.putMetricData({
  MetricName: 'ParameterStoreFailure',
  Value: 1,
  Unit: 'Count'
});
```

**Why:** Track frequency of fallbacks to detect infrastructure issues early.

---

### Priority 5: Validate Model Config Fields (HIGH)

For Ollama experiments, we already validate config fields:

```javascript
if (config.maxContextWindow === undefined) {
  throw new Error('maxContextWindow must be provided');
}
```

**Good!** But need to apply same validation to Parameter Store fetches.

---

## Code Pattern Rules

### ✅ DO: Fail Fast for Critical Data

```javascript
// Financial data
if (!response.inputTokens) {
  throw new Error('Token count required for cost tracking');
}

// Required config
if (!config.temperature) {
  throw new Error('temperature must be provided');
}

// Critical results
if (!actionResult.success) {
  throw new Error(`Action ${actionType} failed: ${actionResult.error}`);
}
```

### ✅ DO: Validate Before Fallback

```javascript
// Check known field names
const tokens = response.inputTokens ?? response.inputToken ??
  (() => { throw new Error('No token count in response') })();
```

### ✅ DO: Log AND Metric for Monitoring

```javascript
try {
  return await fetchParameter();
} catch (error) {
  console.warn('Parameter fetch failed:', error);
  await emitMetric('ParameterFetchFailure');
  return defaultValue; // Only if truly acceptable
}
```

### ❌ DON'T: Silent Fallbacks for Critical Data

```javascript
// BAD - hides cost tracking failures
const cost = calculateCost() || 0;

// BAD - hides config issues
const config = await getConfig().catch(() => ({}));

// BAD - hides action failures
const result = await executeAction().catch(() => ({ success: true }));
```

### ❌ DON'T: Swallow Errors Without Alerting

```javascript
// BAD - error disappears
try {
  await criticalOperation();
} catch (error) {
  console.error('Operation failed');
  // No throw, no metric, no alert
}
```

---

## Migration Strategy

### Phase 1: Add Validation (No Breaking Changes)

Add validation alongside existing fallbacks:

```javascript
// Old code continues to work
const tokens = response.inputTokens || 0;

// Add validation that logs but doesn't break
if (response.inputTokens === undefined) {
  console.error('VALIDATION: Token count missing!');
  await emitMetric('MissingTokenCount');
}
```

### Phase 2: Monitor Metrics

Watch CloudWatch for how often validation failures occur. If rare, proceed to Phase 3.

### Phase 3: Remove Fallbacks

Replace fallbacks with errors:

```javascript
if (response.inputTokens === undefined) {
  throw new Error('Token count required');
}
const tokens = response.inputTokens;
```

### Phase 4: Add Alerting

Set up CloudWatch alarms for critical metrics:
- ParameterStoreFailure > 0 (should never happen)
- MissingTokenCount > 0 (should never happen)
- ActionRouterFailure > threshold

---

## Testing Strategy

### Unit Tests: Add Negative Cases

```javascript
// Test missing token count
test('throws error when inputTokens missing', () => {
  const response = { outputTokens: 100 }; // missing inputTokens
  expect(() => processResponse(response)).toThrow('Token count required');
});

// Test Parameter Store failure
test('throws error when parameter unavailable', async () => {
  mockSSM.getParameter.mockRejectedValue(new Error('Not found'));
  await expect(startExperiment()).rejects.toThrow('Required parameter missing');
});
```

### Integration Tests: Simulate Failures

```javascript
// Test Parameter Store outage
test('experiment fails gracefully when SSM unavailable', async () => {
  // Mock SSM to fail
  process.env.AWS_SSM_ENDPOINT = 'http://invalid';

  const result = await triggerExperiment();
  expect(result.failed).toBe(true);
  expect(result.failureReason).toContain('Parameter Store');
});
```

---

## Impact Assessment

### If We Fix These Issues:

**Pros:**
- ✅ Errors become visible instead of silent
- ✅ Bad data never enters database
- ✅ Faster debugging (fail fast vs garbage in/out)
- ✅ Cost tracking becomes reliable
- ✅ Config issues caught early

**Cons:**
- ⚠️ Some experiments that previously "succeeded" (with bad data) will now fail
- ⚠️ Need to ensure all required parameters are configured
- ⚠️ More errors in CloudWatch initially (but that's good - they were always there, just hidden)

### If We Don't Fix These Issues:

**Risks:**
- ❌ Cost reports are unreliable (could be undercounting significantly)
- ❌ Experiments succeed with broken config (garbage results)
- ❌ Infrastructure issues go unnoticed (Parameter Store failures)
- ❌ Hard to debug (data corruption appears random)
- ❌ Research conclusions could be wrong (based on bad data)

---

## Conclusion

The codebase has **6 HIGH severity** fallback patterns that could hide critical bugs, primarily around:
1. Token/cost tracking (financial data)
2. Parameter Store failures (config data)
3. Action execution results (behavior data)

**Recommendation:** Fix HIGH severity issues immediately. They represent silent data corruption that could invalidate research results and cost tracking.

**Effort Estimate:**
- Priority 1-3 fixes: ~4 hours
- Testing: ~2 hours
- Monitoring setup: ~1 hour
- **Total: ~1 day of work**

**Risk of NOT fixing:** Continued silent failures and unreliable data.
