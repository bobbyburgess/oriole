#!/bin/bash
# Check Batch Test Results
# Monitors progress of multiple experiments and shows comparison

FIRST_EXPERIMENT_ID=${1:-200}

echo "📊 Batch Test Results (Experiment $FIRST_EXPERIMENT_ID+)"
echo "========================================================"
echo ""

PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql \
  -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com \
  -U oriole_user \
  -p 5432 \
  -d oriole \
  -c "
SELECT
  id,
  RPAD(model_name, 25) as model,
  (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions,
  (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns,
  ROUND(
    (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id)::numeric /
    NULLIF((SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id), 0),
    1
  ) as avg_per_turn,
  ROUND(
    (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id)::numeric /
    NULLIF(EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) / 60.0, 0),
    1
  ) as moves_per_min,
  CASE
    WHEN goal_found THEN '🎯 GOAL!'
    WHEN completed_at IS NOT NULL AND failure_reason IS NOT NULL THEN '❌ ' || (failure_reason::json->>'errorType')
    WHEN completed_at IS NOT NULL THEN '✅ Done'
    ELSE '▶ Running (' || ROUND(EXTRACT(EPOCH FROM (NOW() - started_at))/60) || 'm)'
  END as status,
  CASE
    WHEN EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) >= 86400 THEN
      (EXTRACT(days FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'd ' ||
      (EXTRACT(hours FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'h ' ||
      (EXTRACT(minutes FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'm ' ||
      (EXTRACT(seconds FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 's'
    WHEN EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) >= 3600 THEN
      (EXTRACT(hours FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'h ' ||
      (EXTRACT(minutes FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'm ' ||
      (EXTRACT(seconds FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 's'
    WHEN EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - started_at)) >= 60 THEN
      (EXTRACT(minutes FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 'm ' ||
      (EXTRACT(seconds FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 's'
    ELSE
      (EXTRACT(seconds FROM (COALESCE(completed_at, NOW()) - started_at)))::int || 's'
  END as duration
FROM experiments
WHERE id >= $FIRST_EXPERIMENT_ID
ORDER BY id DESC;
"

echo ""
echo "Refresh with: watch -n 5 ./scripts/check-batch-results.sh $FIRST_EXPERIMENT_ID"
