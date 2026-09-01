#!/usr/bin/env node

import { createInterface } from "node:readline";
import { stderr, stdin, stdout } from "node:process";
import { McpAdapter, loadConfig, type JsonObject, type ProxyResult } from "./src/adapter.ts";

const NAME = "zot-mcp";
const VERSION = "1.1.0";

function send(frame: JsonObject): void {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function log(message: string): void {
  stderr.write(`[${NAME}] ${message}\n`);
}

function notify(level: string, message: string): void {
  send({ type: "notify", level, message });
}

function sendToolResult(id: unknown, result: ProxyResult): void {
  send({
    type: "tool_result",
    id,
    content: result.content,
    ...(result.isError ? { is_error: true } : {}),
  });
}

function resultText(result: ProxyResult): string {
  return result.content.map((block) => block.type === "text" ? block.text : `[${block.mime_type} image]`).join("\n");
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
      const dataDir = typeof frame.data_dir === "string" && frame.data_dir
        ? frame.data_dir
        : typeof frame.extension_dir === "string" && frame.extension_dir
          ? frame.extension_dir
          : process.cwd();
      try {
        adapter = new McpAdapter(await loadConfig(cwd), cwd, dataDir, log, notify);
      } catch (cause) {
        log(cause instanceof Error ? cause.message : String(cause));
        adapter = new McpAdapter({}, cwd, dataDir, log, notify);
      }
      send({ type: "register_command", name: "mcp", description: "inspect and manage MCP servers" });
      send({
        type: "register_tool",
        name: "mcp",
        description: "Use configured MCP servers. Search and describe tools before calling them. Also accesses resources, prompts, completion, subscriptions, logging, health checks, and OAuth.",
        schema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "status", "connect", "disconnect", "reconnect", "search", "describe", "call",
                "resources/list", "resources/read", "resources/subscribe", "resources/unsubscribe",
                "prompts/list", "prompts/get", "complete", "logging/set", "ping", "auth-start", "auth-complete",
              ],
            },
            server: { type: "string", description: "Configured server name" },
            query: { type: "string", description: "Capability keywords for search" },
            tool: { type: "string", description: "Server-qualified tool path" },
            args: { type: "object", additionalProperties: true, description: "Tool or prompt arguments" },
            uri: { type: "string", description: "Resource URI" },
            prompt: { type: "string", description: "Prompt name" },
            ref: { type: "object", additionalProperties: true, description: "Prompt or resource reference for completion" },
            argument: { type: "object", additionalProperties: true, description: "Completion argument" },
            level: { type: "string", enum: ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] },
            code: { type: "string", description: "OAuth authorization code" },
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
        sendToolResult(frame.id, { content: [{ type: "text", text: "MCP adapter is not initialized" }], isError: true });
        return;
      }
      const args = frame.args && typeof frame.args === "object" && !Array.isArray(frame.args)
        ? frame.args as JsonObject
        : {};
      sendToolResult(frame.id, await adapter.execute(args));
      return;
    }

    if (frame.type === "command_invoked" && frame.name === "mcp") {
      if (!adapter) {
        send({ type: "command_response", id: frame.id, action: "noop", error: "MCP adapter is not initialized" });
        return;
      }
      const parts = typeof frame.args === "string" ? frame.args.trim().split(/\s+/).filter(Boolean) : [];
      let request: JsonObject = { action: "status" };
      if (parts[0] === "start" || parts[0] === "connect") request = { action: "connect", server: parts[1] };
      else if (parts[0] === "stop" || parts[0] === "disconnect") request = { action: "disconnect", server: parts[1] };
      else if (parts[0] === "restart" || parts[0] === "reconnect") request = { action: "reconnect", server: parts[1] };
      else if (parts[0] === "auth") request = { action: "auth-start", server: parts[1] };
      else if (parts.length > 0 && parts[0] !== "status") {
        send({ type: "command_response", id: frame.id, action: "display", display: "Usage: /mcp [status|start <server>|stop <server>|restart <server>|auth <server>]" });
        return;
      }
      const result = await adapter.execute(request);
      send({
        type: "command_response",
        id: frame.id,
        action: "display",
        display: resultText(result),
        ...(result.isError ? { error: resultText(result) } : {}),
      });
      return;
    }

    if (frame.type === "shutdown") {
      await adapter?.close();
      send({ type: "shutdown_ack" });
      lines.close();
    }
  }).catch((cause) => log(cause instanceof Error ? cause.stack ?? cause.message : String(cause)));
});
