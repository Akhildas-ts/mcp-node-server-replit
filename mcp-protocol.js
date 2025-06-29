import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer } from 'ws';
import express from 'express';

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

  // MCP HTTP endpoints
  app.post('/rpc', express.json(), (req, res) => {
    const rpcRequest = req.body;
    // Only handle getServerInfo and listOfferings for now
    switch (rpcRequest.method) {
      case "getServerInfo":
        res.json({
          jsonrpc: "2.0",
          result: { serverInfo },
          id: rpcRequest.id
        });
        break;
      case "listOfferings":
        res.json({
          jsonrpc: "2.0",
          result: getOfferings(),
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

  app.post('/mcp-registration', (req, res) => {
    res.json({
      jsonrpc: "2.0",
      result: { serverInfo },
      id: req.body.id || null
    });
  });

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

  return { io, wss };
} 