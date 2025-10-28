#!/bin/bash
# Parameter Sweep Experiment Batch
# Tests different configurations of qwen2.5:7b for optimal maze navigation
#
# This will run 12 experiments testing:
# - Series A: Context window sizes (3 experiments)
# - Series B: Temperature values (6 experiments)
# - Series C: Repeat penalty values (3 experiments)
#
# Each experiment takes ~16 minutes at 500 moves
# Total estimated time: ~3.2 hours

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
echo "⚠️  This will run 12 experiments sequentially (with 180s isolation delays)"
echo "⏱️  Estimated time: ~3.75 hours (3.2h experiments + 33m delays)"
echo ""
read -p "Press Enter to continue or Ctrl+C to abort..."
echo ""

# Helper function to set parameters and trigger experiment
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

  # Update parameters
  echo "📝 Setting parameters..."
  aws ssm put-parameter --name '/oriole/ollama/num-ctx' --value "$context" --type 'String' --overwrite --region $REGION --profile $PROFILE > /dev/null
  aws ssm put-parameter --name '/oriole/ollama/temperature' --value "$temp" --type 'String' --overwrite --region $REGION --profile $PROFILE > /dev/null
  aws ssm put-parameter --name '/oriole/ollama/repeat-penalty' --value "$rep_penalty" --type 'String' --overwrite --region $REGION --profile $PROFILE > /dev/null

  # Trigger experiment
  echo "🚀 Triggering experiment..."
  ./scripts/trigger-experiment.sh OLLAMA NOTUSED $MODEL $MAZE_ID $PROMPT_VERSION

  echo "✅ Experiment $series started"
  echo ""

  # Delay to ensure:
  # 1. Previous experiment has fully started and captured its parameters from Parameter Store
  # 2. Parameter Store changes propagate to new Lambda invocations
  # 3. No race conditions between parameter updates and experiment starts
  #
  # Conservative 180s delay accounts for:
  # - EventBridge propagation (~5s)
  # - SQS long polling (~20s)
  # - Lambda cold start (~5s)
  # - start-experiment execution (~10s)
  # - Safety margin (~140s)
  echo "⏳ Waiting 180 seconds before next experiment (ensures parameter isolation)..."
  sleep 180
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
echo "Expected completion: ~3.75 hours from now"
echo ""
echo "Experiment IDs should be: 1-12"
echo ""
