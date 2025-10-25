#!/bin/bash

# Trigger Experiment by Model Name
# Looks up agent/alias IDs from Parameter Store and triggers an experiment
#
# Usage: ./trigger-by-name.sh <model-name> <maze-id> [prompt-version] [--resume-from <experiment-id>]
#
# Example:
#   ./trigger-by-name.sh claude-3.5-haiku 1 v2
#   ./trigger-by-name.sh nova-pro 3 v3-react-basic
#   ./trigger-by-name.sh claude-3-haiku 1 v3-react-adaptive --resume-from 150
#
# Available models:
#   - claude-3.5-haiku
#   - claude-3-haiku
#   - nova-micro
#   - nova-lite
#   - nova-pro
#   - nova-premier

set -e

MODEL_NAME=$1
MAZE_ID=$2
PROMPT_VERSION=${3:-v1}
RESUME_FROM=""

# Parse optional --resume-from parameter
shift 3 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case $1 in
    --resume-from)
      RESUME_FROM="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

REGION="us-west-2"
PROFILE="bobby"

if [ -z "$MODEL_NAME" ] || [ -z "$MAZE_ID" ]; then
  echo "Usage: $0 <model-name> <maze-id> [prompt-version] [--resume-from <experiment-id>]"
  echo ""
  echo "Available models:"
  echo "  - claude-3.5-haiku"
  echo "  - claude-3-haiku"
  echo "  - nova-micro"
  echo "  - nova-lite"
  echo "  - nova-pro"
  echo "  - nova-premier"
  echo ""
  echo "Example:"
  echo "  $0 claude-3.5-haiku 1 v2"
  echo "  $0 claude-3-haiku 1 v3-react-adaptive --resume-from 150"
  exit 1
fi

echo "🔍 Looking up agent configuration for: $MODEL_NAME"

# Fetch agent ID from Parameter Store
AGENT_ID=$(AWS_PROFILE=$PROFILE aws ssm get-parameter \
  --name "/oriole/agents/$MODEL_NAME/id" \
  --region $REGION \
  --query 'Parameter.Value' \
  --output text 2>/dev/null)

if [ -z "$AGENT_ID" ] || [ "$AGENT_ID" = "None" ]; then
  echo "❌ Error: Agent ID not found for model '$MODEL_NAME'"
  echo ""
  echo "Have you run the setup script?"
  echo "  ./scripts/setup-agent-ids.sh"
  exit 1
fi

# Fetch alias ID from Parameter Store
ALIAS_ID=$(AWS_PROFILE=$PROFILE aws ssm get-parameter \
  --name "/oriole/agents/$MODEL_NAME/alias-id" \
  --region $REGION \
  --query 'Parameter.Value' \
  --output text 2>/dev/null)

if [ -z "$ALIAS_ID" ] || [ "$ALIAS_ID" = "None" ]; then
  echo "❌ Error: Alias ID not found for model '$MODEL_NAME'"
  echo ""
  echo "Have you run the setup script?"
  echo "  ./scripts/setup-agent-ids.sh"
  exit 1
fi

echo "✅ Found configuration:"
echo "   Agent ID: $AGENT_ID"
echo "   Alias ID: $ALIAS_ID"
if [ -n "$RESUME_FROM" ]; then
  echo "   Resume from: Experiment $RESUME_FROM"
fi
echo ""

# Call the original trigger script with the resolved IDs
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/trigger-experiment.sh" "$AGENT_ID" "$ALIAS_ID" "$MODEL_NAME" "$MAZE_ID" "$PROMPT_VERSION" "$RESUME_FROM"
