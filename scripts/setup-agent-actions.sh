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

# Create action group
aws bedrock-agent create-agent-action-group \
  --agent-id "$AGENT_ID" \
  --agent-version DRAFT \
  --action-group-name NavigationActions \
  --action-group-executor lambda="$LAMBDA_ARN" \
  --api-schema payload='{
    "openapi": "3.0.0",
    "info": {
      "title": "Maze Navigation API",
      "version": "1.0.0"
    },
    "paths": {
      "/move_north": {
        "post": {
          "description": "Move one step north (negative Y)",
          "operationId": "moveNorth",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "experimentId": {
                      "type": "integer",
                      "description": "The current experiment ID"
                    },
                    "reasoning": {
                      "type": "string",
                      "description": "Your reasoning for this move"
                    }
                  },
                  "required": ["experimentId"]
                }
              }
            }
          }
        }
      },
      "/move_south": {
        "post": {
          "description": "Move one step south (positive Y)",
          "operationId": "moveSouth",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "experimentId": {"type": "integer"},
                    "reasoning": {"type": "string"}
                  },
                  "required": ["experimentId"]
                }
              }
            }
          }
        }
      },
      "/move_east": {
        "post": {
          "description": "Move one step east (positive X)",
          "operationId": "moveEast",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "experimentId": {"type": "integer"},
                    "reasoning": {"type": "string"}
                  },
                  "required": ["experimentId"]
                }
              }
            }
          }
        }
      },
      "/move_west": {
        "post": {
          "description": "Move one step west (negative X)",
          "operationId": "moveWest",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "experimentId": {"type": "integer"},
                    "reasoning": {"type": "string"}
                  },
                  "required": ["experimentId"]
                }
              }
            }
          }
        }
      },
      "/recall_all": {
        "post": {
          "description": "Query spatial memory to see all tiles you have observed",
          "operationId": "recallAll",
          "requestBody": {
            "required": true,
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "experimentId": {"type": "integer"},
                    "reasoning": {"type": "string"}
                  },
                  "required": ["experimentId"]
                }
              }
            }
          }
        }
      }
    }
  }'

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Action group created successfully!"
  echo ""
  echo "Now preparing agent (this makes the action group active)..."

  aws bedrock-agent prepare-agent \
    --agent-id "$AGENT_ID"

  if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Agent prepared successfully!"
    echo ""
    echo "Your agent is ready to use. You can now trigger experiments with:"
    echo "  ./scripts/trigger-experiment.sh $AGENT_ID <alias-id> claude-3-5-haiku 1"
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
