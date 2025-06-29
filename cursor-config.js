import fs from 'fs';
import path from 'path';
import os from 'os';
import 'dotenv/config';

// Get the current directory
const currentDir = process.cwd();

// Cursor MCP config location
const cursorConfigPath = path.join(os.homedir(), '.cursor', 'mcp.json');

// Create the MCP configuration object for this server
const mcpConfig = {
  "agentchatmcp": {
    "command": "node",
    "args": ["integration.js"],
    "cwd": currentDir,
    "env": {
      "GO_SERVER_URL": process.env.GO_SERVER_URL || "http://localhost:8081",
      "MCP_SECRET_TOKEN": process.env.MCP_SECRET_TOKEN || ""
    }
  }
};

console.log("\n===== Cursor MCP Configuration =====");
console.log("\nAdd the following to your Cursor MCP configuration file:");
console.log(JSON.stringify(mcpConfig, null, 2));
console.log(`\nConfiguration file location: ${cursorConfigPath}`);

console.log("\n===== Manual Configuration Steps =====");
console.log("1. Open Cursor MCP configuration:");
console.log(`   code ${cursorConfigPath}`);
console.log("2. Add the above JSON configuration to your existing configuration");
console.log("3. Save the file and restart Cursor");
console.log("4. Start the MCP server with: npm run integration");
console.log("\n=====================================") 