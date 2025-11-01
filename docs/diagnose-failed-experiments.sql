-- Diagnostic Queries for Failed Experiments
-- Uses execution tracking columns added in migration 015
--
-- Purpose: Quickly identify and diagnose experiments that failed without
-- proper completion (NULL completed_at, execution crashes, timeouts, etc.)
--
-- Usage: Run these queries when you notice experiments are stuck or failed

-- ============================================================================
-- 1. Find ALL stuck experiments (started but never completed)
-- ============================================================================
-- These are experiments that started but never finished updating the DB.
-- Possible causes:
--   - Lambda timeout (15 min limit)
--   - Unhandled exception
--   - Network issue preventing final DB write
--   - Step Functions execution still running (check execution_status)
--
SELECT
  id,
  model_name,
  model_config->>'temperature' as temp,
  started_at,
  execution_status,
  execution_name,
  EXTRACT(EPOCH FROM (NOW() - started_at))/3600 as hours_since_start,
  -- Quick AWS CLI command to check execution status
  'aws stepfunctions describe-execution --execution-arn "' || execution_arn || '"' as aws_cli_command
FROM experiments
WHERE completed_at IS NULL
ORDER BY started_at DESC;

-- ============================================================================
-- 2. Find stuck RUNNING experiments (likely crashed without updating status)
-- ============================================================================
-- If execution_status is still 'RUNNING' after > 1 hour, the execution
-- probably crashed or timed out without updating the DB.
--
-- These need manual investigation via AWS CLI using the execution_arn.
--
SELECT
  id,
  model_name,
  started_at,
  execution_name,
  EXTRACT(EPOCH FROM (NOW() - started_at))/3600 as hours_running,
  -- Direct link to CloudWatch Logs (replace REGION if not us-west-2)
  '/aws/lambda/oriole-invoke-agent-ollama execution_name: ' || execution_name as cloudwatch_log_filter
FROM experiments
WHERE execution_status = 'RUNNING'
  AND started_at < NOW() - INTERVAL '1 hour'
ORDER BY started_at;

-- ============================================================================
-- 3. Analyze execution failures by error type
-- ============================================================================
-- Group failures by error type to identify patterns:
--   - Lambda.Timeout: Lambda exceeded 15-minute limit
--   - States.TaskFailed: Lambda returned error (check Cause for details)
--   - States.Timeout: Step Functions max execution time exceeded
--
SELECT
  last_error->>'error' as error_type,
  COUNT(*) as failure_count,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))/60) as avg_duration_minutes,
  -- Sample execution ARNs for investigation
  ARRAY_AGG(execution_arn ORDER BY started_at DESC LIMIT 3) as sample_arns
FROM experiments
WHERE execution_status IN ('FAILED', 'TIMED_OUT', 'ABORTED')
  AND last_error IS NOT NULL
GROUP BY last_error->>'error'
ORDER BY failure_count DESC;

-- ============================================================================
-- 4. View detailed error info for recent failures
-- ============================================================================
-- Shows last 10 failed experiments with full error details.
-- Use this to understand WHAT went wrong and WHERE to investigate.
--
SELECT
  id,
  model_name,
  execution_status,
  started_at,
  completed_at,
  EXTRACT(EPOCH FROM (completed_at - started_at))/60 as duration_minutes,
  -- Parse structured error
  last_error->>'error' as error_type,
  last_error->>'cause' as error_cause,
  last_error->>'timestamp' as error_timestamp,
  failure_reason,
  -- AWS CLI command to get full execution history
  'aws stepfunctions get-execution-history --execution-arn "' || execution_arn ||
    '" --max-results 50 --reverse-order' as aws_cli_history
FROM experiments
WHERE execution_status IN ('FAILED', 'TIMED_OUT', 'ABORTED')
ORDER BY started_at DESC
LIMIT 10;

-- ============================================================================
-- 5. Compare completed vs failed experiments by model/temperature
-- ============================================================================
-- Useful for identifying if certain configurations are more prone to failures.
-- Example: Does qwen2.5:14b-128k timeout more than qwen2.5:7b-128k?
--
SELECT
  model_name,
  model_config->>'temperature' as temperature,
  COUNT(*) FILTER (WHERE execution_status = 'SUCCEEDED') as succeeded,
  COUNT(*) FILTER (WHERE execution_status = 'FAILED') as failed,
  COUNT(*) FILTER (WHERE execution_status = 'TIMED_OUT') as timed_out,
  COUNT(*) FILTER (WHERE execution_status = 'RUNNING') as still_running,
  -- Success rate (only counting completed executions)
  ROUND(
    COUNT(*) FILTER (WHERE execution_status = 'SUCCEEDED')::numeric /
    NULLIF(COUNT(*) FILTER (WHERE execution_status != 'RUNNING'), 0) * 100,
    1
  ) as success_rate_pct
