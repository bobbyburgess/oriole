#!/bin/bash

# QWEN A/B TEST - BATCH 3
# Comparing qwen2.5:14b vs qwen2.5:7b
# Configuration: temp=0, 500 moves, v7-neutral prompt
# Expected runtime: ~18-20 hours total (60-90 min per experiment)
#
# Execution order: 10× 14b (batched), then 10× 7b (batched)
# Reason: Minimizes Ollama model switching overhead

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMENT="QWEN A/B TEST, BATCH 3"

echo "=========================================="
echo "QWEN A/B TEST - BATCH 3"
echo "=========================================="
echo ""
echo "Configuration:"
echo "  Models: qwen2.5:14b (10 runs), qwen2.5:7b (10 runs)"
echo "  Prompt: v7-neutral"
echo "  Temperature: 0"
echo "  Max moves: 500"
echo "  Max duration: 120 minutes"
echo "  Maze: 1"
echo ""
echo "Expected runtime: ~18-20 hours"
echo ""
read -p "Press Enter to start, or Ctrl+C to cancel..."
echo ""

# ==========================================
# PHASE 1: qwen2.5:14b (10 runs)
# ==========================================

echo "=========================================="
echo "PHASE 1: qwen2.5:14b (10 runs)"
echo "=========================================="
echo ""

for i in {1..10}; do
  echo "──────────────────────────────────────"
  echo "Triggering qwen2.5:14b run $i/10"
  echo "──────────────────────────────────────"

  "$SCRIPT_DIR/trigger-by-name.sh" \
    qwen2.5:14b \
    1 \
    v7-neutral \
    16384 \
    0 \
    3072 \
    --comment "$COMMENT"

  echo ""
  echo "✅ qwen2.5:14b run $i/10 triggered"
  echo ""

  # Brief pause to ensure experiments queue properly
  sleep 2
done

echo ""
echo "=========================================="
echo "✅ PHASE 1 COMPLETE: All 10 qwen2.5:14b runs triggered"
echo "=========================================="
echo ""
echo "Waiting 30 seconds before starting Phase 2..."
sleep 30

# ==========================================
# PHASE 2: qwen2.5:7b (10 runs)
# ==========================================

echo ""
echo "=========================================="
echo "PHASE 2: qwen2.5:7b (10 runs)"
echo "=========================================="
echo ""

for i in {1..10}; do
  echo "──────────────────────────────────────"
  echo "Triggering qwen2.5:7b run $i/10"
  echo "──────────────────────────────────────"

  "$SCRIPT_DIR/trigger-by-name.sh" \
    qwen2.5:7b \
    1 \
    v7-neutral \
    16384 \
    0 \
    3072 \
    --comment "$COMMENT"

  echo ""
  echo "✅ qwen2.5:7b run $i/10 triggered"
  echo ""

  # Brief pause to ensure experiments queue properly
  sleep 2
done

echo ""
echo "=========================================="
echo "✅ ALL EXPERIMENTS TRIGGERED!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  • 10× qwen2.5:14b runs triggered"
echo "  • 10× qwen2.5:7b runs triggered"
echo "  • Total: 20 experiments"
echo "  • Comment: $COMMENT"
echo ""
echo "Monitor progress with:"
echo "  ./scripts/check-batch-results.sh"
echo ""
echo "Query by comment:"
echo "  SELECT id, model_name, started_at"
echo "  FROM experiments"
echo "  WHERE comment = '$COMMENT'"
echo "  ORDER BY id;"
echo ""
