#!/bin/bash
# Analyze Model Comparison Results
# Generates detailed comparison of all tested models

FIRST_EXPERIMENT_ID=${1:-200}

echo "🔬 Detailed Model Comparison Analysis"
echo "======================================"
echo ""
echo "Experiment Range: $FIRST_EXPERIMENT_ID+"
echo ""

# Summary Statistics
echo "📈 SUMMARY STATISTICS"
echo "--------------------"
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  RPAD(model_name, 25) as model,
  COUNT(*) as runs,
  SUM(CASE WHEN goal_found THEN 1 ELSE 0 END) as goals,
  ROUND(SUM(CASE WHEN goal_found THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 1) || '%' as success_rate,
  ROUND(AVG((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id))) as avg_actions,
  ROUND(AVG((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id))) as avg_turns,
  ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)))) || 's' as avg_duration
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
GROUP BY model_name
ORDER BY avg_actions ASC;
"

echo ""
echo "🏆 BEST PERFORMERS (Completed Experiments)"
echo "------------------------------------------"
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  id,
  RPAD(model_name, 25) as model,
  CASE WHEN goal_found THEN '🎯' ELSE '❌' END as result,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns,
  ROUND(EXTRACT(EPOCH FROM (completed_at - started_at))) || 's' as duration,
  ROUND(EXTRACT(EPOCH FROM (completed_at - started_at)) /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0), 1) || 's' as sec_per_turn
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
  AND completed_at IS NOT NULL
ORDER BY
  goal_found DESC,
  actions ASC,
  EXTRACT(EPOCH FROM (completed_at - started_at)) ASC
LIMIT 10;
"

echo ""
echo "⚡ SPEED COMPARISON (Seconds per Turn)"
echo "-------------------------------------"
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  RPAD(model_name, 25) as model,
  ROUND(AVG(
    EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0)
  ), 2) as avg_sec_per_turn,
  MIN(ROUND(
    EXTRACT(EPOCH FROM (completed_at - started_at)) /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0), 2
  )) as min_sec_per_turn,
  MAX(ROUND(
    EXTRACT(EPOCH FROM (completed_at - started_at)) /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0), 2
  )) as max_sec_per_turn
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
  AND completed_at IS NOT NULL
GROUP BY model_name
ORDER BY avg_sec_per_turn ASC;
"

echo ""
echo "🎯 EFFICIENCY COMPARISON (Actions to Goal)"
echo "------------------------------------------"
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  RPAD(model_name, 25) as model,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns,
  ROUND((SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id)::numeric /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0), 1) as actions_per_turn,
  ROUND(EXTRACT(EPOCH FROM (completed_at - started_at))) || 's' as total_time
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
  AND goal_found = true
  AND completed_at IS NOT NULL
ORDER BY actions ASC;
"

echo ""
echo "💰 COST COMPARISON (Estimated)"
echo "-----------------------------"
echo "Note: Ollama models have ~\$0 marginal cost (electricity only)"
echo ""
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  RPAD(model_name, 25) as model,
  COUNT(*) as experiments,
  SUM((SELECT SUM(input_tokens) FROM agent_actions WHERE experiment_id = experiments.id)) as total_input_tokens,
  SUM((SELECT SUM(output_tokens) FROM agent_actions WHERE experiment_id = experiments.id)) as total_output_tokens,
  CASE
    WHEN model_name LIKE 'claude%' THEN
      ROUND(
        SUM((SELECT SUM(input_tokens) FROM agent_actions WHERE experiment_id = experiments.id)) * 0.00025 / 1000 +
        SUM((SELECT SUM(output_tokens) FROM agent_actions WHERE experiment_id = experiments.id)) * 0.00125 / 1000,
        4
      )::text || ' USD'
    ELSE '~\$0.00'
  END as estimated_cost
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
  AND completed_at IS NOT NULL
GROUP BY model_name
ORDER BY model_name;
"

echo ""
echo "📝 INDIVIDUAL EXPERIMENT DETAILS"
echo "--------------------------------"
PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  id,
  RPAD(model_name, 25) as model,
  CASE WHEN goal_found THEN '🎯 Found' ELSE '❌ Failed' END as outcome,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns,
  TO_CHAR(started_at, 'HH24:MI:SS') as started,
  CASE
    WHEN completed_at IS NOT NULL THEN TO_CHAR(completed_at, 'HH24:MI:SS')
    ELSE 'Running'
  END as completed,
  CASE
    WHEN completed_at IS NOT NULL
    THEN ROUND(EXTRACT(EPOCH FROM (completed_at - started_at))) || 's'
    ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - started_at))) || 's'
  END as duration
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
ORDER BY id DESC;
"

echo ""
echo "======================================"
echo "Analysis complete!"
