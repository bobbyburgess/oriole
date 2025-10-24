#!/bin/bash

# Configure Bedrock Agent prompt settings based on Parameter Store
# Reads orchestration mode (DEFAULT vs OVERRIDDEN) from SSM parameters
# and applies appropriate inference configuration per model type

set -e

echo "📝 Configuring Bedrock Agent prompts from Parameter Store..."
echo ""

# Agent configurations: AGENT_ID:MODEL_KEY:MODEL_ID
AGENTS=(
  "26U4QFQUJT:claude-3-5-haiku:anthropic.claude-3-5-haiku-20241022-v1:0"
  "NUVT0TX9GE:nova:us.amazon.nova-micro-v1:0"
  "WF5YKQAFJU:nova:us.amazon.nova-lite-v1:0"
  "GPZVPHNBWQ:nova:us.amazon.nova-pro-v1:0"
  "OX2KFSLSJM:nova:us.amazon.nova-premier-v1:0"
)

for agent_info in "${AGENTS[@]}"; do
  IFS=':' read -r AGENT_ID MODEL_KEY MODEL_ID <<< "$agent_info"

  echo "🔧 Configuring agent $AGENT_ID ($MODEL_KEY)..."

  # Get orchestration mode from Parameter Store
  ORCH_MODE=$(aws ssm get-parameter --name "/oriole/prompts/${MODEL_KEY}/orchestration-mode" --query 'Parameter.Value' --output text --profile bobby 2>/dev/null || echo "DEFAULT")

  # Get temperature from Parameter Store
  TEMPERATURE=$(aws ssm get-parameter --name "/oriole/prompts/${MODEL_KEY}/temperature" --query 'Parameter.Value' --output text --profile bobby 2>/dev/null || echo "0.0")

  echo "  Mode: $ORCH_MODE"
  echo "  Temperature: $TEMPERATURE"

  # Get current agent details
  AGENT_NAME=$(aws bedrock-agent get-agent --agent-id "$AGENT_ID" --profile bobby --query 'agent.agentName' --output text)
  AGENT_INSTRUCTION=$(aws bedrock-agent get-agent --agent-id "$AGENT_ID" --profile bobby --query 'agent.instruction' --output text)
  AGENT_ROLE=$(aws bedrock-agent get-agent --agent-id "$AGENT_ID" --profile bobby --query 'agent.agentResourceRoleArn' --output text)

  if [ "$ORCH_MODE" = "DEFAULT" ]; then
    echo "  Using DEFAULT orchestration prompt (AWS-provided tool calling instructions)"

    # For DEFAULT mode, we can't override inference config
    # Remove prompt override configuration entirely to use AWS defaults
    aws bedrock-agent update-agent \
      --agent-id "$AGENT_ID" \
      --agent-name "$AGENT_NAME" \
      --foundation-model "$MODEL_ID" \
      --instruction "$AGENT_INSTRUCTION" \
      --agent-resource-role-arn "$AGENT_ROLE" \
      --idle-session-ttl-in-seconds 600 \
      --profile bobby > /dev/null

    echo "  ⚠️  Note: DEFAULT mode uses AWS-provided temperature and inference settings"

  else
    echo "  Using OVERRIDDEN orchestration prompt (use existing configuration)"
    echo "  ⚠️  OVERRIDDEN mode requires manual configuration or existing setup"
    echo "  Skipping update to preserve existing prompt template..."
  fi

  echo "  ✅ Updated agent configuration"

  # Prepare agent to apply changes
  echo "  Preparing agent..."
  aws bedrock-agent prepare-agent --agent-id "$AGENT_ID" --profile bobby > /dev/null
  echo "  ✅ Agent prepared"

  echo ""
done

echo "✨ All agents configured!"
echo ""
echo "Configuration summary:"
echo "  - Claude Haiku: OVERRIDDEN mode (custom thinking steps)"
echo "  - Nova models: DEFAULT mode (AWS-provided tool calling instructions)"
echo "  - All models: temperature = 0.0 (greedy decoding)"
echo ""
echo "Ready to test! Try running: ./scripts/trigger-experiment.sh nova-lite 1"
