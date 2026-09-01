import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type JsonObject = Record<string, unknown>;

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  requestTimeoutMs?: number;
}

export interface McpConfig {
  mcpServers?: Record<string, ServerConfig>;
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: JsonObject;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: unknown;
}

interface Transport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const PROTOCOL_VERSION = "2025-06-18";

function interpolate(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{([^}]+)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const key = String(braced ?? plain);
    const replacement = env[key];
    if (replacement === undefined) throw new Error(`environment variable ${key} is not set`);
    return replacement;
  });
}

function expandPath(value: string, cwd: string): string {
  const interpolated = interpolate(value);
  if (interpolated === "~") return homedir();
  if (interpolated.startsWith("~/")) return join(homedir(), interpolated.slice(2));
  return isAbsolute(interpolated) ? interpolated : resolve(cwd, interpolated);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function normalizeToolPath(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${clean(server)}__${clean(tool)}`;
}

export async function loadConfig(projectCwd: string): Promise<Record<string, ServerConfig>> {
  const globalPath = join(homedir(), ".config", "mcp", "mcp.json");
  const projectPath = join(projectCwd, ".mcp.json");
  const merged: Record<string, ServerConfig> = {};

  for (const path of [globalPath, projectPath]) {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: McpConfig;
    try {
      parsed = JSON.parse(contents) as McpConfig;
    } catch (error) {
      throw new Error(`cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      throw new Error(`${path} must contain an mcpServers object`);
    }
    Object.assign(merged, parsed.mcpServers);
  }

  return merged;
}

export class StdioTransport implements Transport {
  private process?: ChildProcessWithoutNullStreams;
  private nextID = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly name: string;
  private readonly config: ServerConfig;
  private readonly projectCwd: string;
  private readonly log: (message: string) => void;

  constructor(name: string, config: ServerConfig, projectCwd: string, log: (message: string) => void) {
    this.name = name;
    this.config = config;
    this.projectCwd = projectCwd;
    this.log = log;
  }

