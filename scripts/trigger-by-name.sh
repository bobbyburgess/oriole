#!/bin/bash

# Trigger Experiment by Model Name
# Looks up agent/alias IDs from Parameter Store and triggers an experiment
#
# Usage: ./trigger-by-name.sh <model-name> <maze-id> [prompt-version] [max-context-window] [temperature] [repeat-penalty] [max-output-tokens] [--resume-from <experiment-id>]
#
# Example:
#   ./trigger-by-name.sh claude-3.5-haiku 1 v2 32768 0.2 1.0 4096
#   ./trigger-by-name.sh nova-pro 3 v3-react-basic 32768 0.5 1.0 4096
#   ./trigger-by-name.sh claude-3-haiku 1 v3-react-adaptive 32768 0.2 1.0 4096 --resume-from 150
#
# Available models:
#   AWS Bedrock:
#     - claude-3.5-haiku
#     - claude-3-haiku
#     - nova-micro
#     - nova-lite
#     - nova-pro
#     - nova-premier
#   Local Ollama (any model name from `ollama list`, e.g.):
#     - llama3.2:latest
#     - qwen2.5-coder:latest
#     - mistral:latest

set -e

MODEL_NAME=$1
MAZE_ID=$2
PROMPT_VERSION=${3:-v1}
MAX_CONTEXT_WINDOW=$4
TEMPERATURE=$5
REPEAT_PENALTY=$6
MAX_OUTPUT_TOKENS=$7
RESUME_FROM=""

# Parse optional --resume-from parameter
shift 7 2>/dev/null || true
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

if [ -z "$MODEL_NAME" ] || [ -z "$MAZE_ID" ] || [ -z "$MAX_CONTEXT_WINDOW" ] || [ -z "$TEMPERATURE" ] || [ -z "$REPEAT_PENALTY" ] || [ -z "$MAX_OUTPUT_TOKENS" ]; then
  echo "Usage: $0 <model-name> <maze-id> <prompt-version> <max-context-window> <temperature> <repeat-penalty> <max-output-tokens> [--resume-from <experiment-id>]"
  echo ""
  echo "All config parameters are REQUIRED:"
  echo "  max-context-window: Total context window in tokens (e.g., 32768, 200000)"
  echo "  temperature:        Sampling temperature (e.g., 0.0, 0.2, 0.7)"
  echo "  repeat-penalty:     Repetition penalty (e.g., 1.0, 1.4)"
  echo "  max-output-tokens:  Max tokens in output (e.g., 2000, 4096)"
  echo ""
  echo "Available models:"
  echo "  AWS Bedrock:"
  echo "    - claude-3.5-haiku"
  echo "    - claude-3-haiku"
  echo "    - nova-micro"
  echo "    - nova-lite"
  echo "    - nova-pro"
  echo "    - nova-premier"
  echo "  Local Ollama (use any model from 'ollama list'):"
  echo "    - llama3.2:latest"
  echo "    - qwen2.5-coder:latest"
  echo ""
  echo "Example:"
  echo "  $0 claude-3.5-haiku 1 v2 32768 0.2 1.0 4096"
  echo "  $0 llama3.2:latest 1 v1 32768 0.2 1.4 2000"
  echo "  $0 claude-3-haiku 1 v3-react-adaptive 32768 0.2 1.0 4096 --resume-from 150"
  exit 1
fi

# Check if this is an Ollama model (contains ':' or matches known Ollama patterns)
if [[ "$MODEL_NAME" == *":"* ]] || [[ "$MODEL_NAME" =~ ^(llama|qwen|mistral|phi|gemma|codellama|deepseek) ]]; then
  echo "🦙 Detected Ollama model: $MODEL_NAME"
  echo "✅ Using Ollama invoke path"
  if [ -n "$RESUME_FROM" ]; then
    echo "   Resume from: Experiment $RESUME_FROM"
  fi
  echo ""

  # For Ollama, use special marker values
  AGENT_ID="OLLAMA"
  ALIAS_ID="OLLAMA"
else
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
fi

# Call the original trigger script with the resolved IDs and config params
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/trigger-experiment.sh" "$AGENT_ID" "$ALIAS_ID" "$MODEL_NAME" "$MAZE_ID" "$PROMPT_VERSION" "$RESUME_FROM" "$MAX_CONTEXT_WINDOW" "$TEMPERATURE" "$REPEAT_PENALTY" "$MAX_OUTPUT_TOKENS"
