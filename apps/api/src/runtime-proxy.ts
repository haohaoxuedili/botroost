import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import websocket from "@fastify/websocket";
import WebSocket from "ws";

/** Body types whose absolute paths have to be rewritten for the sub-path mount. */
const REWRITABLE = /^(?:text\/html|text\/css|application\/javascript|text\/javascript|application\/x-javascript|application\/json)/;

/** Methods whose requests must carry a same-origin marker (a custom request header).
 *  Anything a browser can send cross-origin without a preflight — forms, image probes,
 *  simple GETs issued by another tab — is refused, because the console's session cookie
 *  would otherwise authenticate it.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAME_ORIGIN_HEADER = "x-botroost-runtime-proxy";

export interface RuntimeRoute {
  /** Host (and optional scheme) the API dials, e.g. `botroost-snowluma-x.botroost-runtime-hk.svc`. */
  host: string;
  /** Session cookie the runtime UI expects, when the agent provisioned one. */
  token?: string | null;
}

export interface RuntimeProxyOptions {
  /** Authorises the caller for one endpoint; throws DatabaseError when it is not theirs. */
  authorize(request: FastifyRequest, endpointId: string, port: number): Promise<{ workspaceId: string }>;
  /** Where the endpoint's runtime is reachable from this API, or null when the node has no route. */
  route(workspaceId: string, endpointId: string, port: number): Promise<RuntimeRoute | null>;
}

/**
 * Serves the runtime's own UI (SnowLuma WebUI, LLBot/NapCat WebUI, noVNC) through the console.
 *
 * Operators configure everything from the console — QQ login, OneBot websocket settings — and
 * those screens live inside the runtime container. Docker published the ports on the agent
 * host, so the console could point a browser at `<host>:<port>`. Kubernetes only gives a
 * ClusterIP, which no browser can dial, so the console proxies instead: the browser stays on
 * the console origin, the API dials the Service, and websockets are tunnelled so noVNC and the
 * WebUI's live updates keep working.
 *
 * Mounted as a sub-path, so response bodies are rewritten to keep the runtime's own absolute
 * paths (its `/assets/...`, `/websockify`) inside the mount.
 */
export function registerRuntimeProxy(app: FastifyInstance, options: RuntimeProxyOptions) {
  const mount = (id: string, port: number) => `/api/v1/endpoints/${id}/runtime/${port}`;

  // Encapsulated so the websocket plugin is always loaded before the route that needs it,
  // whichever order the caller registers things in.
  app.register(async scope => {
  await scope.register(websocket);

  // @fastify/websocket only accepts a websocket handler on GET, so the upgrade and the
  // plain HTTP traffic share the prefix through two routes: noVNC's `/websockify` lands on
  // the GET route, the WebUI's REST calls on the other.
  scope.route({
    method: "GET",
    url: "/api/v1/endpoints/:id/runtime/:port/*",
    wsHandler: (socket, request) => { void bridgeWebSocket(socket, request, options); },
    handler: async (request, reply) => { await bridgeHttp(request, reply, options); },
  });

  scope.route({
    method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api/v1/endpoints/:id/runtime/:port/*",
    handler: async (request, reply) => { await bridgeHttp(request, reply, options); },
  });

  scope.get("/api/v1/endpoints/:id/runtime/:port", async (request, reply) => {
    const { id, port } = mountParams(request);
    return reply.redirect(`${mount(id, port)}/`, 307);
  });
  });
}

function mountParams(request: FastifyRequest) {
  const params = request.params as { id?: string; port?: string };
  return { id: params.id ?? "", port: Number(params.port ?? 0) };
}

/** Resolves the dial target, or answers with the reason there is none. */
async function resolveTarget(request: FastifyRequest, options: RuntimeProxyOptions) {
  const { id, port } = mountParams(request);
  if (!id) return { error: { status: 400, body: { error: "bad_request", message: "endpoint is required" } } } as const;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: { status: 400, body: { error: "bad_request", message: "invalid runtime port" } } } as const;
  }
  if (MUTATING.has(request.method) && request.headers[SAME_ORIGIN_HEADER] !== "1") {
    return { error: { status: 403, body: { error: "forbidden", message: "runtime proxy requests must come from the console" } } } as const;
  }
  let workspaceId: string;
  try {
    ({ workspaceId } = await options.authorize(request, id, port));
  } catch (error) {
    // An endpoint that is not the caller's must look non-existent, not forbidden: the
    // console shows one message for "gone" and another for "not yours".
    return { error: { status: 404, body: { error: "not_found", message: "endpoint not found" } } } as const;
  }
  // The route lookup is also the SSRF guard: it only returns hosts and ports the agent
  // actually published for this endpoint, never a caller-supplied address.
  const route = await options.route(workspaceId, id, port);
  if (!route) {
    // The endpoint exists but its node reports no reachable UI: the agent has not observed the
    // runtime yet, or the workload is stopped.
    return { error: { status: 409, body: { error: "runtime_unreachable", message: "the runtime UI for this endpoint is not reachable yet" } } } as const;
  }
  return { target: route, prefix: `/api/v1/endpoints/${id}/runtime/${port}` } as const;
}

async function bridgeHttp(request: FastifyRequest, reply: FastifyReply, options: RuntimeProxyOptions) {
  const resolved = await resolveTarget(request, options);
  if ("error" in resolved) return reply.code(resolved.error.status).send(resolved.error.body);
  const { target, prefix } = resolved;
  const incoming = request.raw;
  const upstreamPath = incoming.url === undefined ? "/" : incoming.url.slice(prefix.length) || "/";
  const url = new URL(`http://${target.host}${upstreamPath}`);

  reply.hijack();
  const response = reply.raw;
  const headers: Record<string, string | string[] | undefined> = { ...incoming.headers, host: url.host, "accept-encoding": "identity" };
  // The console's own session cookie is not the runtime's; forwarding it would hand a
  // credential to the runtime UI that it never issued.
  delete headers.cookie;
  if (target.token) headers.cookie = target.token;

  const client = url.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = client(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: incoming.method,
      headers: headers as Record<string, string | string[]>,
    },
    result => { void pipeResponse(result, response, prefix); },
  );
  upstream.on("error", error => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "runtime_unreachable", message: error.message }));
  });
  incoming.pipe(upstream);
}

