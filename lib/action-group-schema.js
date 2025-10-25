// OpenAPI schema for Bedrock Agent action groups
// Defines the tools available for grid exploration

const MAZE_NAVIGATION_SCHEMA = {
  openapi: "3.0.0",
  info: {
    title: "Grid Exploration API",
    version: "1.0.0",
    description: "Actions for exploring a 2D grid with walls"
  },
  paths: {
    "/move_north": {
      post: {
        summary: "Move one step north",
        description: "Attempt to move one step in the north direction (negative Y)",
        operationId: "moveNorth",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  experimentId: {
                    type: "integer",
                    description: "The current experiment ID"
                  },
                  reasoning: {
                    type: "string",
                    description: "Your reasoning for this move"
                  }
                },
                required: ["experimentId"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Move result",
            content: {
              "application/json": {
                schema: {
                  type: "object"
                }
              }
            }
          }
        }
      }
    },
    "/move_south": {
      post: {
        summary: "Move one step south",
        description: "Attempt to move one step in the south direction (positive Y)",
        operationId: "moveSouth",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  experimentId: { type: "integer" },
                  reasoning: { type: "string" }
                },
                required: ["experimentId"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Move result",
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          }
        }
      }
    },
    "/move_east": {
      post: {
        summary: "Move one step east",
        description: "Attempt to move one step in the east direction (positive X)",
        operationId: "moveEast",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  experimentId: { type: "integer" },
                  reasoning: { type: "string" }
                },
                required: ["experimentId"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Move result",
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          }
        }
      }
    },
    "/move_west": {
      post: {
        summary: "Move one step west",
        description: "Attempt to move one step in the west direction (negative X)",
        operationId: "moveWest",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  experimentId: { type: "integer" },
                  reasoning: { type: "string" }
                },
                required: ["experimentId"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Move result",
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          }
        }
      }
    },
    "/recall_all": {
      post: {
        summary: "Recall all previously seen tiles",
        description: "Query spatial memory to see all tiles you have observed",
        operationId: "recallAll",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  experimentId: { type: "integer" },
                  reasoning: { type: "string" }
                },
                required: ["experimentId"]
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Memory recall result",
            content: {
              "application/json": {
                schema: { type: "object" }
              }
            }
          }
        }
      }
    }
  }
};

module.exports = { MAZE_NAVIGATION_SCHEMA };
