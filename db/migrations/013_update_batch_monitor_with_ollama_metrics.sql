-- Update v_batch_monitor to include Ollama performance metrics
-- Adds aggregate performance statistics for Ollama experiments
-- Created: 2025-10-30

-- Drop and recreate to allow column reordering
DROP VIEW IF EXISTS v_batch_monitor;

CREATE VIEW v_batch_monitor AS
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

  -- Ollama performance metrics (NULL for Bedrock experiments)
  (SELECT ROUND(AVG(inference_duration_ms))::int
   FROM agent_actions
   WHERE experiment_id = e.id AND inference_duration_ms IS NOT NULL
  ) as avg_inference_ms,

  (SELECT ROUND(AVG(prompt_eval_duration_ms))::int
   FROM agent_actions
   WHERE experiment_id = e.id AND prompt_eval_duration_ms IS NOT NULL
  ) as avg_prompt_eval_ms,

  (SELECT ROUND(AVG(eval_duration_ms))::int
   FROM agent_actions
   WHERE experiment_id = e.id AND eval_duration_ms IS NOT NULL
  ) as avg_eval_ms,

  (SELECT ROUND(AVG(tokens_per_second), 1)
   FROM agent_actions
   WHERE experiment_id = e.id AND tokens_per_second IS NOT NULL
  ) as avg_tokens_per_sec,

  (SELECT ROUND(MIN(tokens_per_second), 1)
   FROM agent_actions
   WHERE experiment_id = e.id AND tokens_per_second IS NOT NULL
  ) as min_tokens_per_sec,

  (SELECT ROUND(MAX(tokens_per_second), 1)
   FROM agent_actions
   WHERE experiment_id = e.id AND tokens_per_second IS NOT NULL
  ) as max_tokens_per_sec,

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

COMMENT ON VIEW v_batch_monitor IS 'Comprehensive experiment monitoring view with Ollama performance metrics - mirrors check-batch-results.sh for TablePlus';
