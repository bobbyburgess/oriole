-- Migration: Add Step Functions execution tracking to experiments table
--
-- Problem: When experiments fail without updating completed_at or failure_reason,
-- we have no way to diagnose what went wrong. This happens when:
--   1. Lambda times out (15 min limit)
--   2. Step Functions execution fails (unhandled exception)
--   3. Network issues prevent final DB write
--   4. Out of memory errors kill the Lambda mid-execution
--
-- Solution: Capture Step Functions execution metadata at experiment START,
-- not just at the end. This gives us a paper trail even if the execution crashes.
--
-- New columns allow us to:
--   - Query AWS directly for execution status via ARN
--   - View CloudWatch logs without timezone math or name guessing
--   - Distinguish "completed but failed to find goal" from "execution crashed"
--   - Capture structured error details (error type + cause)
--   - Trace experiment lifecycle from SQS → Step Functions → DB
--
-- Author: Claude Code
-- Date: 2025-10-31

-- Column 1: execution_arn
-- Full ARN for the Step Functions execution that's running this experiment
-- Format: arn:aws:states:REGION:ACCOUNT:execution:STATE_MACHINE_NAME:EXECUTION_NAME
-- Example: arn:aws:states:us-west-2:123456789:execution:oriole-experiment-runner:ollama_abc123_def456
--
-- Why: Enables direct AWS CLI queries like:
--   aws stepfunctions describe-execution --execution-arn "..."
--   aws stepfunctions get-execution-history --execution-arn "..."
--
-- Set at: Experiment creation (before first agent invocation)
-- Never changes after creation
ALTER TABLE experiments
ADD COLUMN execution_arn TEXT;

COMMENT ON COLUMN experiments.execution_arn IS
'Full ARN of the Step Functions execution running this experiment. Set at experiment start. Used to query AWS for execution status and CloudWatch logs when diagnosing failures.';

-- Column 2: execution_name
-- Human-readable execution identifier (last part of ARN)
-- Format: ollama_{uuid}_{uuid} or bedrock_{uuid}_{uuid}
-- Example: ollama_00f202bf-0145-65a9-7f0a-b2be5f9e308b_af654716-6f6d-4d46-ab53-b2fd0d950552
--
-- Why: Easier to search CloudWatch logs, grep output, and reference in debugging
-- Also useful for constructing ARN if we only store execution_name (we store both for redundancy)
--
-- Set at: Experiment creation (same time as execution_arn)
ALTER TABLE experiments
ADD COLUMN execution_name TEXT;

COMMENT ON COLUMN experiments.execution_name IS
'Short execution identifier (last segment of execution_arn). Easier for searching logs and human reference. Format: {provider}_{uuid}_{uuid}';

-- Column 3: execution_status
-- Current status of the Step Functions execution
-- Possible values (from AWS Step Functions API):
--   - 'RUNNING': Execution in progress
--   - 'SUCCEEDED': Execution completed successfully (may or may not have found goal)
--   - 'FAILED': Execution failed due to unhandled error
--   - 'TIMED_OUT': Execution exceeded maximum duration
--   - 'ABORTED': Execution was manually stopped
--
-- Why: Distinguishes between:
--   1. Task completed successfully but goal not found (execution_status=SUCCEEDED, goal_found=false)
--   2. Execution crashed before completion (execution_status=FAILED, completed_at=NULL)
--   3. Lambda timeout (execution_status=TIMED_OUT)
--
-- Set at:
--   - 'RUNNING' at experiment creation
--   - Updated to final status when execution completes (success or failure)
--
-- Note: This is the EXECUTION status, not the task outcome.
-- An execution can SUCCEED even if the agent never finds the goal.
ALTER TABLE experiments
ADD COLUMN execution_status VARCHAR(20) DEFAULT 'RUNNING';

COMMENT ON COLUMN experiments.execution_status IS
'Step Functions execution status: RUNNING, SUCCEEDED, FAILED, TIMED_OUT, or ABORTED. Tracks execution health, not task outcome. A SUCCEEDED execution may still have goal_found=false.';

