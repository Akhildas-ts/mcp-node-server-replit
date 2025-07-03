import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';

// Load configuration with Replit-specific defaults
let config;
try {
  const configFile = fs.readFileSync('./config.json', 'utf8');
  config = JSON.parse(configFile);
} catch (error) {
  config = {
    autoStart: true, // Changed to true for Replit
    port: process.env.PORT || 3000, // Replit uses PORT env var
    goServerUrl: process.env.GO_SERVER_URL || 'http://localhost:8081'
  };
}

const app = express();

// Health check endpoint for Replit
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'MCP Agent Chat Server',
    version: '1.0.0',
    goServerUrl: config.goServerUrl,
    timestamp: new Date().toISOString()
  });
});

// Debug logging
process.on('message', (message) => {
  console.error('DEBUG - MESSAGE RECEIVED:', JSON.stringify(message));
});

// Create an MCP server with stdio transport for integration with Go server
const server = new McpServer({
  name: 'agent-chat-mcp',
  version: '1.0.0',
});

// Configuration for your Go server
const serverConfig = {
  GO_SERVER_URL: config.goServerUrl,
  MCP_SECRET_TOKEN: process.env.MCP_SECRET_TOKEN
};

console.error('DEBUG - CONFIG:', {
  GO_SERVER_URL: serverConfig.GO_SERVER_URL,
  MCP_SECRET_TOKEN: serverConfig.MCP_SECRET_TOKEN ? `${serverConfig.MCP_SECRET_TOKEN.slice(0, 5)}...` : 'not set',
  PORT: config.port
});

// Add authentication header to requests if token is available
const axiosConfig = {
  timeout: 30000, // 30 second timeout
  headers: {}
};
if (serverConfig.MCP_SECRET_TOKEN) {
  axiosConfig.headers['X-MCP-Token'] = serverConfig.MCP_SECRET_TOKEN;
}

