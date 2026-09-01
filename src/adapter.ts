import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export type JsonObject = Record<string, unknown>;
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string };

export interface ProxyResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface OAuthConfig {
  redirectUri?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

export interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: "stdio" | "streamable-http" | "sse";
  oauth?: boolean | OAuthConfig;
  disabled?: boolean;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  connectTimeout?: number;
  requestTimeout?: number;
}

interface McpConfig {
  mcpServers?: Record<string, ServerConfig>;
}

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Resource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ResourceTemplate = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number];
type Prompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];

interface OAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

interface ServerState {
  name: string;
  config: ServerConfig;
  client?: Client;
  transport?: Transport;
  httpTransport?: StreamableHTTPClientTransport | SSEClientTransport;
  oauthProvider?: FileOAuthProvider;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  status: "disabled" | "not-connected" | "connecting" | "connected" | "needs-auth" | "failed";
  error?: string;
  connectPromise?: Promise<ServerState>;
}

const VERSION = "1.1.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function text(value: unknown): ProxyResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorText(value: unknown): ProxyResult {
  const message = value instanceof Error ? value.message : String(value);
  return { content: [{ type: "text", text: message }], isError: true };
}

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

function zotHome(): string {
  if (process.env.ZOT_HOME) return process.env.ZOT_HOME;
  if (process.env.XDG_STATE_HOME) return join(process.env.XDG_STATE_HOME, "zot");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "zot");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? homedir(), "zot");
  return join(homedir(), ".local", "state", "zot");
}

