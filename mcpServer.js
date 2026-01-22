#!/usr/bin/env node

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { discoverTools } from "./lib/tools.js";
import { reauthenticate, logout, completeManualAuth, startManualAuth } from "./lib/webex-config.js";
import { randomUUID } from "crypto";
import { z } from "zod";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

const SERVER_NAME = "webex-messaging-mcp-server";

/**
 * Create a prompt response with a text message
 * @param {string} text - The message text
 * @returns {Object} The prompt response object
 */
function promptResponse(text) {
  return {
    messages: [{
      role: 'user',
      content: { type: 'text', text }
    }]
  };
}

/**
 * Convert JSON Schema properties to Zod schema format
 * Required by MCP SDK v1.17.4 for proper parameter validation
 */
function convertJsonSchemaToZod(properties, required = []) {
  if (!properties || typeof properties !== 'object') {
    return {};
  }

  const zodSchema = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType;

    if (prop.type === 'string') {
      zodType = z.string();
    } else if (prop.type === 'number') {
      zodType = z.number();
    } else if (prop.type === 'integer') {
      zodType = z.number().int();
    } else if (prop.type === 'boolean') {
      zodType = z.boolean();
    } else if (prop.type === 'array') {
      zodType = z.array(z.any());
    } else if (prop.type === 'object') {
      zodType = z.object({});
    } else {
      // Default to string for unknown types
      zodType = z.string();
    }

    // Make optional if not in required array
    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    zodSchema[key] = zodType;
  }

  return zodSchema;
}

/**
 * Register authentication prompts as MCP prompts
 * These are accessible via /webex:<prompt-name> commands (e.g., /webex:authenticate)
 */
function registerAuthPrompts(server) {
  // Authenticate prompt - handles different auth methods
  server.registerPrompt(
    'authenticate',
    {
      title: 'Login to Webex',
      description: 'Authenticate with Webex. For personal token: opens browser to copy token. For OAuth: starts OAuth flow.',
      argsSchema: {}
    },
    async () => {
      const hasStaticToken = !!process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY;
      const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';
      const hasOAuth = !!process.env.WEBEX_OAUTH_CLIENT_ID && !!process.env.WEBEX_OAUTH_CLIENT_SECRET;

      if (hasStaticToken) {
        return promptResponse('✓ Using static token from WEBEX_PUBLIC_WORKSPACE_API_KEY. No authentication needed.');
      }

      if (hasAutoRefresh) {
        console.error('[Auth Prompt] Starting manual authentication for personal token...');
        const result = await startManualAuth();
        if (result.success) {
          return promptResponse(`Browser opened!\n\n${result.instructions}\n\nOnce you've copied the token, run: /webex:save-token`);
        }
        return promptResponse(`✗ ${result.message}`);
      }

      if (hasOAuth) {
        console.error('[Auth Prompt] Starting OAuth authentication...');
        const result = await reauthenticate(true);
        return promptResponse(result.success
          ? `✓ ${result.message}. You can now use Webex tools.`
          : `✗ ${result.message}`);
      }

      return promptResponse(
        '✗ No authentication method configured. Set one of:\n' +
        '- WEBEX_PUBLIC_WORKSPACE_API_KEY (static token)\n' +
        '- WEBEX_AUTO_REFRESH_TOKEN=true (personal token, macOS)\n' +
        '- WEBEX_OAUTH_CLIENT_ID + WEBEX_OAUTH_CLIENT_SECRET (OAuth)'
      );
    }
  );

  // Save token prompt - only for personal token flow
  server.registerPrompt(
    'save-token',
    {
      title: 'Save token from clipboard',
      description: 'After copying your Webex personal token, run this to save it.',
      argsSchema: {}
    },
    async () => {
      const hasAutoRefresh = process.env.WEBEX_AUTO_REFRESH_TOKEN === 'true';
      if (!hasAutoRefresh) {
        return promptResponse('✗ This command is only for personal token authentication (WEBEX_AUTO_REFRESH_TOKEN=true).');
      }

      console.error('[Auth Prompt] Completing manual authentication...');
      const result = await completeManualAuth();
      return promptResponse(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
    }
  );

  // Logout prompt - clear stored tokens
  server.registerPrompt(
    'logout',
    {
      title: 'Clear authentication',
      description: 'Clear stored Webex OAuth tokens and logout.',
      argsSchema: {}
    },
    async () => {
      console.error('[Auth Prompt] Logging out...');
      const result = await logout();
      return promptResponse(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
    }
  );

  console.error('[MCP Server] Registered authentication prompts');
}

/**
 * Create and configure MCP server with tools
 * Following MCP 2025-06-18 protocol patterns
 */
async function createMcpServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.1.0",
  }, {
    capabilities: {
      tools: {},
      prompts: {},
    },
  });

  server.onerror = (error) => console.error("[MCP Server Error]", error);

  // Register authentication prompts (accessible via /webex:<prompt-name>)
  registerAuthPrompts(server);

  // Discover and register all tools
  const tools = await discoverTools();
  console.error(`[MCP Server] Registering ${tools.length} tools`);

  // Register each tool individually (NO inputSchema in registerTool call)
  for (const tool of tools) {
    const definition = tool.definition?.function;
    if (!definition) {
      console.error(`[MCP Server] Skipping tool with invalid definition:`, tool);
      continue;
    }

    try {
      server.registerTool(
        definition.name,
        {
          title: definition.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          description: definition.description,
          // MCP SDK v1.17.4 requires inputSchema with Zod schemas for parameter validation
          inputSchema: convertJsonSchemaToZod(definition.parameters?.properties || {}, definition.parameters?.required || [])
        },
        async (args) => {
          try {
            // Debug logging to see what we actually receive
            console.error(`[DEBUG] Tool ${definition.name} called with args:`, JSON.stringify(args));
            console.error(`[DEBUG] Args type:`, typeof args);
            console.error(`[DEBUG] Args keys:`, Object.keys(args || {}));

            // Handle both function and handler patterns
            const toolFunction = tool.function || tool.handler;
            if (!toolFunction) {
              throw new Error(`Tool ${definition.name} has no function or handler`);
            }

            const result = await toolFunction(args);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
              }]
            };
          } catch (error) {
            console.error(`[MCP Server] Tool ${definition.name} error:`, error);
            return {
              content: [{
                type: 'text',
                text: `Error: ${error.message}`
              }],
              isError: true
            };
          }
        }
      );
    } catch (error) {
      console.error(`[MCP Server] Failed to register tool ${definition.name}:`, error);
    }
  }

  return server;
}

