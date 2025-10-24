#!/bin/bash

# Script to configure Bedrock Agent action groups via AWS CLI
# Usage: ./setup-agent-actions.sh <agent-id> <lambda-arn>

AGENT_ID=$1
LAMBDA_ARN=$2

if [ -z "$AGENT_ID" ] || [ -z "$LAMBDA_ARN" ]; then
  echo "Usage: $0 <agent-id> <lambda-arn>"
  echo ""
  echo "Get these from CDK outputs:"
  echo "  agent-id:   OrioleStack.Claude35AgentId"
  echo "  lambda-arn: OrioleStack.ActionRouterLambdaArn"
  echo ""
  echo "Example:"
  echo "  $0 ABCD1234 arn:aws:lambda:us-west-2:123456789012:function:OrioleStack-ActionRouterFunction..."
  exit 1
fi

echo "Creating action group for agent: $AGENT_ID"
echo "Using Lambda: $LAMBDA_ARN"
echo ""

# Create temporary JSON file with the action group configuration
# This avoids shell quoting issues with inline JSON
cat > /tmp/action-group-$AGENT_ID.json << 'EOF'
{
  "agentId": "AGENT_ID_PLACEHOLDER",
  "agentVersion": "DRAFT",
  "actionGroupName": "oriole-maze-navigation",
  "actionGroupExecutor": {
    "lambda": "LAMBDA_ARN_PLACEHOLDER"
  },
  "apiSchema": {
    "payload": "{\"openapi\": \"3.0.0\", \"info\": {\"title\": \"Maze Navigation API\", \"version\": \"1.0.0\", \"description\": \"Actions for navigating a 2D maze\"}, \"paths\": {\"/move_north\": {\"post\": {\"summary\": \"Move one step north\", \"description\": \"Attempt to move one step in the north direction (negative Y)\", \"operationId\": \"moveNorth\", \"requestBody\": {\"required\": true, \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\", \"properties\": {\"experimentId\": {\"type\": \"integer\", \"description\": \"The current experiment ID\"}, \"reasoning\": {\"type\": \"string\", \"description\": \"Your reasoning for this move\"}}, \"required\": [\"experimentId\"]}}}}, \"responses\": {\"200\": {\"description\": \"Move result\", \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\"}}}}}}}, \"/move_south\": {\"post\": {\"summary\": \"Move one step south\", \"description\": \"Attempt to move one step in the south direction (positive Y)\", \"operationId\": \"moveSouth\", \"requestBody\": {\"required\": true, \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\", \"properties\": {\"experimentId\": {\"type\": \"integer\"}, \"reasoning\": {\"type\": \"string\"}}, \"required\": [\"experimentId\"]}}}}, \"responses\": {\"200\": {\"description\": \"Move result\", \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\"}}}}}}}, \"/move_east\": {\"post\": {\"summary\": \"Move one step east\", \"description\": \"Attempt to move one step in the east direction (positive X)\", \"operationId\": \"moveEast\", \"requestBody\": {\"required\": true, \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\", \"properties\": {\"experimentId\": {\"type\": \"integer\"}, \"reasoning\": {\"type\": \"string\"}}, \"required\": [\"experimentId\"]}}}}, \"responses\": {\"200\": {\"description\": \"Move result\", \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\"}}}}}}}, \"/move_west\": {\"post\": {\"summary\": \"Move one step west\", \"description\": \"Attempt to move one step in the west direction (negative X)\", \"operationId\": \"moveWest\", \"requestBody\": {\"required\": true, \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\", \"properties\": {\"experimentId\": {\"type\": \"integer\"}, \"reasoning\": {\"type\": \"string\"}}, \"required\": [\"experimentId\"]}}}}, \"responses\": {\"200\": {\"description\": \"Move result\", \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\"}}}}}}}, \"/recall_all\": {\"post\": {\"summary\": \"Recall all previously seen tiles\", \"description\": \"Query spatial memory to see all tiles you have observed\", \"operationId\": \"recallAll\", \"requestBody\": {\"required\": true, \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\", \"properties\": {\"experimentId\": {\"type\": \"integer\"}, \"reasoning\": {\"type\": \"string\"}}, \"required\": [\"experimentId\"]}}}}, \"responses\": {\"200\": {\"description\": \"Memory recall result\", \"content\": {\"application/json\": {\"schema\": {\"type\": \"object\"}}}}}}}}}"
  }
}
EOF

# Replace placeholders with actual values
sed -i '' "s/AGENT_ID_PLACEHOLDER/$AGENT_ID/g" /tmp/action-group-$AGENT_ID.json
sed -i '' "s|LAMBDA_ARN_PLACEHOLDER|$LAMBDA_ARN|g" /tmp/action-group-$AGENT_ID.json

# Create action group using the JSON file
aws bedrock-agent create-agent-action-group \
  --cli-input-json file:///tmp/action-group-$AGENT_ID.json \
  --profile bobby

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Action group created successfully!"
  echo ""
  echo "Now preparing agent (this makes the action group active)..."

  aws bedrock-agent prepare-agent \
    --agent-id "$AGENT_ID" \
    --profile bobby

  if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Agent prepared successfully!"
    echo ""
    echo "Your agent is ready to use. You can now trigger experiments with:"
    echo "  ./scripts/trigger-experiment.sh $AGENT_ID <alias-id> model-name 1"
  else
    echo ""
    echo "❌ Failed to prepare agent. Check AWS console for errors."
    exit 1
  fi
else
  echo ""
  echo "❌ Failed to create action group. Check AWS console for errors."
  exit 1
fi

# Clean up temp file
rm -f /tmp/action-group-$AGENT_ID.json
