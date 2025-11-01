# Execution Tracking System

Comprehensive tracking of Step Functions execution metadata to diagnose failures when experiments don't complete normally.

## Problem

When experiments fail, they sometimes don't update `completed_at` or `failure_reason` in the database. This happens when:

1. **Lambda timeout** - Exceeds 15-minute execution limit
2. **Unhandled exception** - Lambda crashes before DB write
3. **Network issues** - Can't reach database for final update
4. **Out of memory** - Process killed mid-execution

Without execution metadata, diagnosing these failures requires:
- Guessing execution names from timestamps
- Manual timezone math
- Searching CloudWatch logs blindly
- No way to distinguish "still running" from "crashed hours ago"

## Solution

Capture Step Functions execution metadata **at experiment START**, not just at the end. This creates a paper trail even if the execution crashes.

### New Database Columns

Added in migration `015_add_execution_tracking_columns.sql`:

| Column | Type | Purpose |
|--------|------|---------|
| `execution_arn` | text | Full ARN for AWS CLI queries |
| `execution_name` | text | Short name for log searching |
| `execution_status` | varchar(20) | RUNNING → SUCCEEDED/FAILED/TIMED_OUT |
| `last_error` | jsonb | Structured error details (type + cause + timestamp) |
| `sqs_message_id` | text | For lifecycle tracing (queue → execution → experiment) |

### Execution Lifecycle

```
1. SQS message arrives
   ↓ (messageId captured)
2. Step Functions starts execution
   ↓ (execution_arn, execution_name generated)
3. StartExperiment Lambda creates DB record
   ↓ (execution_status = 'RUNNING', all metadata stored)
4. Agent performs actions...
   ↓
5a. SUCCESS PATH:
    FinalizeExperiment sets:
      - execution_status = 'SUCCEEDED'
      - completed_at = NOW()
      - goal_found = true/false

5b. ERROR PATH:
    FinalizeOnError sets:
      - execution_status = 'FAILED' or 'TIMED_OUT'
      - completed_at = NOW()
      - last_error = {error, cause, timestamp}
      - failure_reason = human-readable message
```

### Key Distinction

**execution_status** vs **goal_found**:

- `execution_status = 'SUCCEEDED'` means Step Functions execution completed
- `goal_found = true` means agent actually found the goal tile

Possible combinations:

1. `execution_status='SUCCEEDED', goal_found=true` - Perfect run ✅
2. `execution_status='SUCCEEDED', goal_found=false` - Completed but didn't find goal ⚠️
3. `execution_status='FAILED', goal_found=false` - Execution crashed ❌
4. `execution_status='TIMED_OUT', goal_found=false` - Lambda timeout ⏱️
5. `execution_status='RUNNING', completed_at=NULL` - Stuck or still running? 🤔

## Code Changes

### 1. Database Migration

`db/migrations/015_add_execution_tracking_columns.sql`

- Adds 5 new columns with detailed PostgreSQL comments
- Creates indexes for performance
- Includes comprehensive inline documentation

### 2. Lambda: start-experiment.js

**What changed:**
- Accepts `executionContext` from Step Functions event
- Stores `execution_arn`, `execution_name`, `sqs_message_id` in DB
- Sets initial `execution_status = 'RUNNING'`

**Code location:**
```javascript
// Line ~100: Extract execution context from event
const executionContext = event.executionContext || {};
const { executionArn, executionName, sqsMessageId } = executionContext;

// Line ~350: INSERT with execution tracking columns
INSERT INTO experiments
  (..., execution_arn, execution_name, execution_status, sqs_message_id)
  VALUES (..., $9, $10, 'RUNNING', $12)
```

### 3. Lambda: finalize-experiment.js

**What changed:**

**ERROR PATH** (explicitSuccess = false):
- Parses `errorInfo.Error` to determine error type
- Sets `execution_status` to 'FAILED' or 'TIMED_OUT'
- Populates `last_error` as JSONB: `{error, cause, timestamp}`

**SUCCESS PATH**:
- Sets `execution_status = 'SUCCEEDED'`
- Sets `goal_found` based on GOAL tile visibility
- Leaves `last_error` as NULL

**Code location:**
```javascript
// Line ~88-137: ERROR PATH
if (explicitSuccess === false) {
  const executionStatus = errorInfo.Error.includes('Timeout') ? 'TIMED_OUT' : 'FAILED';
  const lastError = {
    error: errorInfo.Error,
    cause: errorInfo.Cause,
    timestamp: new Date().toISOString()
  };
  // UPDATE with execution_status and last_error
}

// Line ~168-203: SUCCESS PATH
UPDATE experiments
  SET execution_status = 'SUCCEEDED', goal_found = $1, completed_at = NOW()
```

### 4. CDK Stack: oriole-stack.js

**What changed:**

**StartExperiment task:**
- Injects Step Functions context into Lambda event
- Adds `executionContext` object with ARN, name, messageId

```javascript
// Line ~472: Inject execution context
const startStep = new tasks.LambdaInvoke(this, 'StartExperiment', {
  payload: sfn.TaskInput.fromObject({
    ...sfn.JsonPath.objectAt('$'),  // Original event
    executionContext: {
      executionArn: sfn.JsonPath.stringAt('$$.Execution.Id'),
      executionName: sfn.JsonPath.stringAt('$$.Execution.Name'),
      sqsMessageId: sfn.JsonPath.stringAt('$.messageId')
    }
  })
});
```