async function run() {
  // Authentication is deferred - user must run /webex:authenticate when ready
  console.error('[MCP Server] Authentication deferred. Use /webex:authenticate to login when ready.');

  // Transport mode detection following MCP 2025-06-18 patterns
  const args = process.argv.slice(2);
  const modeFromEnv = (process.env.TRANSPORT || process.env.MCP_MODE || process.env.MODE)?.toLowerCase();
  const isHTTP = args.includes('--http') || modeFromEnv === 'http';
  const isSSE = args.includes('--sse') || modeFromEnv === 'sse';

  const mode = isHTTP ? 'HTTP' : 'STDIO';
  console.error(`[MCP Server] Mode: ${mode}`);

  // Deprecation warning for SSE
  if (isSSE) {
    console.error('WARNING: SSE mode is deprecated in MCP 2025-06-18. Use StreamableHTTP instead.');
    console.error('Use --http flag or MCP_MODE=http for HTTP mode.');
  }

  if (isHTTP) {
    // HTTP mode with StreamableHTTP transport
    const app = express();
    app.use(express.json());

    // Enable CORS for all origins and expose MCP session header
    app.use(cors({
      origin: '*',
      exposedHeaders: ['mcp-session-id']
    }));

    // Map to store transports by session ID
    const transports = {};

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        mode: 'HTTP',
        protocol: 'MCP 2025-06-18',
        server: SERVER_NAME,
        version: '0.1.0'
      });
    });

    // MCP POST endpoint following official patterns
    app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];

      try {
        let transport;

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
              transports[sessionId] = transport;
              console.error(`[HTTP] New session initialized: ${sessionId}`);
            },
            onsessionclosed: (sessionId) => {
              delete transports[sessionId];
              console.error(`[HTTP] Session closed: ${sessionId}`);
            }
          });

          // Clean up transport when closed
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId];
            }
          };

          // Create and connect the server
          const server = await createMcpServer();
          await server.connect(transport);
        } else {
          // Invalid request
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null
          });
          return;
        }

        // Handle the request
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('[HTTP] Request handling error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          });
        }
      }
    });

    // Handle GET requests for SSE streams
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    });

    // Handle DELETE requests for session termination
    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'];
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    });

    const port = process.env.PORT || 3001;
    app.listen(port, () => {
      console.error(`[HTTP Server] running on port ${port}`);
      console.error(`[HTTP Server] Health check: http://localhost:${port}/health`);
      console.error(`[HTTP Server] MCP endpoint: http://localhost:${port}/mcp`);
    });
  } else {
    // STDIO mode: single server instance
    console.error('[MCP Server] Starting in STDIO mode');
    const server = await createMcpServer();

    process.on("SIGINT", async () => {
      console.error('[MCP Server] Shutting down...');
      await server.close();
      process.exit(0);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[MCP Server] Connected via STDIO transport');
  }
}

run().catch(console.error);
