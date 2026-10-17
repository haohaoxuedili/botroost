// LLBot runtime: an independent OneBot v11 provider runtime backed by LLBot.
// Deliberately does not import runtime values from ./index.js so it stays
// fully isolated from the NapCat/SnowLuma code paths (type-only imports are erased).
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  RuntimeCommandSchema,
  applyProxyEnvironment,
  type CommandProgressRequest,
  type RuntimeCommand,
} from "@botroost/agent-protocol";
import { NapCatTrafficAccumulator, parseLLBotConnectionLine, parseLLBotTrafficLine } from "./traffic.js";
import { LocalRuntimeStorage, type RuntimeStorage } from "./runtime/storage.js";
import { loginUrl, runtimeHost } from "./runtime/login-links.js";
import type {
  AgentCommandTransport,
  DockerClient,
  DockerInspectResult,
  FetchLike,
} from "./index.js";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

/** Pinned, digest-addressed LLBot artifact (linyuchen/llbot). */
export const LLBOT_IMAGE =
  "linyuchen/llbot@sha256:6f10ce9c8848cc6a1157b4bda878d7485e25602b719448f3907de87f1bd30014";
export const LLBOT_ARTIFACT =
  "artifact:llbot:linyuchen.llbot.sha256.6f10ce9c8848cc6a1157b4bda878d7485e25602b719448f3907de87f1bd30014";