**FinalizeOnError task:**
- Passes full `errorInfo` object to Lambda
- Enables error type detection (Lambda.Timeout vs States.TaskFailed)

```javascript
// Line ~499: Pass errorInfo for structured error capture
const finalizeOnError = new tasks.LambdaInvoke(this, 'FinalizeOnError', {
  payload: sfn.TaskInput.fromObject({
    experimentId: sfn.JsonPath.numberAt('$.experimentId'),
    success: false,
    failureReason: sfn.JsonPath.stringAt('$.errorInfo.Cause'),
    errorInfo: sfn.JsonPath.objectAt('$.errorInfo')  // NEW: full error object
  })
});
```

## Usage

### Finding Stuck Experiments

```sql
-- Show experiments that never completed
SELECT id, model_name, started_at, execution_status, execution_name
FROM experiments
WHERE completed_at IS NULL
ORDER BY started_at DESC;
```

### Diagnosing Failures

```sql
-- Show recent failures with error details
SELECT
  id,
  execution_status,
  last_error->>'error' as error_type,
  last_error->>'cause' as error_cause,
  execution_arn
FROM experiments
WHERE execution_status IN ('FAILED', 'TIMED_OUT')
ORDER BY started_at DESC
LIMIT 10;
```

### AWS CLI Investigation

```bash
# Get execution status
aws stepfunctions describe-execution \
  --execution-arn "arn:aws:states:us-west-2:...:execution:oriole-experiment-runner:ollama_..." \
  --profile bobby

# Get execution history (last 10 events)
aws stepfunctions get-execution-history \
  --execution-arn "arn:aws:states:..." \
  --max-results 10 \
  --reverse-order \
  --profile bobby

# View CloudWatch logs
aws logs tail /aws/lambda/oriole-invoke-agent-ollama \
  --filter-pattern "ollama_00f202bf..." \
  --profile bobby
```

### Comprehensive Diagnostics

See `docs/diagnose-failed-experiments.sql` for pre-written diagnostic queries:

1. Find all stuck experiments
2. Find long-running RUNNING experiments
3. Analyze failures by error type
4. View detailed error info
5. Compare success rates by model/temperature
6. Detect duplicate SQS processing
7. Generate AWS CLI commands automatically

## Deployment

### 1. Run Migration

```bash
# Apply migration to database
psql "sslmode=require host=continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com user=oriole_user dbname=oriole" \
  -f db/migrations/015_add_execution_tracking_columns.sql

# Verify columns exist
psql "..." -c "\d experiments"
```

### 2. Deploy Lambda Updates

```bash
# Deploy updated Lambda functions and CDK stack
cd /Users/bobbyburgess/Documents/code/oriole
AWS_PROFILE=bobby npx cdk deploy
```

### 3. Verify

Trigger a test experiment and check the database:

```sql
SELECT
  id,
  execution_arn,
  execution_name,
  execution_status,
  sqs_message_id
FROM experiments
ORDER BY id DESC
LIMIT 1;
```

All new fields should be populated (except `last_error` which is NULL on success).

## Backwards Compatibility

- New columns are **nullable** - existing experiments won't break
- Existing queries don't need updates (no columns removed/renamed)
- Old experiments will have NULL for execution tracking columns
- New experiments will have full tracking metadata

## Monitoring Queries

Add these to your monitoring dashboard:

```sql
-- Count stuck experiments (should be 0)
SELECT COUNT(*)
FROM experiments
WHERE execution_status = 'RUNNING'
  AND started_at < NOW() - INTERVAL '1 hour';

-- Failure rate in last 24 hours
SELECT
  COUNT(*) FILTER (WHERE execution_status = 'SUCCEEDED') as succeeded,
  COUNT(*) FILTER (WHERE execution_status IN ('FAILED', 'TIMED_OUT')) as failed,
  ROUND(
    COUNT(*) FILTER (WHERE execution_status IN ('FAILED', 'TIMED_OUT'))::numeric /
    NULLIF(COUNT(*), 0) * 100, 1
  ) as failure_rate_pct
FROM experiments
WHERE started_at > NOW() - INTERVAL '24 hours'
  AND execution_status != 'RUNNING';
```

## Files Modified

1. `db/migrations/015_add_execution_tracking_columns.sql` - New migration
2. `lambda/orchestration/start-experiment.js` - Capture execution metadata
3. `lambda/orchestration/finalize-experiment.js` - Update execution status + errors
4. `lib/oriole-stack.js` - Inject execution context, pass errorInfo
5. `docs/diagnose-failed-experiments.sql` - Diagnostic queries (new file)
6. `docs/EXECUTION_TRACKING.md` - This documentation (new file)

## Example: Diagnosing Experiments 5 & 6

```sql
-- Check status
SELECT
  id,
  execution_status,
  last_error,
  execution_arn
FROM experiments
WHERE id IN (5, 6);

-- If execution_status is still 'RUNNING' after hours, it crashed
-- Use execution_arn to query AWS:
-- aws stepfunctions describe-execution --execution-arn "..." --profile bobby
```

Expected output after migration:
- Pre-migration experiments: execution_arn = NULL, execution_status = 'RUNNING'
- Post-migration experiments: All fields populated
