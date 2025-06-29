import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import fs from 'fs';

// Load configuration
let config;
try {
  const configFile = fs.readFileSync('./config.json', 'utf8');
  config = JSON.parse(configFile);
} catch (error) {
  config = {
    autoStart: false,
    port: process.env.MCP_PORT || 3000,
    goServerUrl: process.env.GO_SERVER_URL || 'http://localhost:8081'
  };
}

const app = express();

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
  MCP_SECRET_TOKEN: serverConfig.MCP_SECRET_TOKEN ? `${serverConfig.MCP_SECRET_TOKEN.slice(0, 5)}...` : 'not set'
});

// Add authentication header to requests if token is available
const axiosConfig = {};
if (serverConfig.MCP_SECRET_TOKEN) {
  axiosConfig.headers = {
    'X-MCP-Token': serverConfig.MCP_SECRET_TOKEN
  };
}

// In-memory OAuth token
let OAUTH_TOKEN = null;

function setToken(token) {
  OAUTH_TOKEN = token;
}

function clearToken() {
  OAUTH_TOKEN = null;
}

function getAuthHeader() {
  return OAUTH_TOKEN ? { 'Authorization': `Bearer ${OAUTH_TOKEN}` } : {};
}

const AUTH_LOGIN_URL = `${serverConfig.GO_SERVER_URL}/auth/login`;

// Helper for protected requests
async function protectedAxios(options) {
  if (!OAUTH_TOKEN) {
    return {
      error: true,
      message: `No token found. Please get your token from: ${AUTH_LOGIN_URL} and try your request again with the token.`
    };
  }
  try {
    options.headers = { ...options.headers, ...getAuthHeader() };
    const response = await axios(options);
    return response.data;
  } catch (error) {
    if (error.response && (error.response.status === 401 || error.response.status === 403)) {
      clearToken();
      return {
        error: true,
        message: `Token expired or invalid. Please get a new token from: ${AUTH_LOGIN_URL}`
      };
    }
    throw error;
  }
}

// Helper for protected fetch requests
async function protectedFetch(url, fetchOptions = {}) {
  if (!OAUTH_TOKEN) {
    return {
      error: true,
      message: `No token found. Please get your token from: ${AUTH_LOGIN_URL} and try your request again with the token.`
    };
  }
  try {
    fetchOptions.headers = { ...fetchOptions.headers, ...getAuthHeader(), 'Content-Type': 'application/json' };
    const response = await fetch(url, fetchOptions);
    if (response.status === 401 || response.status === 403) {
      clearToken();
      return {
        error: true,
        message: `Token expired or invalid. Please get a new token from: ${AUTH_LOGIN_URL}`
      };
    }
    const data = await response.text();
    return JSON.parse(data);
  } catch (error) {
    throw error;
  }
}

/**
 * Process a chat message by delegating to the Go server's vector search
 */
async function processChat(message, repository = '', context = {}) {
  try {
    console.error(`DEBUG - Processing chat: "${message}" for repo: ${repository}`);
    // Use the new /search endpoint
    const searchResponse = await axios.post(`${serverConfig.GO_SERVER_URL}/search`, {
      query: message,
      repository: repository,
      limit: 5
    }, axiosConfig);
    console.error('DEBUG - Search response status:', searchResponse.status);
    const searchResults = searchResponse.data.success ? searchResponse.data.data : [];
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
    return {
      message: "Sorry, I couldn't find a clear answer to your question in the repository documentation or code. Please try rephrasing your question or provide more details.",
      repository: repository,
      codeContext: [],
      timestamp: new Date().toISOString()
    };
  }
}

