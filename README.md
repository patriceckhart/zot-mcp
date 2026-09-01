# zot-mcp

A dependency-free TypeScript zot extension that exposes configured MCP servers through one proxy tool. It is executed directly by Node.js, so there is no build step and no local `node_modules` directory.

## Requirements

- zot 0.3.54 or newer
- Node.js 22.18 or newer on `PATH`
- npm

## Install

Install directly from GitHub:

```sh
zot ext install https://github.com/patriceckhart/zot-mcp
```

Restart zot after installation.

For local development, run the extension directly from a checkout:

```sh
chmod +x zot-mcp.ts
zot --ext .
```

## Configure servers

Create `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

The extension merges `~/.config/mcp/mcp.json` first and project-local `.mcp.json` second. Project entries override global entries with the same name.

Supported server fields:

- stdio: `command`, `args`, `env`, `cwd`
- Streamable HTTP: `url`, `headers`
- common: `disabled`, `requestTimeoutMs`

`${NAME}` and `$env:NAME` environment interpolation is supported in commands, arguments, environment values, paths, URLs, and headers. Missing variables fail closed.

## Use

The model gets one `mcp` tool with five actions:

1. `search`: connect lazily and find tools by keywords
2. `describe`: inspect a tool's input schema
3. `call`: invoke a server-qualified tool path
4. `status`: list server states without connecting
5. `connect`: connect one server explicitly

Run `/mcp` to display server status without starting a model turn.

## Limitations

This initial version supports MCP tools over stdio and Streamable HTTP. It does not yet expose resources, prompts, OAuth, legacy HTTP/SSE-only servers, server-initiated sampling, elicitation, or tool-list change notifications. Server processes inherit the user's permissions. Review every configured command and endpoint before use.

## Test

```sh
npm test
```
