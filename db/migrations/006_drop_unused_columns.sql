-- Drop unused and redundant columns from experiments and agent_actions tables
-- Date: 2025-10-24
--
-- Rationale:
-- 1. tokens_used (agent_actions): Always 0, superseded by input_tokens + output_tokens
-- 2. total_tokens (experiments): Always 0, redundant with total_input_tokens + total_output_tokens
-- 3. prompt_text (experiments): Denormalized copy of Parameter Store data, duplicates prompt_version
-- 4. last_activity (experiments): Only updated at start/end, redundant with completed_at

-- Drop stale token tracking columns
ALTER TABLE agent_actions
  DROP COLUMN IF EXISTS tokens_used;

ALTER TABLE experiments
  DROP COLUMN IF EXISTS total_tokens;

-- Drop redundant activity timestamp
ALTER TABLE experiments
  DROP COLUMN IF EXISTS last_activity;

-- Drop denormalized prompt text (use prompt_version to lookup in Parameter Store)
ALTER TABLE experiments
  DROP COLUMN IF EXISTS prompt_text;

-- Note: Indexes will be automatically dropped when columns are dropped
-- idx_experiments_total_tokens will be removed with total_tokens column