// Enhanced chat tool with repository indexing flow
server.tool(
  'chat',
  {
    message: z.string().describe('The user message to process'),
    repository: z.string().optional().describe('The GitHub repository to reference'),
    context: z.record(z.any()).optional().describe('Additional context for the chat')
  },
  async ({ message, repository = '', context = {} }) => {
    // Handle /set-token <token> command
    if (message.trim().startsWith('/set-token ')) {
      const token = message.trim().slice(11).trim();
      if (token) {
        setToken(token);
        return {
          content: [
            {
              type: 'text',
              text: 'Token set! You can now use the chat.'
            }
          ]
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: 'Please provide a token after /set-token.'
            }
          ]
        };
      }
    }
    // Handle /index-repo <repoUrl> command
    if (message.trim().startsWith('/index-repo ')) {
      let repoUrl = message.trim().slice(11).trim();
      if (!repoUrl) {
        return {
          content: [
            {
              type: 'text',
              text: 'Please provide a repository URL after /index-repo.'
            }
          ]
        };
      }
      // If not a full URL, convert owner/repo to full GitHub URL
      if (!repoUrl.startsWith('http')) {
        repoUrl = `https://github.com/${repoUrl}`;
      }
      // Always attempt to index the repository, let the Go server decide if it exists
      const indexResult = await protectedAxios({
        method: 'POST',
        url: `${serverConfig.GO_SERVER_URL}/index`,
        data: { repo_url: repoUrl }
      });
      if (indexResult && indexResult.error) {
        return {
          content: [
            {
              type: 'text',
              text: `Indexing failed: ${indexResult.message}`
            }
          ]
        };
      }
      // If Go server returns an error message in the response
      if (indexResult && indexResult.status === 'error') {
        return {
          content: [
            {
              type: 'text',
              text: `Indexing failed: ${indexResult.message}`
            }
          ]
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Indexing started for ${repoUrl}. I will notify you when it's ready.`
          }
        ]
      };
    }
    // If no token, prompt user
    if (!OAUTH_TOKEN) {
      return {
        content: [
          {
            type: 'text',
            text: `No token found. Please get your token from: ${AUTH_LOGIN_URL} and try your request again with the token.`
          }
        ]
      };
    }
    // Normal chat logic (protected)
    try {
      const result = await processChatWithToken(message, repository, context);
      // If repository not found or not indexed, automatically trigger indexing
      if (result && (result.error || result.status === 'error' || result.status_code === 500 || (result.message && result.message.toLowerCase().includes('not found')))) {
        // Attempt to index automatically
        let repoUrl = repository;
        if (!repoUrl.startsWith('http')) {
          repoUrl = `https://github.com/${repoUrl}`;
        }
        const indexResult = await protectedAxios({
          method: 'POST',
          url: `${serverConfig.GO_SERVER_URL}/index`,
          data: { repo_url: repoUrl }
        });
        if (indexResult && (indexResult.error || indexResult.status === 'error')) {
          return {
            content: [
              {
                type: 'text',
                text: `Repository '${repository}' not found or not indexed. Attempted to index but failed: ${indexResult.message}`
              }
            ]
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `Repository '${repository}' not found or not indexed. Indexing has been started automatically. Please try your request again after indexing is complete.`
            }
          ]
        };
      }
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

// Use protectedAxios in processChat
async function processChatWithToken(message, repository = '', context = {}) {
  return await protectedAxios({
    method: 'POST',
    url: `${serverConfig.GO_SERVER_URL}/search`,
    data: {
      query: message,
      repository: repository,
      limit: 5
    }
  });
}

