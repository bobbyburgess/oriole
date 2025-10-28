-- PostgreSQL views for experiment analysis
-- These views aggregate and summarize data for easier querying and analysis

-- ============================================================================
-- 1. EXPERIMENT SUMMARY VIEW
-- High-level metrics for each experiment with calculated efficiency scores
-- ============================================================================
CREATE OR REPLACE VIEW v_experiment_summary AS
SELECT
  e.id,
  e.model_name,
  e.prompt_version,
  e.agent_id,
  e.started_at,
  e.completed_at,
  e.goal_found AS success,  -- Alias for compatibility with downstream views

  -- Time metrics
  EXTRACT(EPOCH FROM (e.completed_at - e.started_at)) / 60 AS duration_minutes,

  -- Action metrics
  COUNT(DISTINCT aa.turn_number) AS total_turns,
  COUNT(aa.id) AS total_actions,
  ROUND(COUNT(aa.id)::numeric / NULLIF(COUNT(DISTINCT aa.turn_number), 0), 2) AS avg_actions_per_turn,

  -- Token metrics
  e.total_input_tokens,
  e.total_output_tokens,
  e.total_input_tokens + e.total_output_tokens AS total_tokens,

  -- Cost metrics
  e.total_cost_usd,

  -- Efficiency metrics
  ROUND(e.total_cost_usd / NULLIF(COUNT(aa.id), 0), 6) AS cost_per_action,
  ROUND((e.total_input_tokens + e.total_output_tokens)::numeric / NULLIF(COUNT(aa.id), 0), 0) AS tokens_per_action,

  -- Movement efficiency
  COUNT(CASE WHEN aa.success = true AND aa.action_type LIKE 'move_%' THEN 1 END) AS successful_moves,
  COUNT(CASE WHEN aa.success = false AND aa.action_type LIKE 'move_%' THEN 1 END) AS failed_moves,
  ROUND(
    COUNT(CASE WHEN aa.success = true AND aa.action_type LIKE 'move_%' THEN 1 END)::numeric /
    NULLIF(COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END), 0) * 100,
    1
  ) AS move_success_rate_pct,

  -- Tool usage patterns
  COUNT(CASE WHEN aa.action_type = 'recall_all' THEN 1 END) AS recall_count

FROM v_experiments_with_costs e  -- Use view for calculated token/cost columns
LEFT JOIN agent_actions aa ON e.id = aa.experiment_id
WHERE e.completed_at IS NOT NULL  -- Only completed experiments
GROUP BY e.id, e.model_name, e.prompt_version, e.agent_id, e.started_at, e.completed_at,
         e.goal_found, e.total_input_tokens, e.total_output_tokens, e.total_cost_usd
ORDER BY e.id DESC;


-- ============================================================================
-- 2. MODEL PERFORMANCE COMPARISON VIEW
-- Aggregate statistics by model for comparison
-- ============================================================================
CREATE OR REPLACE VIEW v_model_performance AS
SELECT
  model_name,

  -- Experiment counts
  COUNT(*) AS total_experiments,
  COUNT(CASE WHEN success = true THEN 1 END) AS successful_experiments,
  ROUND(
    COUNT(CASE WHEN success = true THEN 1 END)::numeric / COUNT(*) * 100,
    1
  ) AS success_rate_pct,

  -- Average metrics
  ROUND(AVG(total_actions), 1) AS avg_actions,
  ROUND(AVG(total_turns), 1) AS avg_turns,
  ROUND(AVG(duration_minutes), 1) AS avg_duration_minutes,

  -- Token metrics
  ROUND(AVG(total_tokens), 0) AS avg_total_tokens,
  ROUND(AVG(tokens_per_action), 1) AS avg_tokens_per_action,

  -- Cost metrics
  ROUND(AVG(total_cost_usd), 6) AS avg_cost_per_experiment,
  ROUND(AVG(cost_per_action), 6) AS avg_cost_per_action,
  ROUND(SUM(total_cost_usd), 4) AS total_cost_usd,

  -- Efficiency metrics
  ROUND(AVG(move_success_rate_pct), 1) AS avg_move_success_rate_pct,
  ROUND(AVG(recall_count), 1) AS avg_recalls_per_experiment

FROM v_experiment_summary
GROUP BY model_name
ORDER BY model_name;


-- ============================================================================
-- 3. PROMPT VARIANT ANALYSIS VIEW
-- Compare different prompt versions
-- ============================================================================
CREATE OR REPLACE VIEW v_prompt_variant_analysis AS
SELECT
  prompt_version,
  model_name,

  -- Experiment counts
  COUNT(*) AS experiment_count,
  COUNT(CASE WHEN success = true THEN 1 END) AS successful_count,
  ROUND(
    COUNT(CASE WHEN success = true THEN 1 END)::numeric / COUNT(*) * 100,
    1
  ) AS success_rate_pct,

  -- Behavioral metrics
  ROUND(AVG(total_actions), 1) AS avg_actions,
  ROUND(AVG(total_turns), 1) AS avg_turns,
  ROUND(AVG(avg_actions_per_turn), 2) AS avg_actions_per_turn,
  ROUND(AVG(recall_count), 1) AS avg_recalls,

  -- Efficiency metrics
  ROUND(AVG(move_success_rate_pct), 1) AS avg_move_success_pct,
  ROUND(AVG(tokens_per_action), 1) AS avg_tokens_per_action,
  ROUND(AVG(cost_per_action), 6) AS avg_cost_per_action,

  -- Cost totals
  ROUND(SUM(total_cost_usd), 4) AS total_cost

