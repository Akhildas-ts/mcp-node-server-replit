// Enhanced MCP Agent Chat Integration Server
// This script supports both stdio and HTTP transport options

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpServerTransport } from '@modelcontextprotocol/sdk/server/http.js';
import { z } from 'zod';
import axios from 'axios';
import 'dotenv/config';
import * as http from 'http';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';

// Improved error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('[MCP ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[MCP ERROR] Uncaught Exception:', err);
});

// Create an MCP server with more detailed information
const serverMcp = new McpServer({
  name: 'vector-search-mcp',
  version: '1.0.0',
  description: 'MCP server for vector search and code repository tools',
  capabilities: ['vector_search', 'code_search', 'repository_indexing'],
});

// Configuration for your Go server
const config = {
  GO_SERVER_URL: process.env.GO_SERVER_URL || 'http://localhost:8081',
  MCP_PORT: parseInt(process.env.MCP_PORT || '3000', 10),
  MCP_SECRET_TOKEN: process.env.MCP_SECRET_TOKEN,
  TRANSPORT: process.env.MCP_TRANSPORT || 'stdio' // 'stdio' or 'http'
};

console.error('[MCP INFO] Starting with config:', {
  GO_SERVER_URL: config.GO_SERVER_URL,
  MCP_PORT: config.MCP_PORT,
  TRANSPORT: config.TRANSPORT,
  MCP_SECRET_TOKEN: config.MCP_SECRET_TOKEN ? `${config.MCP_SECRET_TOKEN.slice(0, 3)}...` : 'not set'
});

// Axios config with timeout and retries
const axiosConfig = {
  timeout: 30000, // 30-second timeout
  headers: config.MCP_SECRET_TOKEN ? { 'X-MCP-Token': config.MCP_SECRET_TOKEN } : {}
};

// Logs to track connection and request state
const connectionLog = new Map();

// Helper function to log connection events
function logConnectionEvent(id, event, data = {}) {
  const timestamp = new Date().toISOString();
  const entry = connectionLog.get(id) || [];
  entry.push({ timestamp, event, data });
  connectionLog.set(id, entry);
  console.error(`[MCP CONN] ${timestamp} [${id}] ${event}`);
}

// Middleware to log and track incoming requests
const requestTracker = (req, res, next) => {
  const requestId = uuidv4().slice(0, 8);
  req.requestId = requestId;
  logConnectionEvent(requestId, 'Request started', { 
    path: req.path, 
    method: req.method, 
    headers: req.headers 
  });
  
  // Track response
  const originalEnd = res.end;
  res.end = function(...args) {
    logConnectionEvent(requestId, 'Response sent', { 
      statusCode: res.statusCode 
    });
    return originalEnd.apply(this, args);
  };
  
  next();
};

