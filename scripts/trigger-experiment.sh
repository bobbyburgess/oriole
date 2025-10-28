#!/bin/bash

# Script to trigger a maze experiment via EventBridge
# Usage: ./trigger-experiment.sh <agent-id> <agent-alias-id> <model-name> <maze-id> [prompt-version] [resume-from-experiment-id]

AGENT_ID=$1
AGENT_ALIAS_ID=$2
MODEL_NAME=$3
MAZE_ID=$4
PROMPT_VERSION=${5:-v1}  # Default to v1 if not provided
RESUME_FROM=${6:-""}  # Optional resume-from experiment ID
NUM_CTX=${7:-""}         # Optional: context window size
TEMPERATURE=${8:-""}     # Optional: sampling temperature
REPEAT_PENALTY=${9:-""}  # Optional: repetition penalty
NUM_PREDICT=${10:-""}    # Optional: max output tokens

if [ -z "$AGENT_ID" ] || [ -z "$AGENT_ALIAS_ID" ] || [ -z "$MODEL_NAME" ] || [ -z "$MAZE_ID" ]; then
  echo "Usage: $0 <agent-id> <agent-alias-id> <model-name> <maze-id> [prompt-version] [resume-from] [num-ctx] [temperature] [repeat-penalty] [num-predict]"
  echo ""
  echo "Example:"
  echo "  $0 OLLAMA NOTUSED qwen2.5:7b 1"
  echo "  $0 OLLAMA NOTUSED qwen2.5:7b 1 v1 \"\" 2048 0.2 1.4 2000"
  echo ""
  echo "Available mazes (ID): "
  echo "  1-6:  One-path mazes (sparse to extreme)"
  echo "  7:    Open field"
  echo "  8:    Spiral"
  echo "  9:    Rooms & corridors"
  echo "  10:   Multiple paths"
  echo "  11:   Diagonal bias"
  echo "  12:   Random scatter"
  echo ""
  echo "Prompt versions: v1 (default), v2"
  echo ""
  echo "Config parameters (optional for Ollama):"
  echo "  num-ctx:        Context window size (e.g., 2048, 8192, 32768)"
  echo "  temperature:    Sampling temperature (e.g., 0.0, 0.2, 0.7)"
  echo "  repeat-penalty: Repetition penalty (e.g., 1.0, 1.4, 1.6)"
  echo "  num-predict:    Max output tokens (e.g., 2000)"
  exit 1
fi

# Determine LLM provider based on agent ID
# AGENT_ID="OLLAMA" is a special marker for local Ollama calls (not a real Bedrock agent)
# This triggers routing through invoke-agent-ollama Lambda instead of invoke-agent Lambda
# See trigger-by-name.sh for auto-detection of Ollama models
if [ "$AGENT_ID" = "OLLAMA" ]; then
  LLM_PROVIDER="ollama"
else
  LLM_PROVIDER="bedrock"
fi

# Build config JSON if parameters provided
CONFIG_JSON=""
if [ -n "$NUM_CTX" ] || [ -n "$TEMPERATURE" ] || [ -n "$REPEAT_PENALTY" ] || [ -n "$NUM_PREDICT" ]; then
  CONFIG_PARTS=()
  [ -n "$NUM_CTX" ] && CONFIG_PARTS+=("\"numCtx\": $NUM_CTX")
  [ -n "$TEMPERATURE" ] && CONFIG_PARTS+=("\"temperature\": $TEMPERATURE")
  [ -n "$REPEAT_PENALTY" ] && CONFIG_PARTS+=("\"repeatPenalty\": $REPEAT_PENALTY")
  [ -n "$NUM_PREDICT" ] && CONFIG_PARTS+=("\"numPredict\": $NUM_PREDICT")

  # Join with commas
  CONFIG_ITEMS=$(printf '%s\n' "${CONFIG_PARTS[@]}" | paste -sd ',' -)
  CONFIG_JSON=",
  \"config\": {
    $CONFIG_ITEMS
  }"
fi

# Build event detail
if [ -n "$RESUME_FROM" ]; then
  EVENT_DETAIL=$(cat <<EOF
{
  "agentId": "$AGENT_ID",
  "agentAliasId": "$AGENT_ALIAS_ID",
  "modelName": "$MODEL_NAME",
  "promptVersion": "$PROMPT_VERSION",
  "mazeId": $MAZE_ID,
  "goalDescription": "Find the goal marker",
  "startX": 2,
  "startY": 2,
  "resumeFromExperimentId": $RESUME_FROM,
  "llmProvider": "$LLM_PROVIDER"$CONFIG_JSON
}
EOF
)
else
  EVENT_DETAIL=$(cat <<EOF
{
  "agentId": "$AGENT_ID",
  "agentAliasId": "$AGENT_ALIAS_ID",
  "modelName": "$MODEL_NAME",
  "promptVersion": "$PROMPT_VERSION",
  "mazeId": $MAZE_ID,
  "goalDescription": "Find the goal marker",
  "startX": 2,
  "startY": 2,
  "llmProvider": "$LLM_PROVIDER"$CONFIG_JSON
}
EOF
)
fi

echo "Triggering experiment with:"
echo "$EVENT_DETAIL"
echo ""

# Send event to EventBridge
aws events put-events \
  --region us-west-2 \
  --profile bobby \
  --entries "[{
    \"Source\": \"oriole.experiments\",
    \"DetailType\": \"RunExperiment\",
    \"Detail\": $(echo "$EVENT_DETAIL" | jq -Rs .)
  }]"

echo ""
echo "✅ Experiment triggered! Check Step Functions console for execution status."