FROM experiments
GROUP BY model_name, model_config->>'temperature'
ORDER BY model_name, (model_config->>'temperature')::float;

-- ============================================================================
-- 6. Find experiments with specific SQS message ID (duplicate detection)
-- ============================================================================
-- If you suspect an SQS message was processed twice (FIFO queue deduplication
-- failure), use this to find all experiments triggered by the same message.
--
-- Replace 'YOUR_MESSAGE_ID' with actual SQS message ID.
--
SELECT
  id,
  sqs_message_id,
  execution_name,
  started_at,
  execution_status,
  goal_found
FROM experiments
WHERE sqs_message_id = 'YOUR_MESSAGE_ID'
ORDER BY started_at;

-- ============================================================================
-- 7. Diagnose experiments 5 and 6 specifically (from user's current issue)
-- ============================================================================
-- These experiments had NULL completed_at when checked.
-- Let's see their execution status and get AWS CLI commands to investigate.
--
SELECT
  id,
  model_config->>'temperature' as temp,
  started_at,
  completed_at,
  execution_status,
  last_error->>'error' as error_type,
  execution_name,
  EXTRACT(EPOCH FROM (NOW() - started_at))/3600 as hours_since_start,
  -- Max step number from agent_actions (to see where it died)
  (SELECT MAX(step_number) FROM agent_actions WHERE experiment_id = experiments.id) as last_step,
  -- Time of last action (to see when it actually stopped)
  (SELECT MAX(timestamp) FROM agent_actions WHERE experiment_id = experiments.id) as last_action_time,
  -- AWS CLI to describe execution
  'aws stepfunctions describe-execution --execution-arn "' || execution_arn || '" --profile bobby' as describe_cmd,
  -- AWS CLI to get failure details
  'aws stepfunctions get-execution-history --execution-arn "' || execution_arn ||
    '" --max-results 10 --reverse-order --profile bobby' as history_cmd
FROM experiments
WHERE id IN (5, 6);

-- ============================================================================
-- EXAMPLE AWS CLI WORKFLOW
-- ============================================================================
-- Once you have an execution_arn from the queries above:
--
-- 1. Check execution status:
--    aws stepfunctions describe-execution \
--      --execution-arn "arn:aws:states:us-west-2:...:execution:oriole-experiment-runner:ollama_..." \
--      --profile bobby
--
-- 2. Get execution history (last 10 events):
--    aws stepfunctions get-execution-history \
--      --execution-arn "arn:aws:states:us-west-2:...:execution:oriole-experiment-runner:ollama_..." \
--      --max-results 10 \
--      --reverse-order \
--      --profile bobby
--
-- 3. View CloudWatch logs:
--    aws logs tail /aws/lambda/oriole-invoke-agent-ollama \
--      --follow \
--      --filter-pattern "ollama_00f202bf-0145-65a9-7f0a-b2be5f9e308b" \
--      --profile bobby
--
-- ============================================================================
-- CLEANUP: Mark stuck experiments as failed (MANUAL INTERVENTION)
-- ============================================================================
-- After investigating, if you want to manually mark stuck experiments as failed:
--
-- WARNING: Only run this after confirming experiments are truly stuck!
-- This updates execution_status to FAILED and sets completed_at.
--
-- UPDATE experiments
-- SET
--   execution_status = 'FAILED',
--   completed_at = NOW(),
--   goal_found = false,
--   failure_reason = 'Manually marked as failed - execution stuck in RUNNING state',
--   last_error = jsonb_build_object(
--     'error', 'ManualIntervention',
--     'cause', 'Experiment stuck in RUNNING state for > N hours, manually marked as failed',
--     'timestamp', NOW()
--   )
-- WHERE execution_status = 'RUNNING'
--   AND started_at < NOW() - INTERVAL '2 hours'
--   AND id IN (5, 6);  -- Replace with actual stuck experiment IDs
--
-- RETURNING id, execution_name, started_at, execution_status;
