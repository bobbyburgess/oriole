#!/bin/bash

# Script to trigger a maze experiment via EventBridge
# Usage: ./trigger-experiment.sh <agent-id> <agent-alias-id> <model-name> <maze-id>

AGENT_ID=$1
AGENT_ALIAS_ID=$2
MODEL_NAME=$3
MAZE_ID=$4

if [ -z "$AGENT_ID" ] || [ -z "$AGENT_ALIAS_ID" ] || [ -z "$MODEL_NAME" ] || [ -z "$MAZE_ID" ]; then
  echo "Usage: $0 <agent-id> <agent-alias-id> <model-name> <maze-id>"
  echo ""
  echo "Example:"
  echo "  $0 ABCD1234 EFGH5678 claude-3-5-sonnet 1"
  echo ""
  echo "Available mazes (ID): "
  echo "  1-6:  One-path mazes (sparse to extreme)"
  echo "  7:    Open field"
  echo "  8:    Spiral"
  echo "  9:    Rooms & corridors"
  echo "  10:   Multiple paths"
  echo "  11:   Diagonal bias"
  echo "  12:   Random scatter"
  exit 1
fi

# Build event detail
EVENT_DETAIL=$(cat <<EOF
{
  "agentId": "$AGENT_ID",
  "agentAliasId": "$AGENT_ALIAS_ID",
  "modelName": "$MODEL_NAME",
  "promptVersion": "v1",
  "mazeId": $MAZE_ID,
  "goalDescription": "Find the goal marker",
  "startX": 2,
  "startY": 2
}
EOF
)

echo "Triggering experiment with:"
echo "$EVENT_DETAIL"
echo ""

# Send event to EventBridge
aws events put-events \
  --entries "[{
    \"Source\": \"oriole.experiments\",
    \"DetailType\": \"RunExperiment\",
    \"Detail\": $(echo "$EVENT_DETAIL" | jq -Rs .)
  }]"

echo ""
echo "✅ Experiment triggered! Check Step Functions console for execution status."
