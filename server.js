import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Create an MCP server
const server = new McpServer({
  name: 'agent-chat-mcp',
  version: '1.0.0',
});

/**
 * Process a chat message and return a response
 * This is a simple simulation of an agent chat
 */
async function processChat(message, repository = '', context = {}) {
  try {
    // You can expand this with more sophisticated logic
    // For example, connecting to your vector search or other capabilities
    
    // Simple simulation of agent response
    const responses = {
      'hello': 'Hello! How can I help you with your code today?',
      'search': `I'll search for relevant code in the repository: ${repository}`,
      'default': `I received your message: "${message}". I'm an AI agent designed to help with coding tasks.`
    };

    // Choose response based on message content
    let response = responses.default;
    if (message.toLowerCase().includes('hello')) {
      response = responses.hello;
    } else if (message.toLowerCase().includes('search')) {
      response = responses.search;
    }

    // In a real implementation, you might:
    // 1. Use the vector search from your Go implementation
    // 2. Process context information
    // 3. Generate more sophisticated responses

    return {
      message: response,
      repository: repository,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error processing chat:', error);
    throw error;
  }
}

// Add chat tool
server.tool(
  'chat',
  {
    message: z.string().describe('The user message to process'),
    repository: z.string().optional().describe('The GitHub repository to reference'),
    context: z.record(z.any()).optional().describe('Additional context for the chat')
  },
  async ({ message, repository = '', context = {} }) => {
    try {
      const result = await processChat(message, repository, context);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: `Error processing chat: ${errorMessage}`
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Add a vector search tool - simulated version
server.tool(
  'vectorSearch',
  {
    query: z.string().describe('The search query'),
    repository: z.string().describe('The repository to search in'),
    limit: z.number().optional().describe('Maximum number of results to return')
  },
  async ({ query, repository, limit = 5 }) => {
    try {
      // Simulate vector search results
      // In a real implementation, this would call your Go vector search functionality
      const results = [
        {
          file: 'src/main.js',
          content: 'function searchCode() { /* search implementation */ }',
          similarity: 0.95
        },
        {
          file: 'src/utils.js',
          content: 'export const findInCode = (pattern) => { /* find implementation */ }',
          similarity: 0.87
        }
      ];

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              data: {
                query,
                repository,
                results: results.slice(0, limit)
              }
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: `Search failed: ${errorMessage}`
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Start the server
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error('[MCP Error]', error);
  process.exit(1);
});

console.error('Agent Chat MCP server running on stdio'); 