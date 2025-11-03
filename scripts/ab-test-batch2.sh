#!/bin/bash
# BATCH 2: Temperature sweep with qwen3:1.7b-clean128k
# Same config as BATCH 1 but with smaller model for faster iteration

MODEL="qwen3:1.7b-clean128k"
MAZE_ID=1
PROMPT_VERSION="v7-neutral"
MAX_CONTEXT=131072
MAX_OUTPUT=3072
REPEAT_PENALTY=1.0

TEMPS=(0 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0)

echo "Starting BATCH 2: Temperature sweep (0.0 → 1.0)"
echo "Model: $MODEL"
echo ""

for i in "${!TEMPS[@]}"; do
  TEMP="${TEMPS[$i]}"
  RUN=$((i + 1))

  echo "[$RUN/11] Triggering experiment with temperature=$TEMP"
  ./scripts/trigger-by-name.sh "$MODEL" "$MAZE_ID" "$PROMPT_VERSION" "$MAX_CONTEXT" "$TEMP" "$MAX_OUTPUT" "$REPEAT_PENALTY" --comment "BATCH 2 (run $RUN of 11)"

  echo ""
  sleep 2  # Brief pause between triggers
done

echo "✅ BATCH 2 complete! Triggered 11 experiments."