FROM v_experiment_summary
GROUP BY prompt_version, model_name
ORDER BY prompt_version, model_name;


-- ============================================================================
-- 4. TURN STATISTICS VIEW
-- Detailed turn-level analysis for understanding agent behavior over time
-- ============================================================================
CREATE OR REPLACE VIEW v_turn_statistics AS
SELECT
  aa.experiment_id,
  e.model_name,
  e.prompt_version,
  aa.turn_number,

  -- Action counts by type
  COUNT(*) AS total_actions,
  COUNT(CASE WHEN aa.action_type = 'move_north' THEN 1 END) AS north_moves,
  COUNT(CASE WHEN aa.action_type = 'move_south' THEN 1 END) AS south_moves,
  COUNT(CASE WHEN aa.action_type = 'move_east' THEN 1 END) AS east_moves,
  COUNT(CASE WHEN aa.action_type = 'move_west' THEN 1 END) AS west_moves,
  COUNT(CASE WHEN aa.action_type = 'recall_all' THEN 1 END) AS recalls,

  -- Success metrics
  COUNT(CASE WHEN aa.success = true THEN 1 END) AS successful_actions,
  ROUND(
    COUNT(CASE WHEN aa.success = true THEN 1 END)::numeric / COUNT(*) * 100,
    1
  ) AS success_rate_pct,

  -- Spatial metrics (last position in turn)
  MAX(CASE WHEN aa.to_x IS NOT NULL THEN aa.to_x ELSE aa.from_x END) AS final_x,
  MAX(CASE WHEN aa.to_y IS NOT NULL THEN aa.to_y ELSE aa.from_y END) AS final_y

FROM agent_actions aa
JOIN experiments e ON aa.experiment_id = e.id
WHERE aa.turn_number IS NOT NULL
GROUP BY aa.experiment_id, e.model_name, e.prompt_version, aa.turn_number
ORDER BY aa.experiment_id, aa.turn_number;


-- ============================================================================
-- 5. ACTION PATTERN ANALYSIS VIEW
-- Tool usage patterns and sequences for understanding decision-making
-- ============================================================================
CREATE OR REPLACE VIEW v_action_patterns AS
SELECT
  e.id AS experiment_id,
  e.model_name,
  e.prompt_version,

  -- Tool usage distribution
  COUNT(*) AS total_actions,
  COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END) AS movement_actions,
  COUNT(CASE WHEN aa.action_type = 'recall_all' THEN 1 END) AS recall_actions,

  ROUND(
    COUNT(CASE WHEN aa.action_type LIKE 'move_%' THEN 1 END)::numeric /
    NULLIF(COUNT(*), 0) * 100,
    1
  ) AS movement_percentage,

  -- Directional preference
  COUNT(CASE WHEN aa.action_type = 'move_north' THEN 1 END) AS north_count,
  COUNT(CASE WHEN aa.action_type = 'move_south' THEN 1 END) AS south_count,
  COUNT(CASE WHEN aa.action_type = 'move_east' THEN 1 END) AS east_count,
  COUNT(CASE WHEN aa.action_type = 'move_west' THEN 1 END) AS west_count,

  -- Backtracking detection (failed moves suggesting walls)
  COUNT(CASE WHEN aa.success = false THEN 1 END) AS wall_collisions,

  -- Recall frequency (actions between recalls)
  ROUND(
    COUNT(*)::numeric / NULLIF(COUNT(CASE WHEN aa.action_type = 'recall_all' THEN 1 END), 0),
    1
  ) AS avg_actions_between_recalls

FROM experiments e
JOIN agent_actions aa ON e.id = aa.experiment_id
GROUP BY e.id, e.model_name, e.prompt_version
ORDER BY e.id;


-- ============================================================================
-- 6. COST ANALYSIS VIEW
-- Detailed cost breakdown and trends
-- ============================================================================
CREATE OR REPLACE VIEW v_cost_analysis AS
SELECT
  e.id AS experiment_id,
  e.model_name,
  e.prompt_version,
  e.started_at::date AS experiment_date,

  -- Token breakdown
  e.total_input_tokens,
  e.total_output_tokens,
  e.total_input_tokens + e.total_output_tokens AS total_tokens,

  -- Cost
  e.total_cost_usd,

  -- Per-action costs
  ROUND(e.total_cost_usd / NULLIF(COUNT(aa.id), 0), 6) AS cost_per_action,

  -- Per-token costs (implied pricing)
  ROUND(
    e.total_cost_usd / NULLIF(e.total_input_tokens + e.total_output_tokens, 0) * 1000000,
    2
  ) AS cost_per_million_tokens,

  -- Success value (cost per successful outcome)
  CASE
    WHEN e.goal_found = true THEN e.total_cost_usd
    ELSE NULL
  END AS cost_if_successful

