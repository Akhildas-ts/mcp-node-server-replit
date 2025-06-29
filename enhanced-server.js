// enhanced-server.js in mcp-agent-chat directory
import express from 'express';
import http from 'http';
import axios from 'axios';
import { setupMCPProtocol } from './mcp-protocol.js';

console.log('[' + new Date().toISOString() + '] Initializing MCP server with enhanced protocol support');

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Basic middleware
app.use(express.json());

// Configure server
const GO_SERVER_URL = process.env.GO_SERVER_URL || 'http://localhost:8081';
const MCP_PORT = process.env.MCP_PORT || 3000;

// Create axios client with timeout
const goServerClient = axios.create({
  baseURL: GO_SERVER_URL,
  timeout: 60000,
  headers: {'Content-Type': 'application/json'}
});

// Keep-alive configuration
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000; // 66 seconds

// Configure server info for MCP protocol
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

// Set up the MCP protocol handlers
const { io, wss } = setupMCPProtocol(app, server, serverInfo);

// Connection tracking middleware
const connectionTracking = (req, res, next) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] Connection from ${clientIp} to ${req.path}`);
  
  // Set timeout for the request
  req.setTimeout(120000); // 2 minute timeout
  
  // Handle connection closure
  res.on('close', () => {
    console.log(`[${new Date().toISOString()}] Connection closed for ${req.path}`);
  });
  
  // Override end method to log responses
  const originalEnd = res.end;
  res.end = function() {
    console.log(`[${new Date().toISOString()}] Response sent for ${req.path} with status ${res.statusCode}`);
    originalEnd.apply(res, arguments);
  };
  
  next();
};

app.use(connectionTracking);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const response = await goServerClient.get('/health');
    res.json({ 
      mcp: 'healthy',
      goServer: response.data.status === 'ok' ? 'healthy' : 'unhealthy' 
    });
  } catch (error) {
    console.error('Error checking Go server health:', error.message);
    res.json({ 
      mcp: 'healthy',
      goServer: 'unhealthy' 
    });
  }
});

// Chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const response = await goServerClient.post('/chat', req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error forwarding chat request:', error.message);
    res.status(500).json({ error: 'Failed to process chat request' });
  }
});

// Vector search endpoint
app.post('/vector-search', async (req, res) => {
  try {
    const response = await goServerClient.post('/vector-search', req.body);
    res.json(response.data);
  } catch (error) {
    console.error('Error forwarding vector search request:', error.message);
    res.status(500).json({ error: 'Failed to process vector search request' });
  }
});

// Start the server
server.listen(MCP_PORT, () => {
  console.log(`MCP Agent Chat Server with enhanced protocol support listening on port ${MCP_PORT}`);
  
  // Verify connection to Go server on startup
  goServerClient.get('/health')
    .then(response => {
      console.log(`Connected to Go Vector Search Server at ${GO_SERVER_URL}`);
    })
    .catch(error => {
      console.error(`Failed to connect to Go Vector Search Server: ${error.message}`);
      console.log('This is expected if Go server is not running. MCP functionality will be limited.');
    });
});