-- Column 4: last_error
-- Structured error information when execution fails
-- JSONB format: {
--   "error": "Lambda.Timeout" | "States.TaskFailed" | "States.Runtime" | etc,
--   "cause": "Detailed error message from AWS",
--   "timestamp": "2025-10-31T12:34:56.789Z"
-- }
--
-- Why: Provides structured error details for debugging without manual AWS API calls
-- Common error types:
--   - Lambda.Timeout: Lambda exceeded 15-minute limit
--   - States.TaskFailed: Lambda returned error (e.g., Ollama unreachable)
--   - States.Runtime: Step Functions execution error (malformed state machine)
--   - Lambda.Unknown: Unhandled exception in Lambda code
--
-- Complements existing failure_reason column:
--   - failure_reason: Task-level failures (e.g., "agent stuck in loop", "invalid move")
--   - last_error: Execution-level failures (e.g., "Lambda timeout", "out of memory")
--
-- Set at: Execution failure (only populated if execution_status != SUCCEEDED)
ALTER TABLE experiments
ADD COLUMN last_error JSONB;

COMMENT ON COLUMN experiments.last_error IS
'Structured error details when execution fails. JSON format: {error, cause, timestamp}. Captures execution-level failures (timeouts, crashes) vs task-level failures (stored in failure_reason).';

-- Column 5: sqs_message_id (optional but useful)
-- SQS message ID that triggered this experiment
-- Format: UUID from SQS (e.g., "12345678-1234-5678-1234-567812345678")
--
-- Why: Enables full tracing of experiment lifecycle:
--   1. trigger-by-name.sh sends message to SQS → sqs_message_id
--   2. Step Functions polls SQS and starts execution → execution_arn
--   3. Lambda creates experiment record → experiments.id
--   4. Agent performs actions → agent_actions.experiment_id
--
-- Useful for debugging:
--   - "Was this message processed twice?" (check for duplicate sqs_message_id)
--   - "How long between queue and execution?" (compare message timestamp to started_at)
--   - "Which messages are still in queue?" (compare SQS to DB)
--
-- Set at: Experiment creation (passed from Step Functions context)
ALTER TABLE experiments
ADD COLUMN sqs_message_id TEXT;

COMMENT ON COLUMN experiments.sqs_message_id IS
'SQS message ID that triggered this experiment. Enables full lifecycle tracing from queue → execution → experiment. Useful for detecting duplicate processing and queue lag.';

-- Create index on execution_status for fast queries like:
-- "Find all RUNNING experiments that started > 1 hour ago" (stuck executions)
-- "Count FAILED executions in the last 24 hours" (error rate monitoring)
CREATE INDEX idx_experiments_execution_status ON experiments(execution_status);

COMMENT ON INDEX idx_experiments_execution_status IS
'Speeds up queries filtering by execution_status, especially for monitoring stuck RUNNING executions or counting FAILED executions.';

-- Create index on execution_arn for direct lookups
-- Used when we have ARN from AWS CLI output and want to find the experiment
CREATE INDEX idx_experiments_execution_arn ON experiments(execution_arn);

COMMENT ON INDEX idx_experiments_execution_arn IS
'Enables fast lookup by execution ARN when diagnosing failures from AWS CLI output.';

-- Composite index for finding stuck experiments
-- Common query: WHERE execution_status = 'RUNNING' AND started_at < NOW() - INTERVAL '1 hour'
CREATE INDEX idx_experiments_stuck_runs ON experiments(execution_status, started_at)
WHERE execution_status = 'RUNNING';

COMMENT ON INDEX idx_experiments_stuck_runs IS
'Partial index for efficiently finding stuck RUNNING experiments. Used by monitoring queries to detect executions that started long ago but never completed.';

-- Update table comment to explain the execution tracking pattern
COMMENT ON TABLE experiments IS
'Stores maze navigation experiment runs. Each experiment represents one agent attempting to navigate a maze.

Execution Tracking Pattern:
- execution_arn, execution_name, sqs_message_id: Set at START, never change
- execution_status: Set to RUNNING at start, updated to SUCCEEDED/FAILED at end
- completed_at, goal_found, failure_reason: Set at END (may be NULL if execution crashes)
- last_error: Only set if execution_status = FAILED/TIMED_OUT/ABORTED

This two-phase approach ensures we can always diagnose failures, even if the execution crashes before writing final results.';
