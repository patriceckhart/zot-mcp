import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { McpAdapter, normalizeToolPath } from "../src/adapter.ts";

const adapters: McpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

function fixtureAdapter(): McpAdapter {
  const root = join(import.meta.dir, "..");
  const adapter = new McpAdapter({
    fixture: {
      command: process.execPath,
      args: [join(import.meta.dir, "fixture-server.ts")],
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
    expect(await fixtureAdapter().status()).toEqual({
      servers: [
        { name: "fixture", status: "not-connected", toolCount: 0 },
        { name: "disabled", status: "disabled", toolCount: 0 },
      ],
    });
  });

  test("searches, describes, and calls stdio tools", async () => {
    const adapter = fixtureAdapter();
    expect(await adapter.search("echo text")).toEqual({
      query: "echo text",
      tools: [{ server: "fixture", path: "fixture__echo", name: "echo", description: "Echo a text value" }],
    });
    expect(await adapter.describe("fixture__echo")).toMatchObject({
      server: "fixture",
      name: "echo",
      inputSchema: { required: ["text"] },
    });
    expect(await adapter.call("fixture__echo", { text: "hello" })).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("validates proxy actions", async () => {
    await expect(fixtureAdapter().execute({ action: "call" })).rejects.toThrow("tool is required");
  });
});

test("normalizes server-qualified tool paths", () => {
  expect(normalizeToolPath("my server", "read.file")).toBe("my_server__read_file");
});
