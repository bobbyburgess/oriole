#!/bin/bash
# Parameter Sweep Experiment Batch
# Tests different configurations of qwen2.5:7b for optimal maze navigation
#
# This will run 12 experiments testing:
# - Series A: Context window sizes (3 experiments)
# - Series B: Temperature values (6 experiments)
# - Series C: Repeat penalty values (3 experiments)
#
# Each experiment takes ~3-5 minutes with GPU acceleration
# Total estimated time: ~1 hour (experiments) + ~1 minute (delays)

set -e  # Exit on error

REGION="us-west-2"
PROFILE="bobby"
MODEL="qwen2.5:7b"
MAZE_ID="1"
PROMPT_VERSION="v1"

echo "🧪 Starting Parameter Sweep - 12 Experiments"
echo "=============================================="
echo ""
echo "Model: $MODEL"
echo "Maze: #$MAZE_ID (60x60 grid)"
echo "Max moves: 500 (from Parameter Store)"
echo ""
echo "⚠️  This will run 12 experiments sequentially (with 5s delays between triggers)"
echo "⏱️  Estimated time: ~1 hour (experiments run in parallel via queue)"
echo ""
read -p "Press Enter to continue or Ctrl+C to abort..."
echo ""

# Helper function to trigger experiment with config
run_experiment() {
  local series=$1
  local name=$2
  local context=$3
  local temp=$4
  local rep_penalty=$5

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🔬 Experiment $series: $name"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "   context=$context, temp=$temp, rep_penalty=$rep_penalty"
  echo ""

  # Trigger experiment with config passed directly in event (atomic!)
  # No Parameter Store writes = No race conditions!
  echo "🚀 Triggering experiment with config in event..."
  ./scripts/trigger-experiment.sh OLLAMA NOTUSED $MODEL $MAZE_ID $PROMPT_VERSION "" $context $temp $rep_penalty

  echo "✅ Experiment $series started"
  echo ""

  # Short delay between triggers (just to be polite to Ollama and AWS)
  # Config is atomic in message, so no timing concerns!
  echo "⏳ Waiting 5 seconds before next experiment..."
  sleep 5
}

# ========================================
# SERIES A: Context Window Size
# ========================================
echo ""
echo "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
echo "┃  SERIES A: Context Window Impact         ┃"
echo "┃  Question: Does larger context help?     ┃"
echo "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"

run_experiment "A1" "Small Context (2K)" "2048" "0.2" "1.4"
run_experiment "A2" "Medium Context (8K)" "8192" "0.2" "1.4"
run_experiment "A3" "Large Context (32K)" "32768" "0.2" "1.4"

# ========================================
# SERIES B: Temperature Variation
# ========================================
echo ""
echo "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
echo "┃  SERIES B: Temperature (Randomness)       ┃"
echo "┃  Question: Deterministic vs creative?    ┃"
echo "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"

run_experiment "B1" "Pure Determinism" "32768" "0.0" "1.4"
run_experiment "B2" "Very Focused" "32768" "0.1" "1.4"
run_experiment "B3" "Focused (baseline)" "32768" "0.2" "1.4"
run_experiment "B4" "Balanced" "32768" "0.5" "1.4"
run_experiment "B5" "Creative" "32768" "0.7" "1.4"
run_experiment "B6" "High Randomness" "32768" "1.0" "1.4"

# ========================================
# SERIES C: Repeat Penalty
# ========================================
echo ""
echo "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"
echo "┃  SERIES C: Repeat Penalty (Loop Prevention)┃"
echo "┃  Question: How much anti-loop needed?    ┃"
echo "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"

run_experiment "C1" "No Penalty" "32768" "0.2" "1.0"
run_experiment "C2" "Light Penalty" "32768" "0.2" "1.2"
run_experiment "C3" "Strong Penalty" "32768" "0.2" "1.6"

# ========================================
# Summary
# ========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 All 12 experiments launched!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📊 Monitor progress with:"
echo "   watch -n 5 ./scripts/check-batch-results.sh 1"
echo ""
echo "Expected completion: ~1 hour from now (with GPU acceleration)"
echo ""
echo "Experiment IDs should be: 1-12"
echo ""
