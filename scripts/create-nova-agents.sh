#!/bin/bash

# Script to create Nova agents with OVERRIDDEN mode and temperature=0
# This ensures Nova models use greedy decoding (temperature=0) which is required for reliable tool calling

set -e

LAMBDA_ARN="arn:aws:lambda:us-west-2:864899863517:function:OrioleStack-ActionRouterFunction6E6B8B39-mlNPk1reWvBt"

# Nova agent configurations: MODEL_NAME:MODEL_ID:ROLE_ARN
NOVA_AGENTS=(
  "oriole-nova-micro:us.amazon.nova-micro-v1:0:arn:aws:iam::864899863517:role/oriole-nova-micro-role"
  "oriole-nova-lite:us.amazon.nova-lite-v1:0:arn:aws:iam::864899863517:role/oriole-nova-lite-role"
  "oriole-nova-pro:us.amazon.nova-pro-v1:0:arn:aws:iam::864899863517:role/oriole-nova-pro-role"
  "oriole-nova-premier:us.amazon.nova-premier-v1:0:arn:aws:iam::864899863517:role/oriole-nova-premier-role"
)

INSTRUCTION="You are navigating a 2D maze on a 60x60 grid. Your goal is to find the target object. You can see 3 blocks in each cardinal direction using line-of-sight vision (walls block your vision). You know the grid dimensions and your starting position. Use the available tools to navigate and recall your spatial memory."

# Custom orchestration prompt template for OVERRIDDEN mode
# This is based on AWS Bedrock's recommended format for Nova models
ORCHESTRATION_PROMPT='You have been provided with a set of functions to answer the user'\''s question.

You must call the functions to complete your task. Don'\''t make assumptions about what values to use with functions. Ask for clarification if a user request is ambiguous.

Here are the functions available to you:
$functions$

$ask_user_missing_information$

Examine the user'\''s query: <query>$query$</query>

What is the user asking you to do? First think step-by-step in <thinking> tags about which function(s) you need to call and why.

$ask_user_function_call_required_modification$

Then call the appropriate function(s) by outputting a valid function call in this exact format:
<function_calls>
<invoke>
<tool_name>function_name</tool_name>
<parameters>
<parameter_name>value</parameter_name>
</parameters>
</invoke>
</function_calls>

$conversation_history$

$ask_user_input_context$

You will receive function results. Based on the function results, provide your final answer to the user in <answer></answer> tags.'

echo "🚀 Creating Nova agents with OVERRIDDEN mode and temperature=0"
echo ""

for agent_info in "${NOVA_AGENTS[@]}"; do
  IFS=':' read -r AGENT_NAME MODEL_ID ROLE_ARN <<< "$agent_info"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Creating agent: $AGENT_NAME"
  echo "  Model: $MODEL_ID"
  echo "  Temperature: 0.0 (greedy decoding)"
  echo "  Mode: OVERRIDDEN"
  echo ""

  # Create temporary JSON file for prompt configuration
  cat > /tmp/prompt-config-$AGENT_NAME.json << EOF
{
  "promptConfigurations": [
    {
      "promptType": "ORCHESTRATION",
      "promptCreationMode": "OVERRIDDEN",
      "promptState": "ENABLED",
      "basePromptTemplate": $(echo "$ORCHESTRATION_PROMPT" | jq -Rs .),
      "inferenceConfiguration": {
        "temperature": 0.0,
        "topP": 1.0,
        "topK": 250,
        "maximumLength": 2048,
        "stopSequences": ["</function_calls>", "</answer>"]
      }
    }
  ]
}
EOF

  # Create agent with OVERRIDDEN mode and temperature=0
  AGENT_OUTPUT=$(AWS_PROFILE=bobby aws bedrock-agent create-agent \
    --agent-name "$AGENT_NAME" \
    --foundation-model "$MODEL_ID" \
    --instruction "$INSTRUCTION" \
    --agent-resource-role-arn "$ROLE_ARN" \
    --idle-session-ttl-in-seconds 600 \
    --prompt-override-configuration file:///tmp/prompt-config-$AGENT_NAME.json)

  rm -f /tmp/prompt-config-$AGENT_NAME.json

  AGENT_ID=$(echo "$AGENT_OUTPUT" | jq -r '.agent.agentId')
  echo "✓ Agent created with ID: $AGENT_ID"

  # Create action group using the fixed script
  echo ""
  echo "Adding action groups..."
  ./scripts/setup-agent-actions.sh "$AGENT_ID" "$LAMBDA_ARN"

  # Create alias
  echo ""
  echo "Creating 'prod' alias..."
  ALIAS_OUTPUT=$(aws bedrock-agent create-agent-alias \
    --agent-id "$AGENT_ID" \
    --agent-alias-name prod \
    --description "Production alias for $AGENT_NAME" \
    --profile bobby)

  ALIAS_ID=$(echo "$ALIAS_OUTPUT" | jq -r '.agentAlias.agentAliasId')
  echo "✓ Alias created with ID: $ALIAS_ID"

  echo ""
  echo "✅ $AGENT_NAME ready!"
  echo "   Agent ID: $AGENT_ID"
  echo "   Alias ID: $ALIAS_ID"
  echo ""
done

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✨ All Nova agents created successfully!"
echo ""
echo "All agents configured with:"
echo "  • OVERRIDDEN orchestration mode"
echo "  • Temperature: 0.0 (greedy decoding for reliable tool calling)"
echo "  • Custom orchestration prompt optimized for function calling"
echo ""
echo "Ready to test! Try running:"
echo "  ./scripts/trigger-experiment.sh nova-lite 1"
