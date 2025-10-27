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
  CASE
    WHEN goal_found THEN '🎯 GOAL!'
    WHEN completed_at IS NOT NULL AND failure_reason IS NOT NULL THEN '❌ ' || (failure_reason::json->>'errorType')
    WHEN completed_at IS NOT NULL THEN '✅ Done'
    ELSE '▶ Running (' || ROUND(EXTRACT(EPOCH FROM (NOW() - started_at))/60) || 'm)'
  END as status,
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
echo "Refresh with: watch -n 5 ./scripts/check-batch-results.sh $FIRST_EXPERIMENT_ID"