// Test endpoint to verify MCP server is working
app.get('/test', async (req, res) => {
  try {
    // Test Go server connection
    let goServerStatus = 'unreachable';
    try {
      const response = await axios.get(`${serverConfig.GO_SERVER_URL}/health`, axiosConfig);
      goServerStatus = response.data.success ? 'connected' : 'unhealthy';
    } catch (e) {
      goServerStatus = `error: ${e.message}`;
    }

    res.json({
      mcp_server: 'running',
      go_server: goServerStatus,
      config: {
        port: config.port,
        goServerUrl: serverConfig.GO_SERVER_URL,
        hasToken: !!serverConfig.MCP_SECRET_TOKEN
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Process a chat message by delegating to the Go server's vector search
 */
async function processChat(message, repository = '', context = {}) {
  try {
    console.error(`DEBUG - Processing chat: "${message}" for repo: ${repository}`);
    
    // First check if Go server is available
    try {
      await axios.get(`${serverConfig.GO_SERVER_URL}/health`, axiosConfig);
    } catch (healthError) {
      console.error('Go server is not available:', healthError.message);
      return {
        message: "The backend server is currently unavailable. Please ensure the Go server is running and accessible.",
        repository: repository,
        codeContext: [],
        timestamp: new Date().toISOString(),
        error: 'backend_unavailable'
      };
    }
    
    // Search for relevant code using the Go server's vector search
    const searchResponse = await axios.post(`${serverConfig.GO_SERVER_URL}/vector-search`, {
      query: message,
      repository: repository,
      limit: 5
    }, axiosConfig);
    
    console.error('DEBUG - Search response status:', searchResponse.status);
    
    // Format the chat response with the search results
    const searchResults = searchResponse.data.success ? searchResponse.data.data : [];
    
    // If no useful results, return a user-friendly fallback
    if (!searchResults || (Array.isArray(searchResults) && searchResults.length === 0)) {
      return {
        message: "Sorry, I couldn't find a clear answer to your question in the repository documentation or code. Please try rephrasing your question or provide more details.",
        repository: repository,
        codeContext: [],
        timestamp: new Date().toISOString()
      };
    }
    
    return {
      message: `I processed your message: "${message}"`,
      repository: repository,
      codeContext: searchResults,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    console.error('Error processing chat:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    
    // On error, also return a user-friendly fallback
    return {
      message: "Sorry, I couldn't find a clear answer to your question in the repository documentation or code. Please try rephrasing your question or provide more details.",
      repository: repository,
      codeContext: [],
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}

// Add chat tool that integrates with Go server
server.tool(
  'chat',
  {
    message: z.string().describe('The user message to process'),
    repository: z.string().optional().describe('The GitHub repository to reference'),
    context: z.record(z.any()).optional().describe('Additional context for the chat')
  },
  async ({ message, repository = '', context = {} }) => {
    try {
      console.error('DEBUG - Chat tool called with:', { message, repository });
      const result = await processChat(message, repository, context);
      console.error('DEBUG - Chat result:', result);
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

// Pass through vector search to Go server
server.tool(
  'vectorSearch',
  {
    query: z.string().describe('The search query'),
    repository: z.string().describe('The repository to search in'),
    limit: z.number().optional().describe('Maximum number of results to return'),
    repoUrl: z.string().optional().describe('The GitHub repository URL to index'),
    branch: z.string().optional().describe('The branch to index (default: main)')
  },
  async ({ query, repository, limit = 5, repoUrl, branch = 'main' }) => {
    function hasResults(result) {
      if (!result || result.isError) return false;
      if (!result.content || !Array.isArray(result.content)) return false;
      // Check if any content item has non-empty text and is not an error
      return result.content.some(
        (item) => item.type === 'text' && item.text && !item.text.includes('error') && item.text !== '{}' && item.text !== '[]'
      );
    }
    
    // 1st attempt
    let result = await (async () => {
      try {
        const response = await axios.post(`${serverConfig.GO_SERVER_URL}/vector-search`, {
          query,
          repository,
          limit
        }, axiosConfig);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response.data, null, 2),
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
    })();
    
    if (hasResults(result)) return result;
    
    // 2nd attempt
    result = await (async () => {
      try {
        const response = await axios.post(`${serverConfig.GO_SERVER_URL}/vector-search`, {
          query,
          repository,
          limit
        }, axiosConfig);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response.data, null, 2),
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
    })();
    
    if (hasResults(result)) return result;
    
    // If still no results, index the repository (if repoUrl is provided)
    if (repoUrl) {
      await server.tools.indexRepository({ repoUrl, branch });
    }
    
    return result;
  }
);

// Add a repository indexing tool to your MCP server
server.tool(
  'indexRepository',
  {
    repoUrl: z.string().describe('The GitHub repository URL to index'),
    branch: z.string().optional().describe('The branch to index (default: main)')
  },
  async ({ repoUrl, branch = 'main' }) => {
    try {
      console.error(`DEBUG - Indexing repository: ${repoUrl}, branch: ${branch}`);
      
      // Call the Go server's repository indexing endpoint
      const response = await axios.post(`${serverConfig.GO_SERVER_URL}/index-repository`, {
        repoUrl,
        branch
      }, axiosConfig);

      console.error('DEBUG - Repository indexing result status:', response.status);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('DEBUG - Repository indexing error:', errorMessage);
      if (error.response) {
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              message: `Repository indexing failed: ${errorMessage}`
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Enable JSON parsing
app.use(express.json());

// Add your MCP routes
app.post('/mcp', async (req, res) => {
  try {
    console.log('Received request body:', req.body);

    // Verify token
    const authHeader = req.headers.authorization;
    if (!authHeader || `Bearer ${serverConfig.MCP_SECRET_TOKEN}` !== authHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let goServerRequest;
    
    if (req.body.tool === 'vectorSearch') {
      // Format for vector search
      goServerRequest = {
        query: req.body.params.query,
        repository: req.body.params.repository,
        branch: req.body.params.branch || 'main'
      };
    } else if (req.body.tool === 'indexRepository') {
      // Format for repository indexing
      goServerRequest = {
        repoUrl: req.body.params.repoUrl,
        branch: req.body.params.branch || 'main'
      };
    } else {
      // Direct format (as shown in your working example)
      goServerRequest = {
        query: req.body.query,
        repository: req.body.repository,
        branch: req.body.branch || 'main'
      };
    }

    console.log('Sending request to Go server:', goServerRequest);
    
    // Choose the correct endpoint based on the tool
    const endpoint = req.body.tool === 'indexRepository' ? '/index-repository' : '/vector-search';
    const response = await fetch(`${serverConfig.GO_SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(goServerRequest)
    });

    const responseData = await response.text();
    console.log('Go server response:', responseData);

    if (!response.ok) {
      console.error(`Go server responded with status ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Request failed',
        message: responseData,
        success: false
      });
    }

    const data = JSON.parse(responseData);
    res.json(data);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      success: false
    });
  }
});

// Keep-alive endpoint for Replit
app.get('/keep-alive', (req, res) => {
  res.json({ alive: true, timestamp: new Date().toISOString() });
});

// Start the HTTP server (Always start on Replit)
app.listen(config.port, '0.0.0.0', () => {
  console.log(`MCP server listening on port ${config.port}`);
  console.log(`Health check: http://localhost:${config.port}/`);
  console.log(`Test endpoint: http://localhost:${config.port}/test`);
});

// Start the stdio server
console.log('Agent Chat MCP server running on stdio');
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error('Failed to connect MCP server:', error);
  // Don't exit on Replit - let the HTTP server continue running
});

// Connect to Go server with retry logic
async function connectToGoServer(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(`${serverConfig.GO_SERVER_URL}/health`, axiosConfig);
      if (response.data.success) {
        console.log(`Connected to Go server at ${serverConfig.GO_SERVER_URL}`);
        return true;
      }
    } catch (error) {
      console.error(`Failed to connect to Go server (attempt ${i + 1}/${retries}): ${error.message}`);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before retry
      }
    }
  }
  console.error('Could not establish connection to Go server after all retries');
  return false;
}

// Initial connection attempt
connectToGoServer();

// Replit keep-alive ping (optional)
if (process.env.REPL_SLUG) {
  setInterval(() => {
    console.log('Keep-alive ping:', new Date().toISOString());
  }, 60000); // Every minute
}