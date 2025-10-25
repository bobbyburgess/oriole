#!/bin/bash

# Script to trigger a maze experiment via EventBridge
# Usage: ./trigger-experiment.sh <agent-id> <agent-alias-id> <model-name> <maze-id> [prompt-version] [resume-from-experiment-id]

AGENT_ID=$1
AGENT_ALIAS_ID=$2
MODEL_NAME=$3
MAZE_ID=$4
PROMPT_VERSION=${5:-v1}  # Default to v1 if not provided
RESUME_FROM=${6:-""}  # Optional resume-from experiment ID

if [ -z "$AGENT_ID" ] || [ -z "$AGENT_ALIAS_ID" ] || [ -z "$MODEL_NAME" ] || [ -z "$MAZE_ID" ]; then
  echo "Usage: $0 <agent-id> <agent-alias-id> <model-name> <maze-id> [prompt-version]"
  echo ""
  echo "Example:"
  echo "  $0 ABCD1234 EFGH5678 claude-3-5-haiku 1"
  echo "  $0 ABCD1234 EFGH5678 claude-3-5-haiku 1 v2"
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
  exit 1
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
  "resumeFromExperimentId": $RESUME_FROM
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
  "startY": 2
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