async function pipeResponse(upstream: IncomingMessage, response: ServerResponse, prefix: string) {
  const status = upstream.statusCode ?? 502;
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    // length/encoding change once the body is rewritten; location/cookie are handled below.
    if (name === "location" || name === "set-cookie" || name === "content-length" || name === "content-encoding" || name === "transfer-encoding") continue;
    headers[name] = value as string | string[];
  }
  // A runtime that redirects to its own root has to land back inside the mount.
  const location = upstream.headers.location;
  if (location) headers.location = location.startsWith("/") && !location.startsWith("//") ? `${prefix}${location}` : location;
  const cookies = upstream.headers["set-cookie"];
  if (cookies) {
    // Scope the runtime's cookies to its mount so they cannot shadow the console session.
    headers["set-cookie"] = cookies.map(cookie => cookie.replace(/;\s*path=[^;]*/i, "").concat(`; Path=${prefix}`));
  }

  const type = String(upstream.headers["content-type"] ?? "");
  if (!REWRITABLE.test(type) || upstream.headers["content-encoding"]) {
    response.writeHead(status, headers);
    upstream.pipe(response);
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of upstream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = rewriteAbsolutePaths(Buffer.concat(chunks).toString("utf8"), prefix);
  response.writeHead(status, { ...headers, "content-type": type });
  response.end(text);
}

/**
 * Keeps a runtime's own absolute paths inside the console mount.
 *
 * The runtime UIs are built to be served from `/`, so their markup and bundles reference
 * `/assets/...`, `/vnc.html`, `/websockify`. Mounted under a prefix those requests would hit
 * the console instead, so `"/…` becomes `"<prefix>/…` (same for `'/…` and `(/…`). Protocol
 * relative `//host` and absolute `http://` URLs are left alone.
 */
export function rewriteAbsolutePaths(body: string, prefix: string) {
  return body.replace(/(["'(])\/(?!\/)/g, (_match, quote: string) => `${quote}${prefix}/`);
}

async function bridgeWebSocket(socket: WebSocket, request: FastifyRequest, options: RuntimeProxyOptions) {
  const resolved = await resolveTarget(request, options);
  if ("error" in resolved) {
    socket.close(1011, resolved.error.body.error);
    return;
  }
  const { target, prefix } = resolved;
  const upstreamPath = (request.raw.url ?? "/").slice(prefix.length) || "/";
  const protocols = socket.protocol ? [socket.protocol] : [];
  const upstream = new WebSocket(`ws://${target.host}${upstreamPath}`, protocols, {
    headers: target.token ? { cookie: target.token } : {},
  });
  // Frames the browser sends before the upstream handshake completes must not be dropped:
  // noVNC writes its RFB handshake immediately after the socket opens.
  const queued: { data: Buffer; binary: boolean }[] = [];
  socket.on("message", (data: Buffer, binary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, binary });
  });
  socket.on("close", () => upstream.close());
  upstream.on("open", () => {
    for (const frame of queued.splice(0)) upstream.send(frame.data, { binary: frame.binary });
  });
  upstream.on("message", (data: Buffer, binary: boolean) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary });
  });
  upstream.on("close", () => socket.close());
  upstream.on("error", () => socket.close(1011, "runtime_unreachable"));
}

export { SAME_ORIGIN_HEADER };