const ONEBOT_HTTP_PORT = 3000;
const WEBUI_CONTAINER_PORT = "3080";
const endpointIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const containerPrefixPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export type LLBotProgress = Pick<CommandProgressRequest, "phase" | "percent" | "message">;
export type LLBotApplyResult = {
  state: "running" | "stopped";
  observations?: Parameters<AgentCommandTransport["result"]>[0]["observations"];
  metadata?: JsonObject;
};
export type LLBotSnapshot = {
  endpointId: string;
  generation: number;
  runtime: "ready" | "stopped" | "failed" | "unknown";
  provider: "available" | "unavailable" | "unknown" | "degraded";
  protocol: "connected" | "disconnected" | "connecting" | "unknown";
  convergence: "converged" | "failed" | "reconciling" | "unknown" | "conflicted";
  metadata: JsonObject;
};

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500) || "Runtime execution failed";
}
function oneBotActionData(response: JsonObject): JsonValue {
  const nested = response.data;
  const envelope = nested !== null && typeof nested === "object" && !Array.isArray(nested)
    && ("retcode" in nested || "status" in nested)
    ? nested as JsonObject
    : response;
  if (envelope.status !== "ok" || envelope.retcode !== 0) {
    const message = typeof envelope.message === "string" && envelope.message ? envelope.message : "OneBot action failed";
    throw new Error(`${message} (retcode ${String(envelope.retcode ?? "unknown")})`);
  }
  return envelope.data ?? null;
}
export function llbotResourceLimits(requested: { cpuMillis: number; memoryMiB: number }): { cpuMillis: number; memoryMiB: number; memorySwapMiB: number } {
  const cpuMillis = Math.max(1000, requested.cpuMillis), memoryMiB = Math.max(1024, requested.memoryMiB);
  return { cpuMillis, memoryMiB, memorySwapMiB: memoryMiB + 512 };
}
/** Deterministic per-endpoint host WebUI port so parallel endpoints rarely collide. */
export function llbotLoginPorts(endpointId: string): { webuiPort: number } {
  const offset = Number.parseInt(endpointId.slice(0, 4), 16) % 400;
  return { webuiPort: 3080 + offset };
}
const isJsonObject = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const asJsonObject = (value: JsonValue | undefined): JsonObject => isJsonObject(value) ? value : {};
const asJsonList = (value: JsonValue | undefined): JsonObject[] => Array.isArray(value) ? value.filter(isJsonObject) : [];
const requireEntry = (raw: unknown): JsonObject => {
  if (!isJsonObject(raw as JsonValue)) throw new Error("OneBot websocket entry is invalid");
  return raw as JsonObject;
};
const numberOr = (value: JsonValue | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const redactLogs = (text: string) => text
  .replace(/([?&](?:token|password|secret|key)=)[^&\s]+/gi, "$1[REDACTED]")
  .replace(/((?:authorization|cookie)\s*:\s*)(?:bearer\s+)?[^\r\n]+/gi, "$1[REDACTED]")
  .replace(/((?:token|password|secret|key|credential|session)\s*[=:]\s*)["']?[^\s,"'}]+["']?/gi, "$1[REDACTED]")
  .replace(/("(?:token|password|secret|key|credential|session)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");

export class LLBotRuntime {
  private readonly networkMode: string;
  private readonly containerPrefix: string;
  private readonly fetcher: FetchLike;
  private readonly commands = new Map<string, RuntimeCommand>();
  private readonly snapshotCache = new Map<string, { at: number; value: LLBotSnapshot }>();
  private readonly trafficAccumulators = new Map<string, NapCatTrafficAccumulator>();
  private readonly trafficCache = new Map<string, { at: number; summary: JsonObject }>();
  private readonly trafficLastSuccessAt = new Map<string, number>();
  private commandsLoaded = false;
  private executionQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    docker: DockerClient;
    stateDirectory: string;
    hostStateDirectory?: string;
    containerPrefix?: string;
    networkMode?: string;
    onebotAccessToken?: string;
    fetcher?: FetchLike;
    signal?: AbortSignal;
    operationTimeoutMs?: number;
    /** Reaches the endpoint's durable data. Defaults to the agent host (Docker backend). */
    storage?: RuntimeStorage;
    /** Kubernetes backend: the in-container mount target for each volume name. */
    containerMounts?: Record<string, string>;
  }) {
    this.networkMode = options.networkMode ?? process.env.LLBOT_DOCKER_NETWORK ?? "bridge";
    this.containerPrefix = options.containerPrefix ?? "botroost-llbot";
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(this.networkMode) || this.networkMode === "host" || this.networkMode.startsWith("container:")) throw new Error("LLBot docker network is invalid");
    if (!containerPrefixPattern.test(this.containerPrefix)) throw new Error("container prefix is invalid");
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.storage = options.storage ?? new LocalRuntimeStorage();
    this.containerMounts = options.containerMounts ?? {};
  }
  private readonly storage: RuntimeStorage;
  private readonly containerMounts: Record<string, string>;
  private commandStatePath() { return join(this.options.stateDirectory, "runtime-commands.json"); }
  private async loadCommands() {
    if (this.commandsLoaded) return;
    this.commandsLoaded = true;
    try {
      const stored = JSON.parse(await readFile(this.commandStatePath(), "utf8")) as unknown[];
      for (const value of stored) { const command = RuntimeCommandSchema.parse(value); this.commands.set(command.endpointId, command); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private async persistCommands() {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${this.commandStatePath()}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...this.commands.values()])}\n`, { mode: 0o600 });
    await rename(temporary, this.commandStatePath());
  }
  private endpointRoot(endpointId: string) {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    const root = resolve(this.options.stateDirectory);
    const path = resolve(root, endpointId);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("endpoint storage path is invalid");
    return path;
  }
  private hostEndpointDirectory(endpointId: string, child: string) {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    const root = resolve(this.options.hostStateDirectory ?? this.options.stateDirectory);
    const path = resolve(root, endpointId, child);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("endpoint storage path is invalid");
    return path;
  }
  private containerName(endpointId: string) {
    if (!endpointIdPattern.test(endpointId)) throw new Error("endpoint identifier is invalid");
    return `${this.containerPrefix}-${endpointId}`;
  }
  private assertAllowed(command: RuntimeCommand) {
    const image = typeof command.metadata.image === "string" ? command.metadata.image : "";
    if (image !== LLBOT_IMAGE || command.runtimeRequest.approvedArtifactId !== LLBOT_ARTIFACT)
      throw new Error("LLBot image is not allowlisted");
  }
  private ownsContainer(container: Pick<DockerInspectResult, "labels">, command: RuntimeCommand) {
    return container.labels["botroost.workspace_id"] === command.workspaceId && container.labels["botroost.endpoint_id"] === command.endpointId && container.labels["botroost.provider"] === "llbot";
  }
  apply(effectId: string, command: RuntimeCommand, onProgress: (progress: LLBotProgress) => Promise<void> = async () => undefined, signal?: AbortSignal) {
    const pending = this.executionQueue.then(() => {
      const deadline = AbortSignal.any([AbortSignal.timeout(this.options.operationTimeoutMs ?? 120_000), ...(signal ? [signal] : []), ...(this.options.signal ? [this.options.signal] : [])]);
      return this.applySerial(effectId, command, async progress => { deadline.throwIfAborted(); await onProgress(progress); deadline.throwIfAborted(); });
    });
    this.executionQueue = pending.catch(() => undefined);
    return pending;
  }
  private async applySerial(_effectId: string, command: RuntimeCommand, onProgress: (progress: LLBotProgress) => Promise<void>): Promise<LLBotApplyResult> {
    this.assertAllowed(command);
    await onProgress({ phase: "inspecting-runtime", percent: 20, message: "Authorizing runtime command" });
    await this.loadCommands();
    const previousCommand = this.commands.get(command.endpointId);
    if (previousCommand && previousCommand.generation > command.generation) throw new Error("runtime generation fence rejected");
    const name = this.containerName(command.endpointId);
    const docker = this.options.docker;
    await onProgress({ phase: "inspecting-runtime", percent: 22, message: "Inspecting container ownership" });
    const existing = await docker.inspect(name);
    if (existing && !this.ownsContainer(existing, command)) throw new Error("LLBot container is not owned by this endpoint");
    if (command.action === "delete") {
      await onProgress({ phase: "removing-runtime", percent: 55, message: "Removing container and persisted runtime data" });
      // Explicit endpoint deletion is the only path allowed to discard durable state.
      if (existing) await docker.remove(name, { discardData: true });
      await onProgress({ phase: "removing-runtime", percent: 62, message: "Removing persisted host runtime data" });
      await docker.removeHostEndpoint(resolve(this.options.hostStateDirectory ?? this.options.stateDirectory), command.endpointId, LLBOT_IMAGE);
      await onProgress({ phase: "removing-runtime", percent: 70, message: "Removing agent runtime state" });
      await rm(this.endpointRoot(command.endpointId), { recursive: true, force: true });
      await onProgress({ phase: "removing-runtime", percent: 78, message: "Finalizing agent runtime deletion" });
      this.commands.delete(command.endpointId);
      await this.persistCommands();
      this.snapshotCache.delete(command.endpointId);
      await onProgress({ phase: "removing-runtime", percent: 95, message: "Runtime deletion complete" });
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" }, metadata: { deleted: true } };
    }
    if (command.action === "read-container-logs") {
      await onProgress({ phase: "probing-provider", percent: 75, message: "Reading runtime diagnostics" });
      if (!existing || existing.labels["botroost.workspace_id"] !== command.workspaceId || existing.labels["botroost.endpoint_id"] !== command.endpointId || existing.labels["botroost.provider"] !== "llbot") throw new Error("LLBot container ownership check failed");
      const tail = Number(command.metadata.logTail), sinceSeconds = Number(command.metadata.logSinceSeconds);
      if (!Number.isInteger(tail) || tail < 1 || tail > 1000 || !Number.isInteger(sinceSeconds) || sinceSeconds < 60 || sinceSeconds > 86400) throw new Error("LLBot log bounds are invalid");
      const text = redactLogs(await docker.logs(name, { tail, sinceSeconds }));
      await onProgress({ phase: "probing-provider", percent: 95, message: "Runtime diagnostics ready" });
      return { state: existing.state === "running" ? "running" : "stopped", metadata: { logs: { text, tail, sinceSeconds } } };
    }
    if (command.action === "refresh-login-qr")
      throw new Error("action is not supported for LLBot endpoints; complete login through the LLBot WebUI");
    if (command.action === "update-onebot-websockets") {
      await onProgress({ phase: "applying-configuration", percent: 60, message: "Applying OneBot WebSocket configuration" });
      if (!existing || existing.state !== "running") throw new Error("LLBot container is not running");
      const clients = command.metadata.websocketClients, servers = command.metadata.websocketServers;
      if (!Array.isArray(clients) || clients.length > 20 || !Array.isArray(servers) || servers.length > 20) throw new Error("OneBot websocket configuration is invalid");
      const found = await this.findOneBotConfig(command.endpointId);
      if (!found) throw new Error("LLBot OneBot configuration appears after QQ login; complete the login in the WebUI first");
      this.commands.set(command.endpointId, command);
      await this.persistCommands();
      await onProgress({ phase: "applying-configuration", percent: 70, message: "Writing OneBot WebSocket configuration" });
      await this.writeOneBotWebsockets(command.endpointId, found.path, found.config, clients, servers);
      await onProgress({ phase: "applying-configuration", percent: 80, message: "Reloading the LLBot runtime" });
      // LLBot reads its protocol configuration at start; restart the container. The QQ
      // login session is persisted under /app/llbot/data and survives the restart.
      await docker.restart(name);
      this.snapshotCache.delete(command.endpointId);
      await onProgress({ phase: "probing-provider", percent: 90, message: "Verifying OneBot configuration" });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const snapshot = await this.snapshot(command).catch(error => ({
        endpointId: command.endpointId, generation: command.generation, runtime: "ready" as const, provider: "degraded" as const, protocol: "disconnected" as const, convergence: "reconciling" as const, metadata: { error: safeError(error) },
      }));
      await onProgress({ phase: "probing-provider", percent: 95, message: "OneBot configuration verified" });
      return { state: "running", observations: { node: "online", runtime: snapshot.runtime, provider: snapshot.provider, protocol: snapshot.protocol, convergence: snapshot.convergence }, metadata: snapshot.metadata };
    }
    if (command.action === "update-endpoint-proxy" && existing && existing.state !== "running") {
      this.commands.set(command.endpointId, command);
      await this.persistCommands();
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" } };
    }
    const desiredResources = llbotResourceLimits(command.runtimeRequest.resources);
    const storedConfiguration = (command.metadata.configuration as Record<string, unknown> | undefined) ?? {};
    const proxyEnvironment = applyProxyEnvironment(storedConfiguration.proxy ?? null);
    const resourceDrift = existing?.resources && (existing.resources.cpuMillis !== desiredResources.cpuMillis || existing.resources.memoryMiB !== desiredResources.memoryMiB || existing.resources.memorySwapMiB !== desiredResources.memorySwapMiB);
    const proxyDrift = existing !== null && ((proxyEnvironment?.HTTP_PROXY ?? null) !== (existing.proxyEnvironment?.HTTP_PROXY ?? null));
    if (command.action !== "stop" && (!existing || existing.image !== LLBOT_IMAGE || resourceDrift || proxyDrift)) {
      if (existing) { await onProgress({ phase: "preparing-runtime", percent: 35, message: "Replacing outdated LLBot container" }); await docker.remove(name); }
      await onProgress({ phase: "preparing-runtime", percent: 40, message: "Preparing runtime image and storage" });
      // The protocol pod mounts the endpoint's data volume at this path; on Docker it is the
      // host directory handed to the container as a bind mount.
      const dataMount = this.containerMounts.data ?? (this.storage.kind === "pod" ? "/data" : this.hostEndpointDirectory(command.endpointId, "data"));
      // Only Docker needs the bind source to exist before the container starts. On Kubernetes
      // the claim's subPath directories are created by the workload's init container, and the
      // pod does not exist yet -- exec'ing here would abort the create before it began.
      if (this.storage.kind === "local") await this.storage.for(name).ensureDirectory(dataMount);
      await onProgress({ phase: "creating-container", percent: 55, message: "Creating LLBot container" });
      const ports = llbotLoginPorts(command.endpointId);
      await docker.create({
        name,
        image: LLBOT_IMAGE,
        labels: {
          "botroost.provider": "llbot",
          "botroost.workspace_id": command.workspaceId,
          "botroost.endpoint_id": command.endpointId,
          "botroost.generation": String(command.generation),
        },
        environment: { WEBUI_PORT: WEBUI_CONTAINER_PORT, TZ: "Asia/Shanghai", ...(proxyEnvironment ?? {}) },
        mounts: [{ type: "bind", source: dataMount, target: "/app/llbot/data" }],
        hostConfig: { networkMode: this.networkMode, portBindings: {} },
        resources: desiredResources,
        // Kubernetes has no host ports (ClusterIP only); the driver ignores this and exposes
        // the WebUI through the workload's Service instead.
        publishedPorts: [{ hostPort: String(ports.webuiPort), containerPort: WEBUI_CONTAINER_PORT }],
        // The provider talks to OneBot over the container network, so this port is never
        // published on Docker -- but a Kubernetes Service only routes declared ports.
        exposePorts: [ONEBOT_HTTP_PORT],
      });
    }
    if (command.action === "stop" && existing) { await onProgress({ phase: "stopping-container", percent: 70, message: "Stopping LLBot container" }); await docker.stop(name); }
    else if (command.action === "force-restart") {
      if (!existing) throw new Error("LLBot container not found");
      if (!docker.kill) throw new Error("Runtime driver does not support force restart");
      this.snapshotCache.delete(command.endpointId);
      if (existing.state === "running") { await onProgress({ phase: "stopping-container", percent: 55, message: "Force killing owned LLBot container (data preserved)" }); await docker.kill(existing.id); }
      await onProgress({ phase: "starting-container", percent: 75, message: "Starting preserved LLBot container" });
      await docker.start(existing.id);
    }
    else if (command.action === "restart" || command.action === "update-endpoint-proxy") { this.snapshotCache.delete(command.endpointId); await docker.restart(name); }
    else if (command.action !== "stop") { await onProgress({ phase: "starting-container", percent: 70, message: "Starting LLBot container" }); await docker.start(name); }
    this.commands.set(command.endpointId, command);
    await this.persistCommands();
    if (command.action === "stop") {
      return { state: "stopped", observations: { node: "online", runtime: "stopped", provider: "unavailable", protocol: "disconnected", convergence: "converged" } };
    }
    await onProgress({ phase: "probing-provider", percent: 85, message: "Waiting for LLBot runtime readiness" });
    const snapshot = await this.snapshot(command).catch(error => ({
      endpointId: command.endpointId, generation: command.generation, runtime: "unknown" as const, provider: "degraded" as const, protocol: "disconnected" as const, convergence: "reconciling" as const, metadata: { error: safeError(error) },
    }));
    await onProgress({ phase: "probing-provider", percent: 95, message: "LLBot runtime observation ready" });
    return {
      state: "running",
      observations: { node: "online", runtime: snapshot.runtime, provider: snapshot.provider, protocol: snapshot.protocol, convergence: snapshot.convergence },
      metadata: snapshot.metadata,
    };
  }
  async snapshot(command: RuntimeCommand) {
    this.assertAllowed(command);
    return this.snapshotWithContainer(command, await this.options.docker.inspect(this.containerName(command.endpointId)));
  }
  private async oneBotGet(base: URL, action: string, token: string | undefined, timeoutMs = 10_000): Promise<{ data: JsonValue; probe: { ok: boolean; durationMs: number; error: string | null } }> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, timeout]) : timeout;
    try {
      const response = await this.fetcher(new URL(`/${action}`, base), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal,
      });
      if (!response.ok) throw new Error(`OneBot ${action} failed: ${response.status}`);
      const payload = await response.json() as JsonObject;
      return { data: oneBotActionData(payload), probe: { ok: true, durationMs: Date.now() - started, error: null } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(message), { probe: { ok: false, durationMs: Date.now() - started, error: message } });
    }
  }
  private async readOneBotToken(endpointId: string): Promise<string | undefined> {
    try {
      const found = await this.findOneBotConfig(endpointId);
      if (!found) return undefined;
      const ob11 = asJsonObject(found.config.ob11);
      for (const entry of asJsonList(ob11.connect)) {
        if (entry.type !== "http") continue;
        const token = entry.token;
        if (typeof token === "string" && token.length > 0) return token;
      }
    } catch { /* token file not present yet (e.g. before QQ login) */ }
    return undefined;
  }
  private async findOneBotConfig(endpointId: string): Promise<{ path: string; qq: string; config: JsonObject } | null> {
    const directory = this.containerMounts.data ?? this.hostEndpointDirectory(endpointId, "data");
    const entries = await this.storage.for(this.containerName(endpointId)).readdir(directory).catch(() => []);
    if (!entries.length) return null;
    for (const entry of entries) {
      const match = /^config_(.+)\.json$/.exec(entry);
      if (!match?.[1]) continue;
      const path = join(directory, entry);
      const config = asJsonObject(JSON.parse(await this.storage.for(this.containerName(endpointId)).readFile(path)) as JsonValue);
      return { path, qq: match[1], config };
    }
    return null;
  }
  /** Map the console editor payload (NapCat-shaped websocketClients/websocketServers) onto
   *  LLBot's native ob11.connect entries, preserving existing access tokens for entries that
   *  keep their position (the editor never echoes tokens back). */
  private mapOneBotWebsockets(config: JsonObject, clients: unknown[], servers: unknown[]): JsonObject {
    const ob11 = asJsonObject(config.ob11);
    const connect = asJsonList(ob11.connect);
    const passthrough = connect.filter(entry => entry.type === "http" || entry.type === "http-post");
    const previousClients = connect.filter(entry => entry.type === "ws-reverse");
    const previousServers = connect.filter(entry => entry.type === "ws");
    const mappedServers = servers.map((raw, index) => {
      const value = requireEntry(raw);
      const previous = previousServers[index];
      return {
        type: "ws",
        enable: value.enable !== false,
        host: typeof value.host === "string" && value.host ? value.host : "0.0.0.0",
        port: typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 ? value.port : 3001,
        heartInterval: numberOr(value.heartInterval, 60000),
        token: typeof value.token === "string" && value.token ? value.token : (typeof previous?.token === "string" ? previous.token : ""),
        reportSelfMessage: value.reportSelfMessage === true,
        reportOfflineMessage: previous?.reportOfflineMessage === true,
        messageFormat: value.messagePostFormat === "string" ? "string" : "array",
        debug: false,
      } satisfies JsonObject;
    });
    const mappedClients = clients.map((raw, index) => {
      const value = requireEntry(raw);
      const previous = previousClients[index];
      if (typeof value.url !== "string" || !value.url) throw new Error("OneBot websocket client url is required");
      return {
        type: "ws-reverse",
        enable: value.enable !== false,
        url: value.url,
        heartInterval: numberOr(value.heartInterval, 60000),
        token: typeof value.token === "string" && value.token ? value.token : (typeof previous?.token === "string" ? previous.token : ""),
        reportSelfMessage: value.reportSelfMessage === true,
        reportOfflineMessage: previous?.reportOfflineMessage === true,
        messageFormat: value.messagePostFormat === "string" ? "string" : "array",
        debug: false,
      } satisfies JsonObject;
    });
    return { ...config, ob11: { ...ob11, enable: true, connect: [...passthrough, ...mappedServers, ...mappedClients] } };
  }
  private async writeOneBotWebsockets(endpointId: string, path: string, config: JsonObject, clients: unknown[], servers: unknown[]) {
    const merged = this.mapOneBotWebsockets(config, clients, servers);
    await this.storage.for(this.containerName(endpointId)).writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  }
  /** Editor-shaped snapshot of the OneBot websocket configuration (NapCat field names so the
   *  console editor renders unchanged); only present once QQ login created config_<qq>.json. */
  private async oneBotEditorConfig(endpointId: string): Promise<JsonObject> {
    try {
      const found = await this.findOneBotConfig(endpointId);
      if (!found) return {};
      const connect = asJsonList(asJsonObject(found.config.ob11).connect);
      return {
        websocketClients: connect.filter(entry => entry.type === "ws-reverse").map((entry, index) => ({
          name: typeof entry.name === "string" ? entry.name : `ws-reverse-${index}`,
          enable: entry.enable !== false,
          url: typeof entry.url === "string" ? entry.url : "",
          messagePostFormat: entry.messageFormat === "string" ? "string" : "array",
          reportSelfMessage: entry.reportSelfMessage === true,
          debug: false,
          heartInterval: numberOr(entry.heartInterval, 60000),
          reconnectInterval: 5000,
          tokenConfigured: typeof entry.token === "string" && entry.token.length > 0,
        })),
        websocketServers: connect.filter(entry => entry.type === "ws").map((entry, index) => ({
          name: typeof entry.name === "string" ? entry.name : `ws-${index}`,
          enable: entry.enable !== false,
          host: typeof entry.host === "string" ? entry.host : "0.0.0.0",
          port: typeof entry.port === "number" ? entry.port : 3001,
          messagePostFormat: entry.messageFormat === "string" ? "string" : "array",
          reportSelfMessage: entry.reportSelfMessage === true,
          debug: false,
          heartInterval: numberOr(entry.heartInterval, 60000),
          enableForcePushEvent: true,
          tokenConfigured: typeof entry.token === "string" && entry.token.length > 0,
        })),
      };
    } catch { /* config file unreadable; render an empty editor */ }
    return {};
  }
  private async snapshotWithContainer(command: RuntimeCommand, inspected: DockerInspectResult | null): Promise<LLBotSnapshot> {
    this.assertAllowed(command);
    if (!inspected || inspected.state !== "running" || !inspected.ipAddress) {
      return { endpointId: command.endpointId, generation: command.generation, runtime: "stopped", provider: "unknown", protocol: "disconnected", convergence: "reconciling", metadata: {} };
    }
    const base = new URL(`http://${inspected.ipAddress}:${ONEBOT_HTTP_PORT}`);
    const configuredToken = (this.options.onebotAccessToken ?? process.env.LLBOT_ONEBOT_ACCESS_TOKEN ?? "").trim() || undefined;
    const token = configuredToken ?? await this.readOneBotToken(command.endpointId);
    const ports = llbotLoginPorts(command.endpointId);
    const webuiUrl = loginUrl(ports.webuiPort);
    // See loginUrl(): on Kubernetes the browser needs an operator-provided entry point.
    const webuiHost = runtimeHost(inspected.serviceHost);
    const loginGuide = { webuiPort: ports.webuiPort, ...(webuiHost ? { webuiHost } : {}), ...(webuiUrl ? { webuiUrl } : {}) };
    const [statusSettled, loginSettled, versionSettled] = await Promise.allSettled([
      this.oneBotGet(base, "get_status", token),
      this.oneBotGet(base, "get_login_info", token),
      this.oneBotGet(base, "get_version_info", token),
    ]);
    if (statusSettled.status === "rejected") {
      // LLBot only starts its OneBot HTTP server after QQ logs in, so an unreachable
      // provider while the container runs means "waiting for the WebUI login".
      const reason = statusSettled.reason as Error & { probe?: { ok: boolean; durationMs: number; error: string | null } };
      return {
        endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
        protocol: "disconnected", convergence: "reconciling",
        metadata: {
          qq: { online: false }, login: {},
          onebot: { status: {}, loginInfo: {}, version: null, probes: { get_status: reason?.probe ?? { ok: false, durationMs: 0, error: safeError(reason) } } },
          loginGuide,
          error: safeError(reason),
        },
      };
    }
    const statusResult = statusSettled.value;
    const loginResult = loginSettled.status === "fulfilled" ? loginSettled.value : null;
    const versionResult = versionSettled.status === "fulfilled" ? versionSettled.value : null;
    const probes: Record<string, { ok: boolean; durationMs: number; error: string | null }> = {
      get_status: statusResult.probe,
      get_login_info: loginResult ? loginResult.probe : (loginSettled as PromiseRejectedResult).reason?.probe ?? { ok: false, durationMs: 0, error: "get_login_info failed" },
      ...(versionResult ? { get_version_info: versionResult.probe } : {}),
    };
    const asObject = (value: JsonValue): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    const status = asObject(statusResult.data);
    const loginInfo = loginResult ? asObject(loginResult.data) : {};
    const online = typeof status.online === "boolean" ? status.online && Object.keys(loginInfo).length > 0 : Object.keys(loginInfo).length > 0 ? true : null;
    if (online !== true) {
      return {
        endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
        protocol: "disconnected", convergence: "reconciling",
        metadata: { qq: { online }, login: loginInfo, onebot: { status, loginInfo, version: versionResult ? asObject(versionResult.data) : null, probes, config: await this.oneBotEditorConfig(command.endpointId) }, loginGuide },
      };
    }
    const [friendsSettled, groupsSettled] = await Promise.allSettled([
      this.oneBotGet(base, "get_friend_list", token),
      this.oneBotGet(base, "get_group_list", token),
    ]);
    const directoryCollection = (settled: PromiseSettledResult<{ data: JsonValue; probe: { ok: boolean; durationMs: number; error: string | null } }>) => {
      if (settled.status === "rejected") {
        const reason = settled.reason as Error & { probe?: { ok: boolean; durationMs: number; error: string | null } };
        return { count: 0, items: [] as JsonObject[], truncated: false, observedAt: null, probe: reason?.probe ?? { ok: false, durationMs: 0, error: safeError(reason) } };
      }
      const list = Array.isArray(settled.value.data) ? settled.value.data.filter((item): item is JsonObject => item !== null && typeof item === "object") : [];
      const truncated = list.length > 500;
      return { count: list.length, items: truncated ? list.slice(0, 500) : list, truncated, observedAt: new Date().toISOString(), probe: settled.value.probe };
    };
    const friends = directoryCollection(friendsSettled);
    const groups = directoryCollection(groupsSettled);
    probes.get_friend_list = friends.probe;
    probes.get_group_list = groups.probe;
    const websocketConfig = await this.oneBotEditorConfig(command.endpointId);
    const traffic = await this.protocolTraffic(command.endpointId);
    return {
      endpointId: command.endpointId, generation: command.generation, runtime: "ready", provider: "available",
      protocol: "connected", convergence: "converged",
      metadata: { qq: { online, ...loginInfo }, onebot: { status, loginInfo, version: versionResult ? asObject(versionResult.data) : null, probes, directory: { friends, groups }, config: websocketConfig }, traffic, loginGuide },
    };
  }
  private async protocolTraffic(endpointId: string): Promise<JsonObject> {
    const now = Date.now();
    const cached = this.trafficCache.get(endpointId);
    if (cached && now - cached.at < 5_000) return cached.summary;
    let accumulator = this.trafficAccumulators.get(endpointId);
    if (!accumulator) {
      accumulator = new NapCatTrafficAccumulator(parseLLBotTrafficLine, parseLLBotConnectionLine, "llbot.container_logs");
      this.trafficAccumulators.set(endpointId, accumulator);
    }
    const lastSuccessAt = this.trafficLastSuccessAt.get(endpointId);
    const sinceSeconds = lastSuccessAt === undefined
      ? 300
      : Math.min(300, Math.max(15, Math.ceil((now - lastSuccessAt) / 1000) + 5));
    const maxBytes = 4 * 1024 * 1024;
    let status: "ok" | "partial" | "unavailable" = "ok";
    let complete = true;
    try {
      const logs = await this.options.docker.logs(this.containerName(endpointId), { tail: 5000, sinceSeconds, timestamps: true, maxBytes });
      const lines = logs.split(/\r?\n/).filter(Boolean);
      accumulator.ingest(lines, now);
      complete = lines.length < 5000 && Buffer.byteLength(logs) < maxBytes;
      status = complete ? "ok" : "partial";
      this.trafficLastSuccessAt.set(endpointId, now);
    } catch {
      status = "unavailable";
      complete = false;
    }
    const summary = {
      ...accumulator.summary(now),
      status,
      complete,
      sampleIntervalSeconds: 5,
      ...(status === "unavailable" ? { error: "Container log telemetry unavailable" } : {}),
      ...(status === "partial" ? { error: "High log volume truncated the latest sample; displayed rates are lower bounds" } : {}),
    } as unknown as JsonObject;
    this.trafficCache.set(endpointId, { at: now, summary });
    return summary;
  }
  async observations(): Promise<NonNullable<Parameters<AgentCommandTransport["heartbeat"]>[0]>> {
    await this.loadCommands();
    const commands = [...this.commands.values()];
    return Promise.all(commands.map(async command => {
      try {
        this.assertAllowed(command);
        const inspected = await this.options.docker.inspect(this.containerName(command.endpointId));
        if (inspected && !this.ownsContainer(inspected, command)) throw new Error("LLBot container is not owned by this endpoint");
        const cached = this.snapshotCache.get(command.endpointId);
        if (cached && Date.now() - cached.at < 15_000 && inspected?.state === "running" && inspected.ipAddress) return cached.value;
        const value = await this.snapshotWithContainer(command, inspected);
        this.snapshotCache.set(command.endpointId, { at: Date.now(), value });
        return value;
      } catch (error) {
        this.snapshotCache.delete(command.endpointId);
        return { endpointId: command.endpointId, generation: command.generation, runtime: "unknown", provider: "degraded", protocol: "unknown", convergence: "reconciling", metadata: { error: safeError(error) } };
      }
    }));
  }
}
