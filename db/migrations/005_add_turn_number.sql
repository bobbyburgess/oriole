-- Add turn_number to track which agent invocation each action belongs to
-- Created: 2025-10-23
--
-- This allows grouping tool calls by agent invocation to analyze patterns like:
-- - How many tools does each model call per invocation?
-- - Do models batch their tool calls or make them one at a time?

ALTER TABLE agent_actions ADD COLUMN turn_number INT;

-- Add index for querying actions by turn
CREATE INDEX idx_agent_actions_turn ON agent_actions(experiment_id, turn_number);
