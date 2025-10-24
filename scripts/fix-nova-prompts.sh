#!/bin/bash

# Fix Nova agent prompt configurations for better tool calling
# Based on AWS troubleshooting guide recommendations

echo "Fixing Nova agent inference configurations..."
echo ""

# Array of Nova agent IDs from CDK outputs
NOVA_AGENTS=(
  "NUVT0TX9GE:nova-micro"
  "WF5YKQAFJU:nova-lite"
  "GPZVPHNBWQ:nova-pro"
  "OX2KFSLSJM:nova-premier"
)

for agent_info in "${NOVA_AGENTS[@]}"; do
  IFS=':' read -r AGENT_ID AGENT_NAME <<< "$agent_info"

  echo "📝 Updating $AGENT_NAME agent ($AGENT_ID)..."

  # Update the agent with optimized inference configuration
  aws bedrock-agent update-agent \
    --agent-id "$AGENT_ID" \
    --agent-name "oriole-$AGENT_NAME" \
    --foundation-model "us.amazon.${AGENT_NAME}-v1:0" \
    --instruction "You are navigating a 2D maze on a 60x60 grid. Your goal is to reach the exit marked with 'E'.

You start at position marked 'S'. You can move in 4 directions: north, south, east, west.

Each move costs 1 step. The maze has walls ('#') and open paths (' '). You cannot walk through walls.

Use the move functions to navigate. Use recall_all to see all tiles you've observed. Plan your path efficiently to minimize total moves.

IMPORTANT: Your experimentId is provided in the session. Always use it when calling movement functions." \
    --agent-resource-role-arn "arn:aws:iam::864899863517:role/oriole-$AGENT_NAME-role" \
    --idle-session-ttl-in-seconds 600 \
    --prompt-override-configuration "{
      \"promptConfigurations\": [
        {
          \"promptType\": \"ORCHESTRATION\",
          \"promptCreationMode\": \"OVERRIDDEN\",
          \"promptState\": \"ENABLED\",
          \"inferenceConfiguration\": {
            \"temperature\": 0.0,
            \"topP\": 1.0,
            \"topK\": 1,
            \"maximumLength\": 3000,
            \"stopSequences\": [\"</answer>\", \"</invoke>\", \"</thinking>\"]
          },
          \"parserMode\": \"DEFAULT\"
        }
      ]
    }"

  if [ $? -eq 0 ]; then
    echo "✅ Updated $AGENT_NAME agent"
    echo ""
    echo "Preparing agent..."
    aws bedrock-agent prepare-agent --agent-id "$AGENT_ID"

    if [ $? -eq 0 ]; then
      echo "✅ Prepared $AGENT_NAME agent"
    else
      echo "❌ Failed to prepare $AGENT_NAME agent"
      exit 1
    fi
  else
    echo "❌ Failed to update $AGENT_NAME agent"
    exit 1
  fi

  echo ""
  echo "---"
  echo ""
done

echo "✨ All Nova agents updated with optimized inference configuration!"
echo ""
echo "Changes made:"
echo "  - Temperature: 1.0 → 0.0 (greedy decoding)"
echo "  - Max tokens: 1024 → 3000 (more room for tool calls)"
echo "  - Added </invoke> to stop sequences (tool calling marker)"
echo ""
echo "Ready to test! Try running an experiment with a Nova agent."
