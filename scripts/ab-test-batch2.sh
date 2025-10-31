#!/bin/bash

# QWEN TEMPERATURE SWEEP - BATCH 2
# Comparing qwen2.5:7b-128k vs qwen2.5:14b-128k across temperature range 0.0-1.0
# Configuration: 11 temps (0, 0.1, 0.2, ... 1.0), 500 moves, v8-minimal prompt, 131072 context
# 22 total experiments: 11 temps × 2 models

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Temperature range: 0.0 to 1.0 in 0.1 increments
TEMPS=(0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0)
TOTAL_RUNS=22

echo "🚀 Starting BATCH 2: Temperature sweep (0.0-1.0)"
echo "   Models: qwen2.5:7b-128k, qwen2.5:14b-128k"
echo "   Temperatures: ${TEMPS[@]}"
echo "   Total runs: $TOTAL_RUNS"
echo ""

# Phase 1: qwen2.5:7b-128k across all temperatures
echo "📊 Phase 1: qwen2.5:7b-128k temperature sweep (runs 1-11)"
RUN_NUM=1
for TEMP in "${TEMPS[@]}"; do
  echo "  → Triggering qwen2.5:7b-128k @ temp=$TEMP (run $RUN_NUM of $TOTAL_RUNS)"
  "$SCRIPT_DIR/trigger-by-name.sh" \
    qwen2.5:7b-128k \
    1 \
    v8-minimal \
    131072 \
    $TEMP \
    3072 \
    --comment "BATCH 2 (run $RUN_NUM of $TOTAL_RUNS)"

  RUN_NUM=$((RUN_NUM + 1))
  sleep 1
done

echo ""
echo "📊 Phase 2: qwen2.5:14b-128k temperature sweep (runs 12-22)"
# Phase 2: qwen2.5:14b-128k across all temperatures
for TEMP in "${TEMPS[@]}"; do
  echo "  → Triggering qwen2.5:14b-128k @ temp=$TEMP (run $RUN_NUM of $TOTAL_RUNS)"
  "$SCRIPT_DIR/trigger-by-name.sh" \
    qwen2.5:14b-128k \
    1 \
    v8-minimal \
    131072 \
    $TEMP \
    3072 \
    --comment "BATCH 2 (run $RUN_NUM of $TOTAL_RUNS)"

  RUN_NUM=$((RUN_NUM + 1))
  sleep 1
done

echo ""
echo "✅ BATCH 2 triggered successfully!"
echo "   22 experiments queued (11 temps × 2 models)"
echo ""
echo "Monitor progress:"
echo "  watch -n 5 'psql ... -c \"SELECT * FROM v_batch_monitor WHERE comment LIKE '\'BATCH 2%\'' ORDER BY id;\"'"