FROM v_experiments_with_costs e  -- Use view for calculated token/cost columns
LEFT JOIN agent_actions aa ON e.id = aa.experiment_id
WHERE e.completed_at IS NOT NULL
GROUP BY e.id, e.model_name, e.prompt_version, e.started_at, e.completed_at,
         e.goal_found, e.total_input_tokens, e.total_output_tokens, e.total_cost_usd
ORDER BY e.id DESC;


-- ============================================================================
-- 7. DAILY SUMMARY VIEW
-- Aggregate statistics by day for tracking trends
-- ============================================================================
CREATE OR REPLACE VIEW v_daily_summary AS
SELECT
  started_at::date AS date,

  -- Experiment counts
  COUNT(*) AS experiments_run,
  COUNT(CASE WHEN success = true THEN 1 END) AS successful,

  -- Totals
  SUM(total_actions) AS total_actions,
  SUM(total_turns) AS total_turns,
  SUM(total_tokens) AS total_tokens,
  ROUND(SUM(total_cost_usd), 4) AS total_cost_usd,

  -- Averages
  ROUND(AVG(total_actions), 1) AS avg_actions_per_experiment,
  ROUND(AVG(duration_minutes), 1) AS avg_duration_minutes,
  ROUND(AVG(total_cost_usd), 6) AS avg_cost_per_experiment,

  -- Models used
  COUNT(DISTINCT model_name) AS distinct_models_tested,
  array_agg(DISTINCT model_name ORDER BY model_name) AS models_used

FROM v_experiment_summary
GROUP BY started_at::date
ORDER BY date DESC;


-- ============================================================================
-- 8. BATCH MONITORING VIEW
-- Real-time experiment monitoring with movement/tool use distinction
-- Matches the output format of ./scripts/check-batch-results.sh
-- ============================================================================
CREATE OR REPLACE VIEW v_batch_monitor AS
SELECT
  e.id,
  e.model_name,
  COALESCE(e.prompt_version, '-') AS prompt_version,

  -- Movement counts (actual footsteps)
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND action_type LIKE 'move_%' AND success = true) AS successful_moves,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND action_type LIKE 'move_%' AND success = false) AS failed_moves,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND action_type LIKE 'move_%') AS total_move_attempts,

  -- Non-movement tool uses
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id AND action_type NOT LIKE 'move_%') AS tool_uses,

  -- Total actions and turns
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = e.id) AS total_actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) AS total_turns,

  -- Token usage
  COALESCE(
    (SELECT SUM(input_tokens) FROM agent_actions WHERE experiment_id = e.id),
    0
  ) AS total_input_tokens,
  COALESCE(
    (SELECT SUM(output_tokens) FROM agent_actions WHERE experiment_id = e.id),
    0
  ) AS total_output_tokens,

  -- Progress and timing
  CASE
    WHEN e.goal_found THEN 100.0
    WHEN (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) IS NULL THEN 0.0
    ELSE LEAST(
      100.0,
      ((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) * 100.0) /
      COALESCE(
        (e.model_config->>'max_moves')::numeric,
        500
      )
    )
  END AS progress_pct,

  ROUND(
    EXTRACT(EPOCH FROM (COALESCE(e.completed_at, NOW()) - e.started_at)) / 60.0,
    1
  ) AS duration_minutes,

  CASE
    WHEN e.goal_found OR e.failure_reason IS NOT NULL THEN NULL
    WHEN (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id) = 0 THEN NULL
    ELSE ROUND(
      (
        EXTRACT(EPOCH FROM (NOW() - e.started_at)) / 60.0 /
        (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id)
      ) *
      (
        COALESCE((e.model_config->>'max_moves')::numeric, 500) -
        (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = e.id)
      ),
      1
    )
  END AS eta_minutes,

  -- Status
  CASE
    WHEN e.goal_found THEN '✓ GOAL'
    WHEN e.failure_reason IS NOT NULL THEN '✗ FAIL'
    ELSE '▶ RUN'
  END AS status

FROM experiments e
ORDER BY e.id DESC;


-- ============================================================================
-- USAGE EXAMPLES
-- ============================================================================

-- See all experiments with key metrics:
-- SELECT * FROM v_experiment_summary;

-- Compare models:
-- SELECT * FROM v_model_performance;

-- Compare prompt variants for a specific model:
-- SELECT * FROM v_prompt_variant_analysis WHERE model_name = 'claude-3-haiku';

-- Analyze turn-by-turn behavior for an experiment:
-- SELECT * FROM v_turn_statistics WHERE experiment_id = 97;

-- Find most cost-efficient prompt variant:
-- SELECT prompt_version, model_name, avg_cost_per_action
-- FROM v_prompt_variant_analysis
-- ORDER BY avg_cost_per_action;

-- Track daily spending:
-- SELECT date, total_cost_usd, experiments_run FROM v_daily_summary;
