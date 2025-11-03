#!/bin/bash
# BATCH 3: Temperature sweep with v8-minimal prompt
# Testing qwen2.5:7b-128k and qwen3:1.7b-clean128k with v8-minimal prompt
# 22 total experiments: 11 temps × 2 models

set -e

PROMPT_VERSION="v8-minimal"
MAZE_ID=1
MAX_CONTEXT=131072
MAX_OUTPUT=3072
REPEAT_PENALTY=1.0

TEMPS=(0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0)

echo "Starting BATCH 3: v8-minimal prompt testing"
echo "Prompt: $PROMPT_VERSION"
echo "Models: qwen2.5:7b-clean128k, qwen3:1.7b-clean128k"
echo ""

# Phase 1: qwen2.5:7b-clean128k
echo "Phase 1: qwen2.5:7b-clean128k (runs 1-11)"
RUN_NUM=1
for TEMP in "${TEMPS[@]}"; do
  echo "[$RUN_NUM/22] Triggering qwen2.5:7b-clean128k @ temp=$TEMP"
  ./scripts/trigger-by-name.sh \
    qwen2.5:7b-clean128k \
    "$MAZE_ID" \
    "$PROMPT_VERSION" \
    "$MAX_CONTEXT" \
    "$TEMP" \
    "$MAX_OUTPUT" \
    "$REPEAT_PENALTY" \
    --comment "BATCH 3 (run $RUN_NUM of 22)"

  echo ""
  RUN_NUM=$((RUN_NUM + 1))
  sleep 2
done

# Phase 2: qwen3:1.7b-clean128k
echo "Phase 2: qwen3:1.7b-clean128k (runs 12-22)"
for TEMP in "${TEMPS[@]}"; do
  echo "[$RUN_NUM/22] Triggering qwen3:1.7b-clean128k @ temp=$TEMP"
  ./scripts/trigger-by-name.sh \
    qwen3:1.7b-clean128k \
    "$MAZE_ID" \
    "$PROMPT_VERSION" \
    "$MAX_CONTEXT" \
    "$TEMP" \
    "$MAX_OUTPUT" \
    "$REPEAT_PENALTY" \
    --comment "BATCH 3 (run $RUN_NUM of 22)"

  echo ""
  RUN_NUM=$((RUN_NUM + 1))
  sleep 2
done

echo "✅ BATCH 3 complete! Triggered 22 experiments."
