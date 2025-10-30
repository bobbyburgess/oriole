-- Add comments to undocumented views and improve Ollama model support
-- Created: 2025-10-30

-- Add comment to v_experiments_with_costs (and improve Ollama handling)
CREATE OR REPLACE VIEW v_experiments_with_costs AS
SELECT
  e.id,
  e.agent_id,
  e.model_name,
  e.prompt_version,
  e.maze_id,
  e.start_x,
  e.start_y,
  e.started_at,
  e.completed_at,
  e.goal_found,
  e.failure_reason,
  COALESCE(SUM(aa.input_tokens), 0) AS total_input_tokens,
  COALESCE(SUM(aa.output_tokens), 0) AS total_output_tokens,
  CASE e.model_name
    -- AWS Bedrock: Claude models
    WHEN 'claude-3.5-haiku' THEN COALESCE(SUM(aa.input_tokens * 0.8 / 1000000.0 + aa.output_tokens * 4.0 / 1000000.0), 0.0)
    WHEN 'claude-3-haiku' THEN COALESCE(SUM(aa.input_tokens * 0.25 / 1000000.0 + aa.output_tokens * 1.25 / 1000000.0), 0.0)
    -- AWS Bedrock: Nova models
    WHEN 'nova-micro' THEN COALESCE(SUM(aa.input_tokens * 0.035 / 1000000.0 + aa.output_tokens * 0.14 / 1000000.0), 0.0)
    WHEN 'nova-lite' THEN COALESCE(SUM(aa.input_tokens * 0.06 / 1000000.0 + aa.output_tokens * 0.24 / 1000000.0), 0.0)
    WHEN 'nova-pro' THEN COALESCE(SUM(aa.input_tokens * 0.8 / 1000000.0 + aa.output_tokens * 3.2 / 1000000.0), 0.0)
    WHEN 'nova-premier' THEN COALESCE(SUM(aa.input_tokens * 3.0 / 1000000.0 + aa.output_tokens * 12.0 / 1000000.0), 0.0)
    -- Local Ollama models: Free (models containing ':' are Ollama format like qwen2.5:14b)
    ELSE
      CASE
        WHEN e.model_name LIKE '%:%' THEN 0.0  -- Ollama models (free)
        ELSE 0.0  -- Unknown models default to $0
      END
  END::numeric(10,6) AS total_cost_usd
FROM experiments e
LEFT JOIN agent_actions aa ON e.id = aa.experiment_id
GROUP BY e.id, e.agent_id, e.model_name, e.prompt_version, e.maze_id,
         e.start_x, e.start_y, e.started_at, e.completed_at, e.goal_found, e.failure_reason;

COMMENT ON VIEW v_experiments_with_costs IS 'Base view combining experiments with aggregated token usage and calculated costs. AWS Bedrock models use API pricing ($0.80-12.00/MTok), Ollama models are free (local inference). Used by v_experiment_summary, v_cost_analysis, and other aggregation views.';

-- Add comment to v_model_performance
COMMENT ON VIEW v_model_performance IS 'Model comparison metrics: success rates, average actions/turns/duration, token usage, and total costs. Groups by model_name to compare different LLMs (Bedrock vs Ollama, size variants, etc). Useful for A/B testing and cost/performance tradeoffs.';

-- Add comment to v_cost_analysis
COMMENT ON VIEW v_cost_analysis IS 'Financial analysis per experiment: total tokens, costs, cost per action, cost per million tokens, and cost for successful runs only. Useful for budgeting and identifying expensive experiments. Excludes Ollama models (free).';

-- Add comment to v_daily_summary
COMMENT ON VIEW v_daily_summary IS 'Daily rollup of experiment activity: count, success rate, tokens, costs, and models tested. Tracks experimentation velocity and spending over time. Useful for monitoring research progress and budget burn rate.';

-- Add comment to v_prompt_variant_analysis
COMMENT ON VIEW v_prompt_variant_analysis IS 'Compares prompt versions across models: success rates, efficiency (actions/turns), recall usage, move success, and costs. Enables prompt engineering A/B tests to identify which prompt variations work best for each model. Group by (prompt_version, model_name).';
