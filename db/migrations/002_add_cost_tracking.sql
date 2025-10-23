-- Add detailed token and cost tracking
-- Created: 2025-10-23

-- Add columns to experiments table for total cost tracking
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS total_input_tokens BIGINT DEFAULT 0;
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS total_output_tokens BIGINT DEFAULT 0;
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS total_cost_usd DECIMAL(10, 6) DEFAULT 0.0;

-- Add columns to agent_actions table for per-action tracking
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS input_tokens INT;
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS output_tokens INT;
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS cost_usd DECIMAL(10, 6);

-- Update comment on existing tokens_used column
COMMENT ON COLUMN agent_actions.tokens_used IS 'Legacy total tokens (deprecated - use input_tokens + output_tokens)';

-- Add indexes for cost analysis queries
CREATE INDEX IF NOT EXISTS idx_experiments_total_cost ON experiments(total_cost_usd);
CREATE INDEX IF NOT EXISTS idx_experiments_total_tokens ON experiments(total_input_tokens, total_output_tokens);
