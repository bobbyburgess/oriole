#!/bin/bash

# Setup Agent IDs Script
# Extracts agent/alias IDs from CDK outputs and stores them in Parameter Store
# Also prepares all agents to ensure they're ready for invocation
#
# Usage: ./scripts/setup-agent-ids.sh
#
# This script should be run after CDK deployment to configure the system

set -e

STACK_NAME="OrioleStack"
REGION="us-west-2"
PROFILE="bobby"

echo "=========================================="
echo "Oriole Agent ID Setup"
echo "=========================================="
echo ""

# Get stack outputs
echo "📡 Fetching CDK outputs from stack: $STACK_NAME"
OUTPUTS=$(AWS_PROFILE=$PROFILE aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query 'Stacks[0].Outputs' \
  --output json)

echo "✅ Retrieved stack outputs"
echo ""

# Define model name mappings
# Format: "model-name:OutputKeyForAgentId:OutputKeyForAliasId"
declare -a MODELS=(
  "claude-3.5-haiku:Claude35AgentId:Claude35HaikuAliasId"
  "claude-3-haiku:Claude3AgentId:Claude3HaikuAliasId"
  "nova-micro:NovaMicroAgentId:NovaMicroAliasId"
  "nova-lite:NovaLiteAgentId:NovaLiteAliasId"
  "nova-pro:NovaProAgentId:NovaProAliasId"
  "nova-premier:NovaPremierAgentId:NovaPremierAliasId"
)

echo "🔧 Storing agent IDs in Parameter Store..."
echo ""

for MODEL_CONFIG in "${MODELS[@]}"; do
  IFS=':' read -r MODEL_NAME AGENT_KEY ALIAS_KEY <<< "$MODEL_CONFIG"

  # Extract agent ID from CDK outputs
  AGENT_ID=$(echo "$OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$AGENT_KEY\") | .OutputValue")

  if [ -z "$AGENT_ID" ]; then
    echo "❌ Failed to find agent ID for $MODEL_NAME (key: $AGENT_KEY)"
    continue
  fi

  # Discover alias ID from Bedrock API (CDK outputs may have drift)
  # Look for the "prod" alias for this agent
  ALIAS_ID=$(AWS_PROFILE=$PROFILE aws bedrock-agent list-agent-aliases \
    --agent-id "$AGENT_ID" \
    --region $REGION \
    --no-cli-pager 2>/dev/null | \
    jq -r '.agentAliasSummaries[] | select(.agentAliasName == "prod") | .agentAliasId')

  # Create alias if it doesn't exist
  if [ -z "$ALIAS_ID" ]; then
    echo "  Creating 'prod' alias for $MODEL_NAME (agent: $AGENT_ID)..."
    ALIAS_ID=$(AWS_PROFILE=$PROFILE aws bedrock-agent create-agent-alias \
      --agent-id "$AGENT_ID" \
      --agent-alias-name "prod" \
      --region $REGION \
      --no-cli-pager 2>/dev/null | \
      jq -r '.agentAlias.agentAliasId')

    if [ -z "$ALIAS_ID" ]; then
      echo "❌ Failed to create 'prod' alias for $MODEL_NAME"
      continue
    fi
    echo "    ✅ Created alias: $ALIAS_ID"
  fi

  echo "  $MODEL_NAME:"
  echo "    Agent ID: $AGENT_ID"
  echo "    Alias ID: $ALIAS_ID (discovered from Bedrock)"

  # Store in Parameter Store
  AWS_PROFILE=$PROFILE aws ssm put-parameter \
    --name "/oriole/agents/$MODEL_NAME/id" \
    --value "$AGENT_ID" \
    --type String \
    --overwrite \
    --region $REGION \
    --no-cli-pager > /dev/null

  AWS_PROFILE=$PROFILE aws ssm put-parameter \
    --name "/oriole/agents/$MODEL_NAME/alias-id" \
    --value "$ALIAS_ID" \
    --type String \
    --overwrite \
    --region $REGION \
    --no-cli-pager > /dev/null

  echo "    ✅ Stored in Parameter Store"
  echo ""
done

echo "=========================================="
echo "🔄 Preparing agents..."
echo "=========================================="
echo ""

# Prepare all agents to ensure they're ready for invocation
for MODEL_CONFIG in "${MODELS[@]}"; do
  IFS=':' read -r MODEL_NAME AGENT_KEY ALIAS_KEY <<< "$MODEL_CONFIG"

  AGENT_ID=$(echo "$OUTPUTS" | jq -r ".[] | select(.OutputKey==\"$AGENT_KEY\") | .OutputValue")

  if [ -z "$AGENT_ID" ]; then
    continue
  fi

  echo "Preparing agent: $MODEL_NAME ($AGENT_ID)"

  AWS_PROFILE=$PROFILE aws bedrock-agent prepare-agent \
    --agent-id "$AGENT_ID" \
    --region $REGION \
    --no-cli-pager > /dev/null

  echo "  ✅ Preparation initiated"
done

echo ""
echo "⏳ Waiting 20 seconds for agent preparation to complete..."
sleep 20

echo ""
echo "=========================================="
echo "✅ Setup Complete!"
echo "=========================================="
echo ""
echo "Agent IDs stored in Parameter Store under /oriole/agents/<model-name>/"
echo ""
echo "You can now trigger experiments by model name:"
echo "  ./scripts/trigger-by-name.sh claude-3.5-haiku 1 v2"
echo ""
echo "Available models:"
for MODEL_CONFIG in "${MODELS[@]}"; do
  IFS=':' read -r MODEL_NAME _ _ <<< "$MODEL_CONFIG"
  echo "  - $MODEL_NAME"
done
echo ""