// Vector search tool
serverMcp.tool(
  'vector_search',
  {
    query: z.string().describe('The search query'),
    repository: z.string().describe('The repository to search in'),
    limit: z.number().optional().describe('Maximum number of results to return')
  },
  async ({ query, repository, limit = 5 }) => {
    const requestId = uuidv4().slice(0, 8);
    logConnectionEvent(requestId, 'Vector search called', { query, repository, limit });
    
    try {
      const response = await axios.post(`${config.GO_SERVER_URL}/vector-search`, {
        query,
        repository,
        limit
      }, axiosConfig);
      
      logConnectionEvent(requestId, 'Vector search succeeded');
      return {
        content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
      };
    } catch (error) {
      logConnectionEvent(requestId, 'Vector search failed', { error: error.message });
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Repository indexing tool
serverMcp.tool(
  'index_repository',
  {
    repository: z.string().describe('The repository to index'),
    branch: z.string().optional().describe('Branch to index'),
    recursive: z.boolean().optional().default(true).describe('Index recursively')
  },
  async ({ repository, branch, recursive }) => {
    const requestId = uuidv4().slice(0, 8);
    logConnectionEvent(requestId, 'Index repository called', { repository, branch, recursive });
    
    try {
      const response = await axios.post(`${config.GO_SERVER_URL}/index-repository`, {
        repository,
        branch,
        recursive
      }, axiosConfig);
      
      logConnectionEvent(requestId, 'Index repository succeeded');
      return {
        content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
      };
    } catch (error) {
      logConnectionEvent(requestId, 'Index repository failed', { error: error.message });
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Chat tool with better error handling
serverMcp.tool(
  'chat',
  {
    message: z.string().describe('The user message to process'),
    repository: z.string().optional().describe('The GitHub repository to reference'),
    context: z.record(z.any()).optional().describe('Additional context for the chat')
  },
  async ({ message, repository = '', context = {} }) => {
    const requestId = uuidv4().slice(0, 8);
    logConnectionEvent(requestId, 'Chat called', { messageLength: message.length, repository });
    
    try {
      // Forward to Go server if the chat endpoint exists there
      try {
        const response = await axios.post(`${config.GO_SERVER_URL}/chat`, {
          message,
          repository,
          context
        }, { ...axiosConfig, timeout: 60000 }); // Longer timeout for chat
        
        logConnectionEvent(requestId, 'Chat succeeded (Go server)');
        return {
          content: [{ type: 'text', text: JSON.stringify(response.data, null, 2) }]
        };
      } catch (error) {
        // Fall back to local echo if Go server chat fails
        if (error.response && error.response.status === 404) {
          logConnectionEvent(requestId, 'Chat fallback to local');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message: `I received your message about "${message.substring(0, 30)}...". 
                  Repository: ${repository || 'not specified'}`,
                  timestamp: new Date().toISOString()
                }, null, 2),
              },
            ],
          };
        }
        
        // Re-throw for general error handling
        throw error;
      }
    } catch (error) {
      logConnectionEvent(requestId, 'Chat failed', { error: error.message });
      return {
        content: [{ type: 'text', text: `Error processing chat: ${error.message}` }],
        isError: true
      };
    }
  }
);

// Health check tool
serverMcp.tool(
  'health',
  {},
  async () => {
    const requestId = uuidv4().slice(0, 8);
    logConnectionEvent(requestId, 'Health check called');
    
    try {
      // Check if Go server is reachable
      const response = await axios.get(`${config.GO_SERVER_URL}/health`, axiosConfig);
      
      logConnectionEvent(requestId, 'Health check succeeded');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'healthy',
              mcp_server: true,
              go_server: response.data.status === 'ok',
              timestamp: new Date().toISOString()
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      logConnectionEvent(requestId, 'Health check detected Go server issue', { error: error.message });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'partial',
              mcp_server: true,
              go_server: false,
              go_server_error: error.message,
              timestamp: new Date().toISOString()
            }, null, 2),
          },
        ],
      };
    }
  }
);

// Connection management
async function startServer() {
  try {
    if (config.TRANSPORT === 'http') {
      // Create Express app and HTTP server
      const app = express();
      const server = http.createServer({
        keepAliveTimeout: 120000, // 2 minutes
        headersTimeout: 120000    // 2 minutes
      }, app);
      
      // Add request tracking middleware
      app.use(requestTracker);
      
      // Create HTTP transport
      const transport = new HttpServerTransport({
        server,
        path: '/mcp'
      });
      
      // Connect MCP server to HTTP transport
      await serverMcp.connect(transport);
      
      // Start HTTP server
      server.listen(config.MCP_PORT, () => {
        console.error(`[MCP INFO] HTTP MCP server running on port ${config.MCP_PORT}`);
        console.error(`[MCP INFO] MCP endpoint available at http://localhost:${config.MCP_PORT}/mcp`);
      });
      
      // Add server event listeners
      server.on('clientError', (err, socket) => {
        console.error('[MCP ERROR] Client connection error:', err.message);
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      });
    } else {
      // Use stdio transport for non-HTTP mode
      console.error('[MCP INFO] Starting MCP server with stdio transport');
      const transport = new StdioServerTransport();
      await serverMcp.connect(transport);
      console.error('[MCP INFO] MCP server running on stdio');
      
      // Keep the process alive
      setInterval(() => {
        // Periodic health check of Go server
        axios.get(`${config.GO_SERVER_URL}/health`, axiosConfig)
          .then(response => {
            // Only log changes in Go server status
            const status = response.data.status === 'ok' ? 'healthy' : 'unhealthy';
            if (!global.lastGoStatus || global.lastGoStatus !== status) {
              console.error(`[MCP INFO] Go server is ${status}`);
              global.lastGoStatus = status;
            }
          })
          .catch(error => {
            if (!global.lastGoStatus || global.lastGoStatus !== 'unreachable') {
              console.error('[MCP WARN] Go server is unreachable:', error.message);
              global.lastGoStatus = 'unreachable';
            }
          });
      }, 30000); // Check every 30 seconds
    }
  } catch (error) {
    console.error('[MCP ERROR] Failed to start MCP server:', error);
    process.exit(1);
  }
}

// Start server
startServer();