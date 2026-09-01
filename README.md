# zot-mcp

A context-efficient MCP client extension for zot, implemented in TypeScript with the official MCP SDK. It exposes one `mcp` proxy tool instead of adding every remote tool schema to the model context.

The repository includes a self-contained `dist/zot-mcp.js`. Installing from GitHub does not run npm and does not require `node_modules` at runtime.

## Requirements

- zot 0.3.54 or newer
- Node.js 22.18 or newer on `PATH`
- npm only for development

## Install

```sh
zot ext install https://github.com/patriceckhart/zot-mcp
```

Restart zot after installation. The committed bundle is executed directly.

For local development:

```sh
npm install
npm run check
npm test
npm run build
zot --ext .
```

## Features

- Official `@modelcontextprotocol/sdk` client implementation
- Lazy connections to any number of MCP servers
- stdio, Streamable HTTP, and legacy HTTP+SSE transports
- Tool search, schema inspection, calls, annotations, structured output, images, and progress
- Resource listing, templates, reads, subscriptions, and update notifications
- Prompt listing, retrieval, argument completion, and embedded content
- OAuth 2.1 discovery, dynamic client registration, PKCE, refresh tokens, and manual callback completion
- Project roots using zot's active working directory
- MCP logging, ping, timeouts, pagination, and catalog list-change notifications
- Explicit connect, disconnect, and reconnect lifecycle controls
- Standard shared, zot-global, and project-local configuration files
- One committed executable bundle, with no runtime dependency installation

## Configuration

Server definitions are merged in this order. Later files override servers with the same name:

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`
3. `~/.agents/mcp/mcp.json`
4. `$ZOT_HOME/mcp.json`
5. `.mcp.json`
6. `.zot/mcp.json`

### stdio

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {
        "API_TOKEN": "${FILESYSTEM_TOKEN}"
      },
      "cwd": ".",
      "connectTimeoutMs": 30000,
      "requestTimeoutMs": 60000
    }
  }
}
```

### Streamable HTTP

```json
{
  "mcpServers": {
    "docs": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

A server with `url` and no explicit `transport` uses Streamable HTTP.

### Legacy SSE

```json
{
  "mcpServers": {
    "legacy": {
      "transport": "sse",
      "url": "https://example.com/sse",
      "headers": {
        "X-API-Key": "${MCP_API_KEY}"
      }
    }
  }
}
```

### OAuth

```json
{
  "mcpServers": {
    "protected": {
      "transport": "streamable-http",
      "url": "https://example.com/mcp",
      "oauth": {
        "redirectUri": "http://127.0.0.1:33418/callback",
        "scope": "read write"
      }
    }
  }
}
```

Set `oauth` to `true` to use the default public-client metadata. Optional `clientId` and `clientSecret` fields support pre-registered clients.

Start authorization with `/mcp auth protected` or the `auth-start` action. The browser opens automatically. Copy the returned authorization `code` and pass it through `auth-complete`. OAuth state is stored with mode `0600` under the extension data directory.

### Environment interpolation

`${NAME}` and `$env:NAME` are supported in commands, arguments, environment values, paths, URLs, headers, and OAuth fields. Missing variables fail closed. Set `disabled: true` to keep a server configured without allowing connections.

Both millisecond timeouts and the compatibility second-based names are accepted:

- `connectTimeoutMs`, `requestTimeoutMs`
- `connectTimeout`, `requestTimeout`

## Proxy tool

The model receives one `mcp` tool with these actions:

| Action | Required fields | Purpose |
|---|---|---|
| `status` | none | Show server state, capabilities, and catalog counts without connecting |
| `connect` | `server` | Connect and discover server capabilities |
| `disconnect` | `server` | Close a server session |
| `reconnect` | `server` | Replace a server session and refresh catalogs |
| `search` | `query` | Search tool names and descriptions across servers |
| `describe` | `tool` | Return a tool schema, annotations, and metadata |
| `call` | `tool`, optional `args` | Invoke a tool and preserve text, image, structured, error, and progress output |
| `resources/list` | optional `server` | List resources and resource templates |
| `resources/read` | `server`, `uri` | Read text, image, or binary resource content |
| `resources/subscribe` | `server`, `uri` | Subscribe to resource changes |
| `resources/unsubscribe` | `server`, `uri` | Remove a resource subscription |
| `prompts/list` | optional `server` | List prompt templates |
| `prompts/get` | `server`, `prompt`, optional `args` | Retrieve rendered prompt messages |
| `complete` | `server`, `ref`, `argument` | Request prompt or resource argument completion |
| `logging/set` | `server`, `level` | Set the server logging threshold |
| `ping` | `server` | Check protocol liveness |
| `auth-start` | `server` | Begin OAuth and return the authorization details |
| `auth-complete` | `server`, `code` | Exchange an OAuth authorization code and reconnect |

Tool paths use `<server>__<tool>`, for example `filesystem__read_file`.

## Slash command

```text
/mcp status
/mcp start <server>
/mcp stop <server>
/mcp restart <server>
/mcp auth <server>
```

## Host capability boundary

The extension does not advertise MCP sampling or elicitation because zot extension protocol v1 has no correlated host API for nested model requests or user-input dialogs. Zot also does not send cancellation frames when it abandons an extension tool call. The official SDK still enforces request timeouts, sends protocol cancellation for locally aborted or timed-out MCP requests, and handles transport shutdown correctly.

Roots, tools, resources, prompts, OAuth, progress, logging, and list-change notifications are fully handled within the extension.

## Security

MCP servers and this extension run with the user's filesystem and network permissions. Review every configured command and endpoint. Header values, environment values, OAuth tokens, authorization codes, and tool output can be sensitive. OAuth state is permission-restricted but is not an operating-system credential-store entry.

## Distribution

`npm run build` bundles the TypeScript entry point, the official SDK, and required runtime packages into `dist/zot-mcp.js`. The bundle is committed and marked executable. `extension.json` points only to that file, so a GitHub installation does not need npm or `node_modules` after cloning.
