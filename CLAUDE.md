# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that provides AI assistants with access to Cisco Webex messaging capabilities through 52 Webex API tools. It's a fork of the official webex/webex-messaging-mcp-server with added OAuth authentication support and in-app authentication management via MCP prompts.

## Build & Run Commands

```bash
# Install dependencies
npm install

# Run tests (120 tests)
npm test

# Start server (STDIO mode - for Claude Desktop/Code)
node mcpServer.js

# Start server (HTTP mode)
npm run start:http

# List available tools
node index.js tools

# Validate (lint + tests)
npm run validate
```

## Authentication

Three authentication methods are supported (configured in `.env`):

1. **Static API Token** (original method):
   ```
   WEBEX_PUBLIC_WORKSPACE_API_KEY=your-token
   ```

2. **Auto-Refresh Personal Token** (macOS only - messages appear as from you):
   ```
   WEBEX_AUTO_REFRESH_TOKEN=true
   ```
   Requires Chrome and being logged into developer.webex.com. Tokens are stored in macOS Keychain and auto-refresh 30 minutes before expiry.

3. **OAuth** (recommended for integrations):
   ```
   WEBEX_OAUTH_CLIENT_ID=your-client-id
   WEBEX_OAUTH_CLIENT_SECRET=your-client-secret
   ```

Priority: Static Token > Auto-Refresh > OAuth. OAuth tokens are stored at `~/.webex-mcp/tokens.json`.

### Authentication Management

Authentication commands are available via the `/webex:` prefix:

- `/webex:authenticate` - Authenticate with Webex (OAuth or browser automation depending on config)
- `/webex:save-token` - (Personal token mode only) Save the token after copying it from the browser
- `/webex:logout` - Clear stored tokens and logout

The server starts without requiring authentication. Use `/webex:authenticate` when ready.

## Architecture

### Key Files

- `mcpServer.js` - Main MCP server, supports STDIO and HTTP transports, registers auth prompts
- `lib/webex-config.js` - Centralized authentication and API configuration
- `lib/oauth/` - OAuth 2.0 implementation with PKCE and auto-refresh
- `lib/keychain/` - macOS Keychain integration and browser automation for auto-refresh tokens
- `lib/tools.js` - Dynamic tool discovery and loading
- `tools/paths.js` - Registry of all 52 tool paths

### Tool Pattern

All tools follow this structure in `tools/webex-public-workspace/webex-messaging/`:

```javascript
import { getWebexUrl, getWebexHeaders } from '../../../lib/webex-config.js';

const executeFunction = async (params) => {
  const response = await fetch(getWebexUrl('/endpoint'), {
    headers: getWebexHeaders(),
    method: 'GET'
  });
  return response.json();
};

const apiTool = {
  function: executeFunction,
  definition: {
    type: 'function',
    function: {
      name: 'tool_name',
      description: '...',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
};

export { apiTool };
```

### Authentication Flow

1. `mcpServer.js` starts without requiring authentication (lazy auth)
2. User runs `/webex:authenticate` when ready
3. `initializeAuth()` checks for static token first, then auto-refresh, then OAuth
4. **OAuth flow**: Opens browser, stores tokens to `~/.webex-mcp/tokens.json`, auto-refreshes 5 min before expiry
5. **Personal token flow**: Opens browser to developer.webex.com, user copies token manually, runs `/webex:save-token`, token stored in macOS Keychain
6. All tools use `getWebexHeaders()` which returns cached token
7. User can run `/webex:authenticate` again or `/webex:logout` as needed

## Testing

Tests require auth initialization. Pattern used in test files:

```javascript
import { initializeAuth } from '../lib/webex-config.js';

beforeEach(async () => {
  process.env.WEBEX_PUBLIC_WORKSPACE_API_KEY = 'test-token';
  await initializeAuth();
});
```

## Adding New Tools

1. Create file in `tools/webex-public-workspace/webex-messaging/`
2. Follow the tool pattern above using `getWebexUrl()` and `getWebexHeaders()`
3. Add path to `tools/paths.js`
4. Run `npm test` to verify

## Claude Code Plugin

This repo includes a Claude Code plugin that bundles:
- **MCP Server**: 52 Webex API tools
- **Skills**: Webex resource resolution guidance (link parsing, ID conversion, etc.)

### Plugin Structure

```
.claude-plugin/
├── marketplace.json          # Plugin catalog
└── webex/
    ├── plugin.json           # Plugin config with MCP server
    └── skills/
        └── webex/
            └── SKILL.md      # Resource resolution guidance
```

### Installing the Plugin

**From GitHub (recommended):**
```bash
/plugin marketplace add msprunck/webex-messaging-mcp-server
/plugin install webex@msprunck-webex-messaging-mcp-server
```

**From local path (development):**
```bash
/plugin marketplace add /path/to/webex-messaging-mcp-server
/plugin install webex@webex-messaging-mcp-server
```

### Plugin Authentication

Configure authentication in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "webex": {
      "env": {
        "WEBEX_AUTO_REFRESH_TOKEN": "true"
      }
    }
  }
}
```

Options:
- `WEBEX_AUTO_REFRESH_TOKEN=true` - macOS browser automation (recommended)
- `WEBEX_OAUTH_CLIENT_ID` + `WEBEX_OAUTH_CLIENT_SECRET` - OAuth flow
- `WEBEX_PUBLIC_WORKSPACE_API_KEY` - Static token (expires every 12h)

Then use `/webex:authenticate` to trigger authentication.

### What the Skill Provides

The bundled skill teaches Claude how to:
- Parse Webex space links (`webexteams://im?space=<uuid>`)
- Convert UUIDs to base64-encoded API IDs
- Find people by name or email
- Resolve rooms and direct messages
- Common workflows without trial and error