// Enhanced vectorSearch tool with automatic indexing
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
    if (!OAUTH_TOKEN) {
      return {
        content: [
          {
            type: 'text',
            text: `No token found. Please get your token from: ${AUTH_LOGIN_URL} and try your request again with the token.`
          }
        ]
      };
    }
    // Always use owner/repo for search endpoints
    let result = await protectedAxios({
      method: 'POST',
      url: `${serverConfig.GO_SERVER_URL}/search`,
      data: { query, repository, limit }
    });
    // If repository not found or not indexed, automatically trigger indexing
    if (result && (result.error || result.status === 'error' || result.status_code === 500 || (result.message && result.message.toLowerCase().includes('not found')))) {
      // For indexing, use full URL
      let repoUrlToIndex = repository;
      if (!repoUrlToIndex.startsWith('http')) {
        repoUrlToIndex = `https://github.com/${repoUrlToIndex}`;
      }
      const indexResult = await protectedAxios({
        method: 'POST',
        url: `${serverConfig.GO_SERVER_URL}/index`,
        data: { repo_url: repoUrlToIndex }
      });
      if (indexResult && (indexResult.error || indexResult.status === 'error')) {
        return {
          content: [
            {
              type: 'text',
              text: `Repository '${repository}' not found or not indexed. Attempted to index but failed: ${indexResult.message}`
            }
          ]
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Repository '${repository}' not found or not indexed. Indexing has been started automatically. Please try your request again after indexing is complete.`
          }
        ]
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// Enhanced vectorSearchWithSummary tool with correct repository field
server.tool(
  'vectorSearchWithSummary',
  {
    query: z.string().describe('The search query'),
    repository: z.string().describe('The repository to search in'),
    limit: z.number().optional().describe('Maximum number of results to return'),
    branch: z.string().optional().describe('The branch to index (default: main)')
  },
  async ({ query, repository, limit = 5, branch = 'main' }) => {
    if (!OAUTH_TOKEN) {
      return {
        content: [
          {
            type: 'text',
            text: `No token found. Please get your token from: ${AUTH_LOGIN_URL} and try your request again with the token.`
          }
        ]
      };
    }
    async function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
    let indexed = false;
    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        // Always use owner/repo for summary search
        const response = await axios.post(`${serverConfig.GO_SERVER_URL}/search/summary`, {
          query,
          repository, // owner/repo only
          limit,
          branch
        }, { headers: getAuthHeader() });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      } catch (error) {
        lastError = error;
        // Enhanced error handling and auto-indexing logic
        let errorMessage = error instanceof Error ? error.message : String(error);
        let responseData = error.response && error.response.data ? error.response.data : null;
        let notFound = false;
        if (responseData && typeof responseData === 'object') {
          const msg = (responseData.message || '').toLowerCase();
          notFound = msg.includes('not found') || msg.includes('not indexed');
        } else if (errorMessage.toLowerCase().includes('not found')) {
          notFound = true;
        }
        if (notFound || (error.response && (error.response.status === 404 || error.response.status === 500))) {
          if (!indexed) {
            // For indexing, use full URL
            let repoUrlToIndex = repository;
            if (!repoUrlToIndex.startsWith('http')) {
              repoUrlToIndex = `https://github.com/${repoUrlToIndex}`;
            }
            const indexResult = await protectedAxios({
              method: 'POST',
              url: `${serverConfig.GO_SERVER_URL}/index`,
              data: { repo_url: repoUrlToIndex }
            });
            if (indexResult && (indexResult.error || indexResult.status === 'error')) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Repository '${repository}' not found or not indexed. Attempted to index but failed: ${indexResult.message}`
                  }
                ]
              };
            }
            indexed = true;
            // Wait before retrying
            await delay(10000); // 10 seconds
            continue;
          } else if (attempt < 5) {
            // Wait and retry
            await delay(10000); // 10 seconds
            continue;
          }
        }
        break;
      }
    }
    // If we reach here, all retries failed
    let errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
    return {
      content: [
        {
          type: 'text',
          text: `Repository '${repository}' not found or not indexed after multiple attempts. Please try again later. Last error: ${errorMessage}`
        }
      ]
    };
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
      const response = await axios.post(`${serverConfig.GO_SERVER_URL}/index`, {
        repo_url: repoUrl,
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
        if (error.response.status === 401) {
          return {
            content: [
              {
                type: 'text',
                text: `Repository indexing failed due to authentication (401 Unauthorized). Please resend the request with your token using /set-token <your_token> and try again.`
              }
            ],
            isError: true,
          };
        }
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

// Add repositories tool for /repositories endpoint
server.tool(
  'repositories',
  {},
  async () => {
    try {
      const response = await axios.get(`${serverConfig.GO_SERVER_URL}/repositories`, axiosConfig);
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
              message: `Failed to fetch repositories: ${errorMessage}`
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Add profile tool for /profile endpoint
server.tool(
  'profile',
  {},
  async () => {
    try {
      const response = await axios.get(`${serverConfig.GO_SERVER_URL}/profile`, axiosConfig);
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
              message: `Failed to fetch profile: ${errorMessage}`
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }
);

// Only start the HTTP server if autoStart is true
if (config.autoStart) {
  app.listen(config.port, () => {
    console.log(`MCP server listening on port ${config.port}`);
  });
}

// Start the stdio server
console.log('Agent Chat MCP server running on stdio');
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error('Failed to connect MCP server:', error);
  process.exit(1);
});

// Connect to Go server
try {
  const response = await axios.get(`${serverConfig.GO_SERVER_URL}/health`, axiosConfig);
  if (response.data.success) {
    console.log(`Connected to Go server at ${serverConfig.GO_SERVER_URL}`);
  }
} catch (error) {
  console.error(`Failed to connect to Go server: ${error.message}`);
}

// Enable JSON parsing
app.use(express.json());

// Add your MCP routes
app.post('/mcp', async (req, res) => {
  try {
    console.log('Received request body:', req.body);
    const authHeader = req.headers.authorization;
    if (!authHeader || `Bearer ${serverConfig.MCP_SECRET_TOKEN}` !== authHeader) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    let goServerRequest;
    let endpoint;
    if (req.body.tool === 'vectorSearch') {
      goServerRequest = {
        query: req.body.params.query,
        repository: req.body.params.repository,
        branch: req.body.params.branch || 'main'
      };
      endpoint = '/search';
    } else if (req.body.tool === 'vectorSearchWithSummary') {
      goServerRequest = {
        query: req.body.params.query,
        repository: req.body.params.repository,
        branch: req.body.params.branch || 'main'
      };
      endpoint = '/search/summary';
    } else if (req.body.tool === 'indexRepository') {
      goServerRequest = {
        repo_url: req.body.params.repoUrl,
        branch: req.body.params.branch || 'main'
      };
      endpoint = '/index';
    } else if (req.body.tool === 'repositories') {
      goServerRequest = null;
      endpoint = '/repositories';
    } else if (req.body.tool === 'profile') {
      goServerRequest = null;
      endpoint = '/profile';
    } else {
      goServerRequest = {
        query: req.body.query,
        repository: req.body.repository,
        branch: req.body.branch || 'main'
      };
      endpoint = '/search';
    }
    console.log('Sending request to Go server:', goServerRequest);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: goServerRequest ? JSON.stringify(goServerRequest) : undefined
    };
    let response;
    if (endpoint === '/repositories' || endpoint === '/profile') {
      response = await fetch(`${serverConfig.GO_SERVER_URL}${endpoint}`, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    } else {
      response = await fetch(`${serverConfig.GO_SERVER_URL}${endpoint}`, fetchOptions);
    }
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