async function readConfig(path: string): Promise<McpConfig | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    const parsed = JSON.parse(source) as McpConfig;
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
      throw new Error("missing mcpServers object");
    }
    return parsed;
  } catch (cause) {
    throw new Error(`cannot parse ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function loadConfig(projectCwd: string): Promise<Record<string, ServerConfig>> {
  const paths = [
    join(homedir(), ".config", "mcp", "mcp.json"),
    join(homedir(), ".agents", "mcp.json"),
    join(homedir(), ".agents", "mcp", "mcp.json"),
    join(zotHome(), "mcp.json"),
    join(projectCwd, ".mcp.json"),
    join(projectCwd, ".zot", "mcp.json"),
  ];
  const merged: Record<string, ServerConfig> = {};
  for (const path of paths) {
    const config = await readConfig(path);
    if (config?.mcpServers) Object.assign(merged, config.mcpServers);
  }
  return merged;
}

function openBrowser(url: URL): void {
  const spec = platform() === "darwin"
    ? { command: "open", args: [url.toString()] }
    : platform() === "win32"
      ? { command: "cmd", args: ["/c", "start", "", url.toString()] }
      : { command: "xdg-open", args: [url.toString()] };
  const child = spawn(spec.command, spec.args, { detached: true, stdio: "ignore" });
  child.unref();
}

class FileOAuthProvider implements OAuthClientProvider {
  private credentials: OAuthState = {};
  private authorizationUrl?: string;
  readonly redirectUrl: URL;
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    private readonly statePath: string,
    config: OAuthConfig,
    private readonly log: (message: string) => void,
  ) {
    this.redirectUrl = new URL(config.redirectUri ?? "http://127.0.0.1:33418/callback");
    this.clientMetadata = {
      client_name: "zot-mcp",
      redirect_uris: [this.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: config.clientSecret ? "client_secret_post" : "none",
      ...(config.scope ? { scope: config.scope } : {}),
    };
    if (config.clientId) {
      this.credentials.clientInformation = {
        client_id: config.clientId,
        ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
      };
    }
  }

  async load(): Promise<void> {
    try {
      this.credentials = { ...this.credentials, ...JSON.parse(await readFile(this.statePath, "utf8")) as OAuthState };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") this.log(`OAuth state load failed: ${String(cause)}`);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.credentials, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.statePath);
  }

  clientInformation(): OAuthClientInformationMixed | undefined { return this.credentials.clientInformation; }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> { this.credentials.clientInformation = value; await this.persist(); }
  tokens(): OAuthTokens | undefined { return this.credentials.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> { this.credentials.tokens = value; await this.persist(); }
  async saveCodeVerifier(value: string): Promise<void> { this.credentials.codeVerifier = value; await this.persist(); }
  codeVerifier(): string {
    if (!this.credentials.codeVerifier) throw new Error("OAuth code verifier is unavailable");
    return this.credentials.codeVerifier;
  }
  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url.toString();
  }
  getAuthorizationUrl(): string | undefined { return this.authorizationUrl; }
  openAuthorization(): void {
    if (!this.authorizationUrl) throw new Error("OAuth authorization URL is unavailable");
    openBrowser(new URL(this.authorizationUrl));
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "client") delete this.credentials.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.credentials.tokens;
    if (scope === "all" || scope === "verifier") delete this.credentials.codeVerifier;
    await this.persist();
  }
}

function requestTimeout(config: ServerConfig): number {
  return config.requestTimeoutMs ?? (config.requestTimeout ? config.requestTimeout * 1000 : DEFAULT_REQUEST_TIMEOUT_MS);
}

function connectTimeout(config: ServerConfig): number {
  return config.connectTimeoutMs ?? (config.connectTimeout ? config.connectTimeout * 1000 : DEFAULT_CONNECT_TIMEOUT_MS);
}

function requestOptions(config: ServerConfig, onProgress?: (progress: unknown) => void): RequestOptions {
  return {
    timeout: requestTimeout(config),
    resetTimeoutOnProgress: true,
    ...(onProgress ? { onprogress: onProgress } : {}),
  };
}

async function paginate<T>(fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

export function normalizeToolPath(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${clean(server)}__${clean(tool)}`;
}

export class McpAdapter {
  private readonly servers = new Map<string, ServerState>();

  constructor(
    configs: Record<string, ServerConfig>,
    private readonly projectCwd: string,
    private readonly dataDir: string,
    private readonly log: (message: string) => void = () => {},
    private readonly notify: (level: string, message: string) => void = () => {},
  ) {
    for (const [name, config] of Object.entries(configs)) {
      this.servers.set(name, {
        name,
        config,
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts: [],
        status: config.disabled === true ? "disabled" : "not-connected",
      });
    }
  }

  private makeClient(state: ServerState): Client {
    const client = new Client({ name: "zot-mcp", version: VERSION }, {
      capabilities: { roots: { listChanged: true } },
      listChanged: {
        tools: { onChanged: (cause, tools) => this.catalogChanged(state, "tools", cause, tools ?? undefined) },
        resources: { onChanged: (cause, resources) => this.catalogChanged(state, "resources", cause, resources ?? undefined) },
        prompts: { onChanged: (cause, prompts) => this.catalogChanged(state, "prompts", cause, prompts ?? undefined) },
      },
    });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(this.projectCwd).toString(), name: "project" }],
    }));
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const message = typeof notification.params.data === "string"
        ? notification.params.data
        : JSON.stringify(notification.params.data);
      this.log(`${state.name} [${notification.params.level}]: ${message}`);
      if (["warning", "error", "critical", "alert", "emergency"].includes(notification.params.level)) {
        this.notify(notification.params.level === "warning" ? "warn" : "error", `${state.name}: ${message}`);
      }
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      this.notify("info", `${state.name}: resource updated ${notification.params.uri}`);
    });
    client.onerror = (cause) => this.log(`${state.name}: ${cause.message}`);
    return client;
  }

  private catalogChanged(state: ServerState, kind: "tools" | "resources" | "prompts", cause: Error | null, items: unknown[] | undefined): void {
    if (cause) {
      this.log(`${state.name}: ${kind} refresh failed: ${cause.message}`);
      return;
    }
    if (items) {
      if (kind === "tools") state.tools = items as Tool[];
      if (kind === "resources") {
        state.resources = items as Resource[];
        void this.refreshResourceTemplates(state);
      }
      if (kind === "prompts") state.prompts = items as Prompt[];
      this.notify("info", `${state.name}: ${kind} catalog updated (${items.length})`);
    }
  }

  private async refreshResourceTemplates(state: ServerState): Promise<void> {
    if (!state.client) return;
    try {
      state.resourceTemplates = await paginate(async (cursor) => {
        const page = await state.client!.listResourceTemplates(cursor ? { cursor } : undefined, requestOptions(state.config));
        return { items: page.resourceTemplates, nextCursor: page.nextCursor };
      });
    } catch (cause) {
      this.log(`${state.name}: resource template refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  private async createTransport(state: ServerState): Promise<Transport> {
    const config = state.config;
    const transportKind = config.transport ?? (config.url ? "streamable-http" : "stdio");
    if (transportKind === "stdio") {
      if (!config.command) throw new Error(`${state.name}: stdio transport requires command`);
      const env = { ...process.env } as Record<string, string>;
      for (const [key, value] of Object.entries(config.env ?? {})) env[key] = interpolate(value);
      return new StdioClientTransport({
        command: interpolate(config.command),
        args: (config.args ?? []).map((arg) => interpolate(arg)),
        env,
        cwd: config.cwd ? expandPath(config.cwd, this.projectCwd) : this.projectCwd,
        stderr: "pipe",
      });
    }
    if (!config.url) throw new Error(`${state.name}: ${transportKind} transport requires url`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(config.headers ?? {})) headers.set(key, interpolate(value));
    let oauthProvider: FileOAuthProvider | undefined;
    if (config.oauth) {
      const configuredOAuth = config.oauth === true ? {} : config.oauth;
      const oauthConfig: OAuthConfig = {
        ...(configuredOAuth.redirectUri ? { redirectUri: interpolate(configuredOAuth.redirectUri) } : {}),
        ...(configuredOAuth.clientId ? { clientId: interpolate(configuredOAuth.clientId) } : {}),
        ...(configuredOAuth.clientSecret ? { clientSecret: interpolate(configuredOAuth.clientSecret) } : {}),
        ...(configuredOAuth.scope ? { scope: interpolate(configuredOAuth.scope) } : {}),
      };
      oauthProvider = new FileOAuthProvider(
        join(this.dataDir, "oauth", `${normalizeToolPath(state.name, "state")}.json`),
        oauthConfig,
        this.log,
      );
      await oauthProvider.load();
      state.oauthProvider = oauthProvider;
    }
    if (transportKind === "sse") {
      const transport = new SSEClientTransport(new URL(interpolate(config.url)), {
        authProvider: oauthProvider,
        requestInit: { headers },
        eventSourceInit: {
          fetch: (input, init) => fetch(input, { ...init, headers: new Headers([...headers, ...new Headers(init?.headers).entries()]) }),
        },
      });
      state.httpTransport = transport;
      return transport;
    }
    const transport = new StreamableHTTPClientTransport(new URL(interpolate(config.url)), {
      authProvider: oauthProvider,
      requestInit: { headers },
    });
    state.httpTransport = transport;
    return transport;
  }

  private async connectNow(state: ServerState): Promise<ServerState> {
    if (state.status === "disabled") throw new Error(`${state.name}: server is disabled`);
    if (state.status === "connected" && state.client) return state;
    state.status = "connecting";
    state.error = undefined;
    const client = this.makeClient(state);
    try {
      const transport = await this.createTransport(state);
      const stderr = transport instanceof StdioClientTransport ? transport.stderr : null;
      stderr?.on("data", (chunk) => this.log(`${state.name}: ${String(chunk).trimEnd()}`));
      state.client = client;
      state.transport = transport;
      await client.connect(transport, { timeout: connectTimeout(state.config) });
      state.status = "connected";
      await this.refreshCatalogs(state);
      return state;
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        state.status = "needs-auth";
        state.error = "authorization required";
        return state;
      }
      await client.close().catch(() => undefined);
      state.client = undefined;
      state.transport = undefined;
      state.status = "failed";
      state.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }
  }

  private async connect(name: string): Promise<ServerState> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`unknown MCP server: ${name}`);
    if ((state.status === "connected" || state.status === "needs-auth") && state.client) return state;
    state.connectPromise ??= this.connectNow(state).finally(() => { state.connectPromise = undefined; });
    return state.connectPromise;
  }

  private async refreshCatalogs(state: ServerState): Promise<void> {
    if (!state.client) return;
    const options = requestOptions(state.config);
    const capabilities = state.client.getServerCapabilities();
    if (capabilities?.tools) {
      state.tools = await paginate(async (cursor) => {
        const page = await state.client!.listTools(cursor ? { cursor } : undefined, options);
        return { items: page.tools, nextCursor: page.nextCursor };
      });
    }
    if (capabilities?.resources) {
      state.resources = await paginate(async (cursor) => {
        const page = await state.client!.listResources(cursor ? { cursor } : undefined, options);
        return { items: page.resources, nextCursor: page.nextCursor };
      });
      await this.refreshResourceTemplates(state);
    }
    if (capabilities?.prompts) {
      state.prompts = await paginate(async (cursor) => {
        const page = await state.client!.listPrompts(cursor ? { cursor } : undefined, options);
        return { items: page.prompts, nextCursor: page.nextCursor };
      });
    }
  }

  private async connectEnabled(): Promise<void> {
    await Promise.all([...this.servers.values()]
      .filter((state) => state.status !== "disabled")
      .map((state) => this.connect(state.name).catch((cause) => this.log(`${state.name}: ${String(cause)}`))));
  }

  private toolEntries() {
    return [...this.servers.values()].flatMap((state) => state.tools.map((tool) => ({
      server: state.name,
      path: normalizeToolPath(state.name, tool.name),
      tool,
    })));
  }

  async status(): Promise<JsonObject> {
    return {
      servers: [...this.servers.values()].map((state) => ({
        name: state.name,
        status: state.status,
        tools: state.tools.length,
        resources: state.resources.length,
        prompts: state.prompts.length,
        capabilities: state.client?.getServerCapabilities() ?? {},
        ...(state.error ? { error: state.error } : {}),
      })),
    };
  }

  async search(query: string): Promise<JsonObject> {
    await this.connectEnabled();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const tools = this.toolEntries().map((entry) => {
      const description = entry.tool.description ?? "";
      const haystack = `${entry.server} ${entry.tool.name} ${entry.tool.title ?? ""} ${description}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { ...entry, description, score };
    }).filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50)
      .map(({ server, path, tool, description }) => ({ server, path, name: tool.name, description }));
    return { query, tools };
  }

  private async resolveTool(path: string) {
    await this.connectEnabled();
    const matches = this.toolEntries().filter((entry) => entry.path === path || entry.tool.name === path);
    if (matches.length === 0) throw new Error(`unknown MCP tool: ${path}`);
    if (matches.length > 1) throw new Error(`ambiguous MCP tool: ${path}; use its server-qualified path`);
    return matches[0];
  }

  private async callTool(path: string, args: JsonObject): Promise<ProxyResult> {
    const entry = await this.resolveTool(path);
    const state = await this.connect(entry.server);
    const progress: unknown[] = [];
    const result = await state.client!.callTool({ name: entry.tool.name, arguments: args }, undefined,
      requestOptions(state.config, (value) => {
        progress.push(value);
        this.notify("info", `${state.name}/${entry.tool.name}: ${JSON.stringify(value)}`);
      }));
    const content: ContentBlock[] = [];
    for (const block of "content" in result && Array.isArray(result.content) ? result.content : []) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") content.push({ type: "image", mime_type: block.mimeType, data: block.data });
      else content.push({ type: "text", text: JSON.stringify(block, null, 2) });
    }
    if (result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
    if (progress.length > 0) content.push({ type: "text", text: `Progress events: ${JSON.stringify(progress)}` });
    return { content: content.length ? content : [{ type: "text", text: "(empty result)" }], isError: result.isError === true };
  }

  private async resources(server?: string): Promise<JsonObject> {
    if (server) await this.connect(server); else await this.connectEnabled();
    return {
      resources: [...this.servers.values()].filter((state) => !server || state.name === server)
        .flatMap((state) => state.resources.map((resource) => ({ server: state.name, ...resource }))),
      templates: [...this.servers.values()].filter((state) => !server || state.name === server)
        .flatMap((state) => state.resourceTemplates.map((template) => ({ server: state.name, ...template }))),
    };
  }

  private async readResource(server: string, uri: string): Promise<ProxyResult> {
    const state = await this.connect(server);
    const result = await state.client!.readResource({ uri }, requestOptions(state.config));
    const content: ContentBlock[] = result.contents.map((item) => {
      if ("text" in item) return { type: "text" as const, text: `[${item.uri}]\n${item.text}` };
      if (item.mimeType?.startsWith("image/")) return { type: "image" as const, mime_type: item.mimeType, data: item.blob };
      return { type: "text" as const, text: JSON.stringify(item, null, 2) };
    });
    return { content };
  }

  private async prompts(server?: string): Promise<JsonObject> {
    if (server) await this.connect(server); else await this.connectEnabled();
    return {
      prompts: [...this.servers.values()].filter((state) => !server || state.name === server)
        .flatMap((state) => state.prompts.map((prompt) => ({ server: state.name, ...prompt }))),
    };
  }

  private async disconnect(name: string): Promise<JsonObject> {
    const state = this.servers.get(name);
    if (!state) throw new Error(`unknown MCP server: ${name}`);
    await state.client?.close();
    state.client = undefined;
    state.transport = undefined;
    state.httpTransport = undefined;
    state.status = state.config.disabled ? "disabled" : "not-connected";
    return { server: name, status: state.status };
  }

  async execute(input: JsonObject): Promise<ProxyResult> {
    try {
      const action = typeof input.action === "string" ? input.action : "status";
      const server = typeof input.server === "string" ? input.server : undefined;
      switch (action) {
        case "status": return text(await this.status());
        case "connect": {
          if (!server) throw new Error("server is required for connect");
          const state = await this.connect(server);
          return text(await this.status().then((value) => ({ server, status: state.status, details: value })));
        }
        case "disconnect": {
          if (!server) throw new Error("server is required for disconnect");
          return text(await this.disconnect(server));
        }
        case "reconnect": {
          if (!server) throw new Error("server is required for reconnect");
          await this.disconnect(server);
          await this.connect(server);
          return text({ server, status: "connected" });
        }
        case "search": return text(await this.search(typeof input.query === "string" ? input.query : ""));
        case "describe": {
          if (typeof input.tool !== "string") throw new Error("tool is required for describe");
          const entry = await this.resolveTool(input.tool);
          return text({ server: entry.server, path: entry.path, ...entry.tool });
        }
        case "call": {
          if (typeof input.tool !== "string") throw new Error("tool is required for call");
          const args = input.args && typeof input.args === "object" && !Array.isArray(input.args) ? input.args as JsonObject : {};
          return this.callTool(input.tool, args);
        }
        case "resources/list": return text(await this.resources(server));
        case "resources/read": {
          if (!server || typeof input.uri !== "string") throw new Error("server and uri are required for resources/read");
          return this.readResource(server, input.uri);
        }
        case "resources/subscribe":
        case "resources/unsubscribe": {
          if (!server || typeof input.uri !== "string") throw new Error(`server and uri are required for ${action}`);
          const state = await this.connect(server);
          const method = action === "resources/subscribe" ? state.client!.subscribeResource.bind(state.client) : state.client!.unsubscribeResource.bind(state.client);
          await method({ uri: input.uri }, requestOptions(state.config));
          return text({ server, uri: input.uri, subscribed: action.endsWith("subscribe") && !action.endsWith("unsubscribe") });
        }
        case "prompts/list": return text(await this.prompts(server));
        case "prompts/get": {
          if (!server || typeof input.prompt !== "string") throw new Error("server and prompt are required for prompts/get");
          const state = await this.connect(server);
          const args = input.args && typeof input.args === "object" && !Array.isArray(input.args)
            ? Object.fromEntries(Object.entries(input.args as JsonObject).map(([key, value]) => [key, String(value)]))
            : undefined;
          return text(await state.client!.getPrompt({ name: input.prompt, arguments: args }, requestOptions(state.config)));
        }
        case "complete": {
          if (!server || !input.ref || typeof input.ref !== "object" || typeof input.argument !== "object") {
            throw new Error("server, ref, and argument are required for complete");
          }
          const state = await this.connect(server);
          return text(await state.client!.complete({ ref: input.ref as never, argument: input.argument as never }, requestOptions(state.config)));
        }
        case "logging/set": {
          if (!server || typeof input.level !== "string") throw new Error("server and level are required for logging/set");
          const state = await this.connect(server);
          await state.client!.setLoggingLevel(input.level as never, requestOptions(state.config));
          return text({ server, level: input.level });
        }
        case "ping": {
          if (!server) throw new Error("server is required for ping");
          const state = await this.connect(server);
          await state.client!.ping(requestOptions(state.config));
          return text({ server, ok: true });
        }
        case "auth-start": {
          if (!server) throw new Error("server is required for auth-start");
          const state = await this.connect(server);
          if (state.status !== "needs-auth") return text({ server, status: state.status });
          state.oauthProvider?.openAuthorization();
          return text({ server, status: state.status, authorizationUrl: state.oauthProvider?.getAuthorizationUrl(), redirectUri: state.oauthProvider?.redirectUrl.toString() });
        }
        case "auth-complete": {
          if (!server || typeof input.code !== "string") throw new Error("server and code are required for auth-complete");
          const state = this.servers.get(server);
          if (!state?.httpTransport) throw new Error(`${server}: no OAuth flow is pending`);
          await state.httpTransport.finishAuth(input.code);
          await this.disconnect(server);
          await this.connect(server);
          return text({ server, status: "connected" });
        }
        default: throw new Error(`unknown action: ${action}`);
      }
    } catch (cause) {
      return errorText(cause);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.servers.values()].map((state) => state.client?.close().catch(() => undefined)));
  }
}
