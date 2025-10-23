# Bedrock Agent Setup Instructions

## Issue
As of CDK 2.220.0, Bedrock Agent Action Groups are not yet available as L1 constructs (`CfnAgentActionGroup`).

## Manual Setup Required

After deploying the CDK stack, you'll need to manually configure the Bedrock Agent action groups through the AWS Console or AWS CLI.

### Steps:

1. **Deploy the CDK stack** (this creates the Lambda functions and Agent)
   ```bash
   npm run deploy
   ```

2. **Get the deployed resources**
   - Note the Agent ID from the CDK outputs
   - Note the Action Router Lambda ARN from the CDK outputs

3. **Create Action Group via AWS Console**
   - Navigate to Amazon Bedrock → Agents
   - Select the `oriole-claude-35-sonnet` agent
   - Click "Edit in Agent Builder"
   - Add Action Group:
     - Name: `NavigationActions`
     - Action group type: `Define with API schemas`
     - Lambda function: Select the ActionRouterFunction
     - API Schema: Use the OpenAPI schema below

4. **OpenAPI Schema for Action Group**

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "Maze Navigation API",
    "version": "1.0.0",
    "description": "Actions for navigating a 2D maze"
  },
  "paths": {
    "/move_north": {
      "post": {
        "summary": "Move one step north",
        "description": "Attempt to move one step in the north direction (negative Y)",
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
        },
        "responses": {
          "200": {
            "description": "Move result"
          }
        }
      }
    },
    "/move_south": {
      "post": {
        "summary": "Move one step south",
        "operationId": "moveSouth",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "experimentId": { "type": "integer" },
                  "reasoning": { "type": "string" }
                },
                "required": ["experimentId"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Move result"
          }
        }
      }
    },
    "/move_east": {
      "post": {
        "summary": "Move one step east",
        "operationId": "moveEast",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "experimentId": { "type": "integer" },
                  "reasoning": { "type": "string" }
                },
                "required": ["experimentId"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Move result"
          }
        }
      }
    },
    "/move_west": {
      "post": {
        "summary": "Move one step west",
        "operationId": "moveWest",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "experimentId": { "type": "integer" },
                  "reasoning": { "type": "string" }
                },
                "required": ["experimentId"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Move result"
          }
        }
      }
    },
    "/recall_all": {
      "post": {
        "summary": "Recall all previously seen tiles",
        "operationId": "recallAll",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "experimentId": { "type": "integer" },
                  "reasoning": { "type": "string" }
                },
                "required": ["experimentId"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Memory recall result"
          }
        }
      }
    }
  }
}
```

5. **Prepare the Agent**
   - After adding the action group, click "Prepare" to update the agent

## Alternative: AWS CLI

You can also use the AWS CLI to create the action group:

```bash
aws bedrock-agent create-agent-action-group \
  --agent-id <AGENT_ID> \
  --agent-version DRAFT \
  --action-group-name NavigationActions \
  --action-group-executor lambda=<LAMBDA_ARN> \
  --api-schema file://action-group-schema.json
```

## Future Improvement

Once CDK adds support for `CfnAgentActionGroup`, update `lib/bedrock-agent-construct.js` to use the native construct.
