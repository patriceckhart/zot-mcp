import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { McpAdapter, normalizeToolPath, type ProxyResult } from "../src/adapter.ts";

const adapters: McpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function fixtureAdapter(): McpAdapter {
  const root = join(import.meta.dirname, "..");
  const adapter = new McpAdapter({
    fixture: {
      command: process.execPath,
      args: [join(import.meta.dirname, "fixture-server.ts")],
    },
    disabled: {
      command: "never-started",
      disabled: true,
    },
  }, root, join(root, ".test-data"));
  adapters.push(adapter);
  return adapter;
}

function jsonResult(result: ProxyResult): unknown {
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("McpAdapter", () => {
  test("reports status without starting lazy servers", async () => {
    assert.deepEqual(await fixtureAdapter().status(), {
      servers: [
        { name: "fixture", status: "not-connected", tools: 0, resources: 0, prompts: 0, capabilities: {} },
        { name: "disabled", status: "disabled", tools: 0, resources: 0, prompts: 0, capabilities: {} },
      ],
    });
  });

  test("searches, describes, and calls stdio tools through the official SDK", async () => {
    const adapter = fixtureAdapter();
    assert.deepEqual(await adapter.search("echo text"), {
      query: "echo text",
      tools: [{ server: "fixture", path: "fixture__echo", name: "echo", description: "Echo a text value" }],
    });

    assert.deepEqual(jsonResult(await adapter.execute({ action: "describe", tool: "fixture__echo" })), {
      server: "fixture",
      path: "fixture__echo",
      name: "echo",
      description: "Echo a text value",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      annotations: { readOnlyHint: true, idempotentHint: true },
    });

    const called = await adapter.execute({ action: "call", tool: "fixture__echo", args: { text: "hello" } });
    assert.equal(called.isError, false);
    assert.equal(called.content[0].type, "text");
    assert.equal((called.content[0] as { type: "text"; text: string }).text, "hello");
    assert.match((called.content[1] as { type: "text"; text: string }).text, /Progress events/);
  });

  test("supports resources, prompts, completion, roots, and subscriptions", async () => {
    const adapter = fixtureAdapter();

    const resources = jsonResult(await adapter.execute({ action: "resources/list", server: "fixture" })) as {
      resources: Array<{ uri: string }>;
      templates: Array<{ uriTemplate: string }>;
    };
    assert.equal(resources.resources[0].uri, "fixture://document");
    assert.equal(resources.templates[0].uriTemplate, "fixture://documents/{name}");

    const read = await adapter.execute({ action: "resources/read", server: "fixture", uri: "fixture://document" });
    assert.match((read.content[0] as { type: "text"; text: string }).text, /fixture resource content/);
    assert.equal((await adapter.execute({ action: "resources/subscribe", server: "fixture", uri: "fixture://document" })).isError, undefined);
    assert.equal((await adapter.execute({ action: "resources/unsubscribe", server: "fixture", uri: "fixture://document" })).isError, undefined);

    const prompts = jsonResult(await adapter.execute({ action: "prompts/list", server: "fixture" })) as { prompts: Array<{ name: string }> };
    assert.equal(prompts.prompts[0].name, "greet");
    const prompt = jsonResult(await adapter.execute({ action: "prompts/get", server: "fixture", prompt: "greet", args: { name: "Zot" } })) as { messages: Array<{ content: { text: string } }> };
    assert.equal(prompt.messages[0].content.text, "Hello Zot");

    const completion = jsonResult(await adapter.execute({
      action: "complete",
      server: "fixture",
      ref: { type: "ref/prompt", name: "greet" },
      argument: { name: "name", value: "Zo" },
    })) as { completion: { values: string[] } };
    assert.deepEqual(completion.completion.values, ["Zo-completed"]);

    const roots = await adapter.execute({ action: "call", tool: "fixture__roots", args: {} });
    assert.match((roots.content[0] as { type: "text"; text: string }).text, /file:/);
    assert.equal((await adapter.execute({ action: "logging/set", server: "fixture", level: "info" })).isError, undefined);
    assert.equal((await adapter.execute({ action: "ping", server: "fixture" })).isError, undefined);
  });

  test("connects through Streamable HTTP", async (context) => {
    const httpServer = createServer(async (request, response) => {
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      let source = "";
      for await (const chunk of request) source += chunk;
      const message = JSON.parse(source) as { id?: number; method: string };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [{ name: "remote", description: "Remote HTTP tool", inputSchema: { type: "object", properties: {} } }] }
          : { content: [{ type: "text", text: "remote result" }] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    context.after(() => httpServer.close());
    const address = httpServer.address();
    assert(address && typeof address === "object");

    const adapter = new McpAdapter({ remote: { url: `http://127.0.0.1:${address.port}/mcp` } }, process.cwd(), ".test-data");
    adapters.push(adapter);
    assert.deepEqual(await adapter.search("remote"), {
      query: "remote",
      tools: [{ server: "remote", path: "remote__remote", name: "remote", description: "Remote HTTP tool" }],
    });
    assert.equal((await adapter.execute({ action: "call", tool: "remote__remote", args: {} })).content[0].type, "text");
  });

  test("returns proxy errors for invalid actions", async () => {
    const result = await fixtureAdapter().execute({ action: "call" });
    assert.equal(result.isError, true);
    assert.match((result.content[0] as { type: "text"; text: string }).text, /tool is required/);
  });
});

test("normalizes server-qualified tool paths", () => {
  assert.equal(normalizeToolPath("my server", "read.file"), "my_server__read_file");
});
