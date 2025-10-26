// Shared tool definitions for both Bedrock Agent and Ollama
// Single source of truth for available actions
//
// This file ensures DRY principle - tools are defined once and used by:
// 1. Bedrock Agent Action Groups (via OpenAPI schema conversion)
// 2. Ollama function calling (via Ollama format conversion)
//
// Benefits:
// - A/B testing with identical tool definitions
// - Single file to update when adding new actions
// - Consistent tool behavior across LLM providers

const fs = require('fs');
const path = require('path');

// Load tool definitions from shared config
function loadToolDefinitions() {
  const toolsPath = path.join(__dirname, 'tools.json');
  const toolsData = fs.readFileSync(toolsPath, 'utf8');
  return JSON.parse(toolsData);
}

/**
 * Convert shared tool definitions to Ollama function calling format
 *
 * Ollama format (OpenAI-compatible):
 * {
 *   type: "function",
 *   function: {
 *     name: "move_north",
 *     description: "...",
 *     parameters: { type: "object", properties: {...}, required: [...] }
 *   }
 * }
 */
function getOllamaTools() {
  const { tools } = loadToolDefinitions();

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

/**
 * Convert shared tool definitions to Bedrock Agent OpenAPI schema
 *
 * Bedrock Agent format:
 * OpenAPI 3.0 schema with paths for each action
 * Used in Action Group configuration
 *
 * Bedrock requires specific fields: summary, operationId, and simpler response schemas
 */
function getBedrockOpenAPISchema() {
  const { tools } = loadToolDefinitions();

  const paths = {};

  tools.forEach(tool => {
    // Convert tool name to camelCase for operationId
    const operationId = tool.name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

    // Generate a short summary from description (first sentence)
    const summary = tool.description.split('.')[0];

    paths[`/${tool.name}`] = {
      post: {
        summary: summary,
        description: tool.description,
        operationId: operationId,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: tool.parameters
            }
          }
        },
        responses: {
          '200': {
            description: 'Action result',
            content: {
              'application/json': {
                schema: {
                  type: 'object'
                }
              }
            }
          }
        }
      }
    };
  });

  return {
    openapi: '3.0.0',
    info: {
      title: 'Grid Exploration API',
      version: '1.0.0',
      description: 'Actions for exploring a 2D grid with walls'
    },
    paths
  };
}

module.exports = {
  loadToolDefinitions,
  getOllamaTools,
  getBedrockOpenAPISchema
};
