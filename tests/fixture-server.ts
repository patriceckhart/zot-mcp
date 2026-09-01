#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1.0.0" }, {
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
    completions: {},
    logging: {},
  },
  instructions: "Fixture server instructions",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo a text value",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    {
      name: "roots",
      description: "Return roots supplied by the client",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const token = request.params._meta?.progressToken;
  if (token !== undefined) {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: 1, total: 1, message: "complete" },
    });
  }
  if (request.params.name === "roots") {
    return { content: [{ type: "text", text: JSON.stringify(await server.listRoots()) }] };
  }
  return { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "fixture://document", name: "Fixture document", description: "A test resource", mimeType: "text/plain" }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [{ uriTemplate: "fixture://documents/{name}", name: "Fixture documents", mimeType: "text/plain" }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "fixture resource content" }],
}));
server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "greet", description: "Create a greeting", arguments: [{ name: "name", required: true }] }],
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  description: "Greeting prompt",
  messages: [{ role: "user", content: { type: "text", text: `Hello ${request.params.arguments?.name ?? "world"}` } }],
}));
server.setRequestHandler(CompleteRequestSchema, async (request) => ({
  completion: { values: [`${request.params.argument.value}-completed`], total: 1, hasMore: false },
}));

await server.connect(new StdioServerTransport());
