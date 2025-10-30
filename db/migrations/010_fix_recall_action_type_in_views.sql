-- Fix recall action type in all views
-- BUG: Views were checking for 'recall_all' but system uses 'recall_movement_history'
-- Impact: All recall metrics have been showing 0 across all views (237 actual recalls exist)
-- Created: 2025-10-30

-- Fix v_experiment_summary (used by v_model_performance, v_daily_summary, v_prompt_variant_analysis)
CREATE OR REPLACE VIEW v_experiment_summary AS
SELECT
  e.id,
  e.model_name,
  e.prompt_version,
  e.agent_id,
  e.started_at,
  e.completed_at,
  e.goal_found AS success,
  EXTRACT(EPOCH FROM (e.completed_at - e.started_at)) / 60 AS duration_minutes,
  COUNT(DISTINCT aa.turn_number) AS total_turns,
  COUNT(aa.id) AS total_actions,
  ROUND(COUNT(aa.id)::numeric / NULLIF(COUNT(DISTINCT aa.turn_number), 0), 2) AS avg_actions_per_turn,
  e.total_input_tokens,
  e.total_output_tokens,
  (e.total_input_tokens + e.total_output_tokens) AS total_tokens,
  e.total_cost_usd,
  ROUND(e.total_cost_usd / NULLIF(COUNT(aa.id), 0), 6) AS cost_per_action,
  ROUND((e.total_input_tokens + e.total_output_tokens)::numeric / NULLIF(COUNT(aa.id), 0), 0) AS tokens_per_action,
  COUNT(CASE WHEN aa.success = true AND aa.action_type LIKE 'move_%' THEN 1 END) AS successful_moves,
  COUNT(CASE WHEN aa.success = false AND aa.action_type LIKE 'move_%' THEN 1 END) AS failed_moves,
  ROUND(
    COUNT(CASE WHEN aa.success = true AND aa.action_type LIKE 'move_%' THEN 1 END)::numeric /
    NULLIF(COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END), 0) * 100,
    1
  ) AS move_success_rate_pct,
  COUNT(CASE WHEN aa.action_type = 'recall_movement_history' THEN 1 END) AS recall_count  -- FIXED: was 'recall_all'
FROM v_experiments_with_costs e
LEFT JOIN agent_actions aa ON e.id = aa.experiment_id
WHERE e.completed_at IS NOT NULL
GROUP BY e.id, e.model_name, e.prompt_version, e.agent_id, e.started_at, e.completed_at,
         e.goal_found, e.total_input_tokens, e.total_output_tokens, e.total_cost_usd
ORDER BY e.id DESC;

COMMENT ON VIEW v_experiment_summary IS 'Comprehensive per-experiment metrics combining experiments and agent_actions. Includes success rate, tokens, cost, move success, and recall usage. Base view for model_performance, daily_summary, and prompt_variant_analysis views.';

-- Fix v_action_patterns
CREATE OR REPLACE VIEW v_action_patterns AS
SELECT
  e.id AS experiment_id,
  e.model_name,
  e.prompt_version,
  COUNT(*) AS total_actions,
  COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END) AS movement_actions,
  COUNT(CASE WHEN aa.action_type = 'recall_movement_history' THEN 1 END) AS recall_actions,  -- FIXED: was 'recall_all'
  ROUND(COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS movement_percentage,
  COUNT(CASE WHEN aa.action_type = 'move_north' THEN 1 END) AS north_count,
  COUNT(CASE WHEN aa.action_type = 'move_south' THEN 1 END) AS south_count,
  COUNT(CASE WHEN aa.action_type = 'move_east' THEN 1 END) AS east_count,
  COUNT(CASE WHEN aa.action_type = 'move_west' THEN 1 END) AS west_count,
  COUNT(CASE WHEN aa.success = false THEN 1 END) AS wall_collisions,
  ROUND(COUNT(*)::numeric / NULLIF(COUNT(CASE WHEN aa.action_type = 'recall_movement_history' THEN 1 END), 0), 1) AS avg_actions_between_recalls  -- FIXED: was 'recall_all'
FROM experiments e
JOIN agent_actions aa ON e.id = aa.experiment_id
GROUP BY e.id, e.model_name, e.prompt_version
ORDER BY e.id;

-- Comment already exists for v_action_patterns, no need to re-add

-- Fix v_turn_statistics
CREATE OR REPLACE VIEW v_turn_statistics AS
SELECT
  aa.experiment_id,
  e.model_name,
  e.prompt_version,
  aa.turn_number,
  COUNT(*) AS total_actions,
  COUNT(CASE WHEN aa.action_type = 'move_north' THEN 1 END) AS north_moves,
  COUNT(CASE WHEN aa.action_type = 'move_south' THEN 1 END) AS south_moves,
  COUNT(CASE WHEN aa.action_type = 'move_east' THEN 1 END) AS east_moves,
  COUNT(CASE WHEN aa.action_type = 'move_west' THEN 1 END) AS west_moves,
  COUNT(CASE WHEN aa.action_type = 'recall_movement_history' THEN 1 END) AS recalls,  -- FIXED: was 'recall_all'
  COUNT(CASE WHEN aa.success = true THEN 1 END) AS successful_actions,
  ROUND(COUNT(CASE WHEN aa.success = true THEN 1 END)::numeric / COUNT(*) * 100, 1) AS success_rate_pct,
  MAX(CASE WHEN aa.to_x IS NOT NULL THEN aa.to_x ELSE aa.from_x END) AS final_x,
  MAX(CASE WHEN aa.to_y IS NOT NULL THEN aa.to_y ELSE aa.from_y END) AS final_y
FROM agent_actions aa
JOIN experiments e ON aa.experiment_id = e.id
WHERE aa.turn_number IS NOT NULL
GROUP BY aa.experiment_id, e.model_name, e.prompt_version, aa.turn_number
ORDER BY aa.experiment_id, aa.turn_number;

-- Comment already exists for v_turn_statistics, no need to re-add
