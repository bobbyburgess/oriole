#!/bin/bash
# Batch Model Comparison Script
# Runs multiple Ollama models on the same maze for A/B testing

set -e

MAZE_ID=${1:-1}
PROMPT_VERSION=${2:-v1}
PROFILE=${3:-bobby}

echo "🧪 Batch Model Testing"
echo "===================="
echo "Maze ID: $MAZE_ID"
echo "Prompt Version: $PROMPT_VERSION"
echo ""

# Models to test (in order from smallest to largest)
# Note: Only models with Ollama tool calling support
MODELS=(
  "llama3.2:latest"      # 3B - baseline (already tested)
  "llama3.1:8b"          # 8B - speed reference
  "qwen2.5:14b"          # 14B - best mid-size
  "gemma2:27b"           # 27B - Google's approach
  "llama3.3:70b"         # 70B - Meta's latest
  "qwen2.5:72b"          # 72B - Alibaba's flagship
  "deepseek-r1:70b"      # 70B - reasoning specialist
)

EXPERIMENT_IDS=()

echo "Starting experiments..."
echo ""

for MODEL in "${MODELS[@]}"; do
  echo "🚀 Triggering: $MODEL"

  RESULT=$(./scripts/trigger-by-name.sh "$MODEL" "$MAZE_ID" "$PROMPT_VERSION" 2>&1)

  # Extract experiment ID from output
  EXPERIMENT_ID=$(echo "$RESULT" | grep -oE "Experiment [0-9]+" | grep -oE "[0-9]+" | tail -1)

  if [ -n "$EXPERIMENT_ID" ]; then
    EXPERIMENT_IDS+=("$EXPERIMENT_ID:$MODEL")
    echo "   ✅ Experiment $EXPERIMENT_ID started"
  else
    echo "   ❌ Failed to start experiment"
    echo "$RESULT"
  fi

  echo ""

  # Small delay to avoid overwhelming the system
  sleep 2
done

echo "===================="
echo "📊 All experiments launched!"
echo ""
echo "Experiment IDs:"
for ENTRY in "${EXPERIMENT_IDS[@]}"; do
  IFS=':' read -r ID MODEL <<< "$ENTRY"
  printf "  %3s: %s\n" "$ID" "$MODEL"
done

echo ""
echo "Monitor progress with:"
echo "  ./scripts/check-batch-results.sh ${EXPERIMENT_IDS[0]%%:*}"
echo ""
echo "Or query directly:"
echo "  PGPASSWORD='oR8tK3mP9vL2qN7xW4bZ6jH5yT1nM3s' psql -h continuum-prod1.c9ykg4gyyd27.us-west-2.rds.amazonaws.com -U oriole_user -d oriole -c \\"
echo "    SELECT id, model_name, goal_found, "
echo "      (SELECT COUNT(*) FROM agent_actions WHERE experiment_id = experiments.id) as actions, "
echo "      (SELECT MAX(turn_number) FROM agent_actions WHERE experiment_id = experiments.id) as turns "
echo "    FROM experiments WHERE id >= ${EXPERIMENT_IDS[0]%%:*} ORDER BY id;\\"
