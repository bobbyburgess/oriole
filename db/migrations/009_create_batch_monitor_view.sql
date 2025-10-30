-- Create comprehensive batch monitoring view
-- Mirrors check-batch-results.sh output for easy TablePlus refreshing
-- Created: 2025-10-29

CREATE OR REPLACE VIEW v_batch_monitor AS
SELECT
  e.id,
  e.model_name,
  COALESCE(e.prompt_version, '-') as prompt_version,
  e.comment,

  -- Model config parameters
  COALESCE((e.model_config->>'num_ctx')::text, '-') as context,
  COALESCE((e.model_config->>'temperature')::text, '-') as temp,

  -- Move and action counts
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%') as successful_moves,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id) as total_actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) as turns,

  -- Efficiency metrics
  ROUND(
    100.0 * (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%')::numeric /
    NULLIF((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id), 0),
    1
  ) as pct_moves,

  ROUND(
    (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%')::numeric /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id), 0),
    1
  ) as moves_per_turn,

  ROUND(
    (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)::numeric /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id), 0),
    1
  ) as actions_per_turn,

  (SELECT MAX(action_count)
   FROM (
     SELECT COUNT(*) as action_count
     FROM agent_actions
     WHERE experiment_id = e.id
     GROUP BY turn_number
   ) turn_counts
  ) as most_actions_in_turn,

  -- Token usage
  (SELECT SUM(input_tokens) FROM agent_actions WHERE experiment_id = e.id) as tokens_in,
  (SELECT SUM(output_tokens) FROM agent_actions WHERE experiment_id = e.id) as tokens_out,

  -- Speed metrics
  ROUND(
    (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id)::numeric /
    NULLIF(EXTRACT(EPOCH FROM (COALESCE(e.completed_at, NOW()) - e.started_at)) / 60.0, 0),
    1
  ) as actions_per_min,

  -- Progress tracking
  CASE
    WHEN e.model_config->>'max_moves' IS NOT NULL THEN
      ROUND(100.0 * (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%') /
            NULLIF((e.model_config->>'max_moves')::numeric, 0), 1)
    ELSE NULL
  END as progress_pct,

  -- ETA calculation
  CASE
    WHEN e.completed_at IS NOT NULL THEN NULL
    WHEN e.model_config->>'max_moves' IS NOT NULL AND
         (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%') > 0 THEN
      CASE
        WHEN ((e.model_config->>'max_moves')::numeric - (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%')) <= 0 THEN 0
        ELSE
          ROUND(
            ((e.model_config->>'max_moves')::numeric - (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%')) /
            NULLIF((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND success = true AND action_type LIKE 'move_%')::numeric /
                   NULLIF(EXTRACT(EPOCH FROM (NOW() - e.started_at)) / 60.0, 0), 0)
          )::int
      END
    ELSE NULL
  END as eta_minutes,

  -- Status and timing
  CASE
    WHEN e.goal_found THEN 'GOAL'
    WHEN e.completed_at IS NOT NULL AND e.failure_reason IS NOT NULL THEN 'FAILED'
    WHEN e.completed_at IS NOT NULL THEN 'DONE'
    WHEN (SELECT MAX(timestamp) FROM agent_actions WHERE experiment_id = e.id) IS NULL THEN 'STARTING'
    ELSE 'RUNNING'
  END as status,

  EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(timestamp) FROM agent_actions WHERE experiment_id = e.id)))::int as seconds_since_last_action,

  EXTRACT(EPOCH FROM (COALESCE(e.completed_at, NOW()) - e.started_at))::int as duration_seconds,

  -- Timestamps
  e.started_at,
  e.completed_at,
  (SELECT MAX(timestamp) FROM agent_actions WHERE experiment_id = e.id) as last_action_at,

  -- Goal tracking
  e.goal_found,
  e.failure_reason,

  -- Recall usage
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND action_type = 'recall_movement_history') as recall_count,

  -- Final position
  (SELECT to_x FROM agent_actions WHERE experiment_id = e.id ORDER BY id DESC LIMIT 1) as final_x,
  (SELECT to_y FROM agent_actions WHERE experiment_id = e.id ORDER BY id DESC LIMIT 1) as final_y

FROM experiments e
ORDER BY e.id DESC;

-- Create indexes for better view performance
CREATE INDEX IF NOT EXISTS idx_agent_actions_experiment_success
  ON agent_actions(experiment_id, success) WHERE action_type LIKE 'move_%';

CREATE INDEX IF NOT EXISTS idx_agent_actions_experiment_turn
  ON agent_actions(experiment_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_agent_actions_experiment_timestamp
  ON agent_actions(experiment_id, timestamp DESC);

COMMENT ON VIEW v_batch_monitor IS 'Comprehensive experiment monitoring view - mirrors check-batch-results.sh for TablePlus';
