#!/usr/bin/env bun

import { createInterface } from "node:readline";
import { stderr, stdin, stdout } from "node:process";
import { McpAdapter, loadConfig, type JsonObject } from "./src/adapter.ts";

const NAME = "zot-mcp";
const VERSION = "1.0.0";

function send(frame: JsonObject): void {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function log(message: string): void {
  stderr.write(`[${NAME}] ${message}\n`);
}

function textResult(id: unknown, value: unknown, isError = false): void {
  send({
    type: "tool_result",
    id,
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { is_error: true } : {}),
  });
}

function formatStatus(status: unknown): string {
  const servers = (status as { servers?: Array<{ name: string; status: string; toolCount: number; error?: string }> }).servers ?? [];
  if (servers.length === 0) return "MCP: no servers configured. Add an mcpServers object to .mcp.json.";
  return servers.map((server) => {
    const count = server.toolCount === 1 ? "1 tool" : `${server.toolCount} tools`;
    return `${server.name}: ${server.status} (${count})${server.error ? `: ${server.error}` : ""}`;
  }).join("\n");
}

send({ type: "hello", name: NAME, version: VERSION, capabilities: ["commands", "tools"] });

const lines = createInterface({ input: stdin, crlfDelay: Infinity });
let adapter: McpAdapter | undefined;
let chain = Promise.resolve();

lines.on("line", (line) => {
  chain = chain.then(async () => {
    let frame: JsonObject;
    try {
      frame = JSON.parse(line) as JsonObject;
    } catch {
      log("ignored invalid JSON frame from zot");
      return;
    }

    if (frame.type === "hello_ack") {
      const cwd = typeof frame.cwd === "string" && frame.cwd ? frame.cwd : process.cwd();
      try {
        adapter = new McpAdapter(await loadConfig(cwd), cwd, log);
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
        adapter = new McpAdapter({}, cwd, log);
      }
      send({ type: "register_command", name: "mcp", description: "show configured MCP server status" });
      send({
        type: "register_tool",
        name: "mcp",
        description: "Discover and call tools from configured MCP servers. Search first, describe the selected tool, then call it.",
        schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["status", "search", "describe", "call", "connect"], default: "status" },
            query: { type: "string", description: "Keywords for action=search" },
            server: { type: "string", description: "Server name for action=connect" },
            tool: { type: "string", description: "Qualified tool path for action=describe or action=call" },
            args: { type: "object", description: "Tool arguments for action=call", additionalProperties: true },
          },
          required: ["action"],
          additionalProperties: false,
        },
      });
      send({ type: "ready" });
      return;
    }

    if (frame.type === "tool_call" && frame.name === "mcp") {
      if (!adapter) {
        textResult(frame.id, "MCP adapter is not initialized", true);
        return;
      }
      try {
        const args = frame.args && typeof frame.args === "object" && !Array.isArray(frame.args)
          ? frame.args as JsonObject
          : {};
        textResult(frame.id, await adapter.execute(args));
      } catch (error) {
        textResult(frame.id, error instanceof Error ? error.message : String(error), true);
      }
      return;
    }

    if (frame.type === "command_invoked" && frame.name === "mcp") {
      if (!adapter) {
        send({ type: "command_response", id: frame.id, action: "noop", error: "MCP adapter is not initialized" });
        return;
      }
      const args = typeof frame.args === "string" ? frame.args.trim() : "";
      if (args && args !== "status") {
        send({ type: "command_response", id: frame.id, action: "display", display: "Usage: /mcp [status]" });
        return;
      }
      send({ type: "command_response", id: frame.id, action: "display", display: formatStatus(await adapter.status()) });
      return;
    }

    if (frame.type === "shutdown") {
      await adapter?.close();
      send({ type: "shutdown_ack" });
      lines.close();
    }
  }).catch((error) => log(error instanceof Error ? error.stack ?? error.message : String(error)));
});