  async start(): Promise<void> {
    if (!this.config.command) throw new Error(`${this.name}: command is required`);
    const cwd = this.config.cwd ? expandPath(this.config.cwd, this.projectCwd) : this.projectCwd;
    const env = { ...process.env } as Record<string, string>;
    for (const [key, value] of Object.entries(this.config.env ?? {})) env[key] = interpolate(value);

    this.process = spawn(interpolate(this.config.command), (this.config.args ?? []).map((arg) => interpolate(arg)), {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => {
      if (line.trim()) this.handleLine(line);
    });
    const stderr = createInterface({ input: this.process.stderr, crlfDelay: Infinity });
    stderr.on("line", (line) => {
      if (line.trim()) this.log(`${this.name}: ${line}`);
    });
    this.process.on("error", (error) => this.rejectPending(new Error(`${this.name}: ${error.message}`)));
    this.process.on("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.rejectPending(new Error(`${this.name}: server exited with ${detail}`));
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      this.log(`${this.name}: ignored non-JSON stdout`);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`${this.name}: ${message.error.message ?? "MCP request failed"}`));
    else pending.resolve(message.result);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.process) await this.start();
    const id = this.nextID++;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const timeout = this.config.requestTimeoutMs && this.config.requestTimeoutMs > 0
      ? this.config.requestTimeoutMs
      : DEFAULT_TIMEOUT_MS;
    try {
      return await withTimeout(response, timeout, `${this.name}: ${method}`);
    } finally {
      this.pending.delete(id);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.process) await this.start();
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: JsonObject): void {
    if (!this.process) throw new Error(`${this.name}: server is not running`);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.process = undefined;
    process.stdin.end();
    await new Promise<void>((resolve) => {
      if (process.exitCode !== null || process.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => process.kill(), 500);
      timer.unref();
      process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export class HttpTransport implements Transport {
  private nextID = 1;
  private sessionID?: string;
  private readonly name: string;
  private readonly config: ServerConfig;

  constructor(name: string, config: ServerConfig) {
    this.name = name;
    this.config = config;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return this.send({ jsonrpc: "2.0", id: this.nextID++, method, ...(params === undefined ? {} : { params }) }, true);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, false);
  }

  private async send(payload: JsonObject, expectResponse: boolean): Promise<unknown> {
    if (!this.config.url) throw new Error(`${this.name}: url is required`);
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    for (const [key, value] of Object.entries(this.config.headers ?? {})) headers[key] = interpolate(value);
    if (this.sessionID) headers["Mcp-Session-Id"] = this.sessionID;
    const timeout = this.config.requestTimeoutMs && this.config.requestTimeoutMs > 0
      ? this.config.requestTimeoutMs
      : DEFAULT_TIMEOUT_MS;
    const response = await withTimeout(fetch(interpolate(this.config.url), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }), timeout, `${this.name}: HTTP request`);
    if (!response.ok) throw new Error(`${this.name}: HTTP ${response.status} ${response.statusText}`);
    this.sessionID = response.headers.get("mcp-session-id") ?? this.sessionID;
    if (!expectResponse || response.status === 202) return undefined;
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let message: RpcResponse;
    if (contentType.includes("text/event-stream")) {
      const data = text.split("\n").filter((line) => line.startsWith("data:"));
      if (data.length === 0) throw new Error(`${this.name}: empty event stream response`);
      message = JSON.parse(data.at(-1)!.slice(5).trim()) as RpcResponse;
    } else {
      message = JSON.parse(text) as RpcResponse;
    }
    if (message.error) throw new Error(`${this.name}: ${message.error.message ?? "MCP request failed"}`);
    return message.result;
  }

  async close(): Promise<void> {
    if (!this.sessionID || !this.config.url) return;
    await fetch(interpolate(this.config.url), {
      method: "DELETE",
      headers: { "Mcp-Session-Id": this.sessionID },
    }).catch(() => undefined);
    this.sessionID = undefined;
  }
}

interface ServerState {
  config: ServerConfig;
  transport?: Transport;
  tools?: ToolInfo[];
  error?: string;
}

export class McpAdapter {
  private readonly servers = new Map<string, ServerState>();
  private readonly projectCwd: string;
  private readonly log: (message: string) => void;

  constructor(configs: Record<string, ServerConfig>, projectCwd: string, log: (message: string) => void = () => {}) {
    this.projectCwd = projectCwd;
    this.log = log;
    for (const [name, config] of Object.entries(configs)) this.servers.set(name, { config });
  }

  private async connect(name: string): Promise<ServerState> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`unknown MCP server: ${name}`);
    if (state.config.disabled === true) throw new Error(`${name}: server is disabled`);
    if (state.tools) return state;

    const transport: Transport = state.config.url
      ? new HttpTransport(name, state.config)
      : new StdioTransport(name, state.config, this.projectCwd, this.log);
    state.transport = transport;
    try {
      await transport.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "zot-mcp", version: "1.0.0" },
      });
      await transport.notify("notifications/initialized");
      const listed = await transport.request("tools/list", {});
      const tools = (listed as { tools?: ToolInfo[] } | undefined)?.tools;
      if (!Array.isArray(tools)) throw new Error(`${name}: tools/list returned no tools array`);
      state.tools = tools;
      state.error = undefined;
      return state;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      await transport.close().catch(() => undefined);
      state.transport = undefined;
      throw error;
    }
  }

  async status(): Promise<JsonObject> {
    return {
      servers: [...this.servers.entries()].map(([name, state]) => ({
        name,
        status: state.config.disabled === true ? "disabled" : state.tools ? "connected" : state.error ? "failed" : "not-connected",
        toolCount: state.tools?.length ?? 0,
        ...(state.error ? { error: state.error } : {}),
      })),
    };
  }

  async connectServer(name: string): Promise<JsonObject> {
    const state = await this.connect(name);
    return { server: name, status: "connected", toolCount: state.tools?.length ?? 0 };
  }

  private async allTools(connectAll: boolean): Promise<Array<{ server: string; path: string; tool: ToolInfo }>> {
    if (connectAll) {
      await Promise.all([...this.servers.entries()]
        .filter(([, state]) => state.config.disabled !== true)
        .map(async ([name]) => this.connect(name).catch((error) => this.log(error instanceof Error ? error.message : String(error)))));
    }
    const result: Array<{ server: string; path: string; tool: ToolInfo }> = [];
    for (const [server, state] of this.servers) {
      for (const tool of state.tools ?? []) result.push({ server, path: normalizeToolPath(server, tool.name), tool });
    }
    return result;
  }

  async search(query: string): Promise<JsonObject> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const tools = await this.allTools(true);
    const matches = tools
      .map((entry) => {
        const haystack = `${entry.server} ${entry.tool.name} ${entry.tool.description ?? ""}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { ...entry, score };
      })
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50)
      .map(({ server, path, tool }) => ({ server, path, name: tool.name, description: tool.description ?? "" }));
    return { query, tools: matches };
  }

  async describe(path: string): Promise<JsonObject> {
    const entry = (await this.allTools(true)).find((candidate) => candidate.path === path || candidate.tool.name === path);
    if (!entry) throw new Error(`unknown MCP tool: ${path}`);
    return {
      server: entry.server,
      path: entry.path,
      name: entry.tool.name,
      description: entry.tool.description ?? "",
      inputSchema: entry.tool.inputSchema ?? { type: "object", properties: {} },
    };
  }

  async call(path: string, args: JsonObject): Promise<unknown> {
    const entries = await this.allTools(true);
    const matches = entries.filter((candidate) => candidate.path === path || candidate.tool.name === path);
    if (matches.length === 0) throw new Error(`unknown MCP tool: ${path}`);
    if (matches.length > 1) throw new Error(`ambiguous MCP tool name: ${path}; use the server-qualified path`);
    const entry = matches[0];
    const state = await this.connect(entry.server);
    if (!state.transport) throw new Error(`${entry.server}: server is not connected`);
    return state.transport.request("tools/call", { name: entry.tool.name, arguments: args });
  }

  async execute(input: JsonObject): Promise<unknown> {
    const action = typeof input.action === "string" ? input.action : "status";
    switch (action) {
      case "status": return this.status();
      case "connect": {
        if (typeof input.server !== "string" || !input.server) throw new Error("server is required for connect");
        return this.connectServer(input.server);
      }
      case "search": return this.search(typeof input.query === "string" ? input.query : "");
      case "describe": {
        if (typeof input.tool !== "string" || !input.tool) throw new Error("tool is required for describe");
        return this.describe(input.tool);
      }
      case "call": {
        if (typeof input.tool !== "string" || !input.tool) throw new Error("tool is required for call");
        if (input.args !== undefined && (typeof input.args !== "object" || input.args === null || Array.isArray(input.args))) {
          throw new Error("args must be a JSON object");
        }
        return this.call(input.tool, (input.args ?? {}) as JsonObject);
      }
      default: throw new Error(`unknown action: ${action}`);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((state) => state.transport?.close().catch(() => undefined)));
  }
}
