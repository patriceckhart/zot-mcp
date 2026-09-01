import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { McpAdapter, normalizeToolPath } from "../src/adapter.ts";

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
  }, root);
  adapters.push(adapter);
  return adapter;
}

describe("McpAdapter", () => {
  test("reports status without starting lazy servers", async () => {
    assert.deepEqual(await fixtureAdapter().status(), {
      servers: [
        { name: "fixture", status: "not-connected", toolCount: 0 },
        { name: "disabled", status: "disabled", toolCount: 0 },
      ],
    });
  });

  test("searches, describes, and calls stdio tools", async () => {
    const adapter = fixtureAdapter();
    assert.deepEqual(await adapter.search("echo text"), {
      query: "echo text",
      tools: [{ server: "fixture", path: "fixture__echo", name: "echo", description: "Echo a text value" }],
    });
    assert.deepEqual(await adapter.describe("fixture__echo"), {
      server: "fixture",
      path: "fixture__echo",
      name: "echo",
      description: "Echo a text value",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    });
    assert.deepEqual(await adapter.call("fixture__echo", { text: "hello" }), {
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("validates proxy actions", async () => {
    await assert.rejects(fixtureAdapter().execute({ action: "call" }), /tool is required/);
  });
});

test("normalizes server-qualified tool paths", () => {
  assert.equal(normalizeToolPath("my server", "read.file"), "my_server__read_file");
});
