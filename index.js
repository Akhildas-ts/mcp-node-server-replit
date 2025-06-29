#!/usr/bin/env node

/**
 * Direct STDIO Implementation for MCP
 * - This avoids SDK limitations and directly implements the protocol
 * - Immediately provides server info on startup
 * - Responds to all standard MCP requests
 * - Forwards requests to the Go backend when needed
 */

const fs = require('fs');
const axios = require('axios');
const path = require('path');

// Configuration
const config = {
  GO_SERVER_URL: process.env.GO_SERVER_URL || 'http://localhost:8081',
  DEBUG: process.env.DEBUG || false,
  LOG_FILE: path.join(__dirname, 'mcp-debug.log')
};

// Set up logging
function log(message, data = null) {
  try {
    const timestamp = new Date().toISOString();
    let logMessage = `[${timestamp}] ${message}\n`;
    
    if (data) {
      if (typeof data === 'object') {
        logMessage += JSON.stringify(data, null, 2) + '\n';
      } else {
        logMessage += `${data}\n`;
      }
    }
    
    fs.appendFileSync(config.LOG_FILE, logMessage);
    
    // Also log to stderr if debug is enabled
    if (config.DEBUG) {
      console.error(message);
      if (data) console.error(data);
    }
  } catch (error) {
    // Silently fail if logging fails - don't break the server
    console.error('Logging error:', error.message);
  }
}

// Initialize log file
try {
  log('MCP STDIO server starting');
  log(`Process ID: ${process.pid}`);
  log(`Working directory: ${process.cwd()}`);
  log(`Configured Go server: ${config.GO_SERVER_URL}`);
} catch (error) {
  console.error('Error initializing log file:', error.message);
}

// Server information - immediately available
const serverInfo = {
  name: "MCP Agent Chat",
  version: "1.0.0", 
  description: "Chat agent with vector search capabilities",
  vendor: {
    name: "Your Organization"
  },
  capabilities: {
    chat: true,
    vectorSearch: true,
    indexRepository: true
  }
};

// Define offerings
const offerings = {
  tools: [
    {
      id: "chat",
      name: "Chat",
      description: "Process a chat message with repository context",
      parameters: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", description: "The message to process" },
          repository: { type: "string", description: "Repository to use for context" },
          context: { type: "array", items: { type: "string" }, description: "Additional context" }
        }
      }
    },
    {
      id: "vectorSearch",
      name: "Vector Search",
      description: "Search for code in a repository",
      parameters: {
        type: "object",
        required: ["query", "repository"],
        properties: {
          query: { type: "string", description: "The search query" },
          repository: { type: "string", description: "Repository to search in" },
          limit: { type: "number", description: "Maximum results to return" }
        }
      }
    },
    {
      id: "indexRepository",
      name: "Index Repository",
      description: "Index a repository for search",
      parameters: {
        type: "object",
        required: ["repository"],
        properties: {
          repository: { type: "string", description: "Repository URL to index" },
          branch: { type: "string", description: "Branch to index" }
        }
      }
    }
  ],
  resources: [],
  resourceTemplates: []
};

// Send JSONRPC message to stdout
function sendJsonRpc(message) {
  try {
    const jsonString = JSON.stringify(message);
    log('SENDING', message);
    process.stdout.write(jsonString + '\n');
  } catch (error) {
    log('ERROR SENDING', error.message);
  }
}

// Send server info notification immediately
log('Sending server info notification');
sendJsonRpc({
  jsonrpc: "2.0",
  method: "serverInfo",
  params: { serverInfo }
});

// Send JSON-RPC response
function sendResponse(result, id) {
  sendJsonRpc({
    jsonrpc: '2.0',
    result,
    id
  });
}

// Send JSON-RPC error
function sendError(code, message, id) {
  sendJsonRpc({
    jsonrpc: '2.0',
    error: {
      code,
      message
    },
    id
  });
}

// Handle chat request
async function handleChat(params, id) {
  try {
    log('Handling chat request', params);
    const response = await axios.post(`${config.GO_SERVER_URL}/chat`, params);
    sendResponse(response.data, id);
  } catch (error) {
    log('Chat request error', error.message);
    sendError(-32000, `Chat request failed: ${error.message}`, id);
  }
}

// Handle vector search request
async function handleVectorSearch(params, id) {
  try {
    log('Handling vector search request', params);
    const response = await axios.post(`${config.GO_SERVER_URL}/vector-search`, params);
    sendResponse(response.data, id);
  } catch (error) {
    log('Vector search error', error.message);
    sendError(-32000, `Vector search failed: ${error.message}`, id);
  }
}

// Handle repository indexing request
async function handleIndexRepository(params, id) {
  try {
    log('Handling index repository request', params);
    const response = await axios.post(`${config.GO_SERVER_URL}/index-repository`, params);
    sendResponse(response.data, id);
  } catch (error) {
    log('Index repository error', error.message);
    sendError(-32000, `Index repository failed: ${error.message}`, id);
  }
}

// Process incoming requests
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const input = chunk.toString();
  log('RECEIVED', input);
  
  try {
    // Split input by newlines in case multiple requests come at once
    input.split('\n').forEach(line => {
      if (!line.trim()) return;
      
      const request = JSON.parse(line);
      log('Parsed request', request);
      
      if (request.jsonrpc !== '2.0') {
        log('Invalid JSON-RPC version', request);
        sendError(-32600, 'Invalid JSON-RPC version', request.id);
        return;
      }
      
      // Handle different methods
      switch (request.method) {
        case 'getServerInfo':
          log('Handling getServerInfo request');
          sendResponse({ serverInfo }, request.id);
          break;
          
        case 'listOfferings':
          log('Handling listOfferings request');
          sendResponse(offerings, request.id);
          break;
          
        case 'chat':
        case 'invokeChat':
          handleChat(request.params, request.id);
          break;
          
        case 'vectorSearch':
        case 'invokeVectorSearch':
          handleVectorSearch(request.params, request.id);
          break;
          
        case 'indexRepository':
        case 'invokeIndexRepository':
          handleIndexRepository(request.params, request.id);
          break;
          
        default:
          log('Unknown method', request.method);
          sendError(-32601, `Method not found: ${request.method}`, request.id);
      }
    });
  } catch (error) {
    log('Error processing request', error.message);
    try {
      sendError(-32700, 'Parse error', null);
    } catch (e) {
      log('Error sending error response', e.message);
    }
  }
});

// Intercept uncaught exceptions
process.on('uncaughtException', (error) => {
  log('UNCAUGHT EXCEPTION', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  log('UNHANDLED REJECTION', { reason, promise });
});

// Handle process signals
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down');
  process.exit(0);
});

// Create keep-alive to prevent premature termination
const keepAliveInterval = setInterval(() => {
  log('Keep-alive heartbeat');
}, 30000);

// Clean up on exit
process.on('exit', () => {
  log('Process exit, clearing interval');
  clearInterval(keepAliveInterval);
});

log('MCP STDIO server running');