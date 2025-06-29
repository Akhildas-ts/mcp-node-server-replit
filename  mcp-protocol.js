// mcp-protocol.js in mcp-agent-chat directory
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer } from 'ws';

/**
 * Enhances an Express server with full MCP protocol support
 * @param {express.Application} app - Express application
 * @param {http.Server} server - HTTP server
 * @param {Object} serverInfo - MCP server information
 */
export function setupMCPProtocol(app, server, serverInfo) {
  // Setup Socket.IO for real-time communication
  const io = new SocketIOServer(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  
  // Setup WebSocket server for direct WebSocket connections
  const wss = new WebSocketServer({ server });
  
  // Track active connections
  const connections = new Map();
  
  // Handle WebSocket connections
  wss.on('connection', (ws) => {
    const connectionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    connections.set(connectionId, ws);
    
    console.log(`[${new Date().toISOString()}] WebSocket client connected: ${connectionId}`);
    
    // Send server info immediately after connection
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      method: "serverInfo",
      params: { serverInfo }
    }));
    
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        console.log(`[${new Date().toISOString()}] WebSocket message received:`, data);
        
        // Handle JSON-RPC requests
        if (data.jsonrpc === "2.0") {
          // Handle method calls
          if (data.method === "listOfferings") {
            handleListOfferings(ws, data);
          }
          // Add more method handlers as needed
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] WebSocket message error:`, error);
        sendErrorResponse(ws, "parse_error", -32700, "Parse error", null);
      }
    });
    
    ws.on('close', () => {
      console.log(`[${new Date().toISOString()}] WebSocket client disconnected: ${connectionId}`);
      connections.delete(connectionId);
    });
    
    ws.on('error', (error) => {
      console.error(`[${new Date().toISOString()}] WebSocket error:`, error);
    });
  });
  
  // Handle Socket.IO connections
  io.on('connection', (socket) => {
    console.log(`[${new Date().toISOString()}] Socket.IO client connected: ${socket.id}`);
    
    // Send server info immediately after connection
    socket.emit('serverInfo', { serverInfo });
    
    // Handle standard MCP events
    socket.on('listOfferings', (data, callback) => {
      console.log(`[${new Date().toISOString()}] Socket.IO listOfferings requested`);
      const offerings = getOfferings();
      if (typeof callback === 'function') {
        callback(offerings);
      } else {
        socket.emit('listOfferingsResponse', offerings);
      }
    });
    
    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`[${new Date().toISOString()}] Socket.IO client disconnected: ${socket.id}, Reason: ${reason}`);
    });
  });
  
  // MCP HTTP endpoints
  
  // Standard RPC endpoint for JSON-RPC over HTTP
  app.post('/rpc', express.json(), (req, res) => {
    const rpcRequest = req.body;
    console.log(`[${new Date().toISOString()}] RPC request:`, rpcRequest);
    
    // Check if it's a valid JSON-RPC request
    if (!rpcRequest.jsonrpc || rpcRequest.jsonrpc !== "2.0") {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Invalid Request"
        },
        id: rpcRequest.id || null
      });
    }
    
    // Handle methods
    switch (rpcRequest.method) {
      case "listOfferings":
        res.json({
          jsonrpc: "2.0",
          result: getOfferings(),
          id: rpcRequest.id
        });
        break;
      
      case "getServerInfo":
        res.json({
          jsonrpc: "2.0",
          result: { serverInfo },
          id: rpcRequest.id
        });
        break;
      
      default:
        res.json({
          jsonrpc: "2.0",
          error: {
            code: -32601,
            message: "Method not found"
          },
          id: rpcRequest.id
        });
    }
  });
  
  // Make sure MCP registration returns the proper format
  app.post('/mcp-registration', (req, res) => {
    console.log(`[${new Date().toISOString()}] MCP registration requested`);
    res.json({
      jsonrpc: "2.0",
      result: {
        serverInfo
      },
      id: req.body.id || null
    });
  });
  
  // Enhanced offerings endpoint
  app.post('/offerings', (req, res) => {
    console.log(`[${new Date().toISOString()}] HTTP offerings requested`);
    res.json(getOfferings());
  });
  
  // Helper functions
  
  function getOfferings() {
    return {
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
  }
  
  function handleListOfferings(ws, data) {
    const offerings = getOfferings();
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      result: offerings,
      id: data.id
    }));
  }
  
  function sendErrorResponse(ws, errorType, code, message, id) {
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code,
        message
      },
      id
    }));
  }
  
  return {
    io,
    wss,
    connections
  };
}