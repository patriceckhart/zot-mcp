#!/usr/bin/env bun

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (request.id === undefined) return;
  let result: unknown;
  if (request.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  } else if (request.method === "tools/list") {
    result = {
      tools: [{
        name: "echo",
        description: "Echo a text value",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }],
    };
  } else if (request.method === "tools/call") {
    result = { content: [{ type: "text", text: String(request.params?.arguments?.text ?? "") }] };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
