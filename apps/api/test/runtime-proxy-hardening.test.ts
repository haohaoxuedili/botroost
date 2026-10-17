import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { authority, registerRuntimeProxy, rewriteLocation, runtimeDialHost, SAME_ORIGIN_HEADER } from "../src/runtime-proxy.js";

const endpointId = "0b3badb9-1111-2222-3333-444455556666";

async function fakeRuntime(handler?: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, body: string) => void) {
  const seen: { url: string; headers: Record<string, string | string[] | undefined>; method: string | undefined; body: string }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ url: request.url ?? "", headers: request.headers, method: request.method, body });
    if (handler) return handler(request, response, body);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><html><head></head><body>ok</body></html>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address ? address.port : 0, seen };
}

const closers: (() => Promise<void>)[] = [];
async function build(route: (workspaceId: string, endpointId: string, port: number) => Promise<{ host: string; port: number; scheme?: "http" | "https" } | null>, authorize = async () => ({ workspaceId: "w1" })) {
  const app = Fastify();
  void app.register(cookie);
  // A short deadline keeps the timeout test fast: the production default is 30s.
  registerRuntimeProxy(app, { authorize, route, timeoutMs: 200 });
  await app.listen({ port: 0, host: "127.0.0.1" });
  closers.push(() => app.close());
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}
afterAllCleanup();
function afterAllCleanup() {
  void import("vitest").then(({ afterEach }) => afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  }));
}

describe("runtimeDialHost", () => {
  it("accepts cluster-local literal addresses and Service names", () => {
    expect(runtimeDialHost("10.43.12.7")).toBe("10.43.12.7");
    expect(runtimeDialHost("172.20.0.9")).toBe("172.20.0.9");
    expect(runtimeDialHost("192.168.1.4")).toBe("192.168.1.4");
    expect(runtimeDialHost("127.0.0.1")).toBe("127.0.0.1");
    expect(runtimeDialHost("snowluma-x.runtime.svc")).toBe("snowluma-x.runtime.svc");
    expect(runtimeDialHost("runtime")).toBe("runtime");
  });

  it("refuses public hosts, metadata endpoints and smuggled authorities", () => {
    expect(runtimeDialHost("example.com")).toBeNull();
    expect(runtimeDialHost("8.8.8.8")).toBeNull();
    expect(runtimeDialHost("169.254.169.254")).toBeNull();
    expect(runtimeDialHost("10.43.12.7:8080")).toBeNull();
    expect(runtimeDialHost("10.0.0.1/../../etc")).toBeNull();
    expect(runtimeDialHost("user@10.0.0.1")).toBeNull();
    expect(runtimeDialHost("")).toBeNull();
  });
});

describe("authority", () => {
  it("brackets IPv6 literals so new URL accepts them", () => {
    expect(authority("fd00::5", 6081)).toBe("[fd00::5]:6081");
    expect(() => new URL(`http://${authority("fd00::5", 6081)}/`)).not.toThrow();
    expect(authority("10.0.0.1", 6081)).toBe("10.0.0.1:6081");
  });
});

describe("rewriteLocation", () => {
  const target = { host: "10.0.0.1", port: 6081 };
  it("pulls an absolute redirect back into the mount", () => {
    expect(rewriteLocation("http://10.0.0.1:6081/vnc.html?x=1", "/p", target)).toBe("/p/vnc.html?x=1");
  });
  it("leaves a foreign origin alone", () => {
    expect(rewriteLocation("https://example.com/a", "/p", target)).toBe("https://example.com/a");
  });
});

describe("runtime proxy hardening", () => {
  it("forwards a parsed JSON body to the runtime", async () => {
    const runtime = await fakeRuntime();
    closers.push(() => new Promise<void>(resolve => runtime.server.close(() => resolve())));
    const base = await build(async () => ({ host: "127.0.0.1", port: runtime.port }));

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", [SAME_ORIGIN_HEADER]: "1" },
      body: JSON.stringify({ token: "abc" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.seen.at(-1)?.body).toBe('{"token":"abc"}');
  });

  it("keeps a runtime session cookie on later requests but drops the console's", async () => {
    const runtime = await fakeRuntime();
    closers.push(() => new Promise<void>(resolve => runtime.server.close(() => resolve())));
    const base = await build(async () => ({ host: "127.0.0.1", port: runtime.port }));

    await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/`, {
      headers: { cookie: "botroost_session=secret; webui=abc" },
    });

    expect(runtime.seen[0]?.headers.cookie).toBe("webui=abc");
  });

  it("answers 504 when the runtime accepts and never replies", async () => {
    const runtime = await fakeRuntime(() => { /* never respond */ });
    closers.push(() => new Promise<void>(resolve => runtime.server.close(() => resolve())));
    const base = await build(async () => ({ host: "127.0.0.1", port: runtime.port }));

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/slow`, {
      signal: AbortSignal.timeout(10_000),
    });

    expect(response.status).toBe(504);
    expect((await response.json()).error).toBe("runtime_timeout");
  });

  it("reports an unavailable endpoint state instead of an unreachable runtime", async () => {
    const base = await build(async () => { throw new Error("database down"); });

    const response = await fetch(`${base}/api/v1/endpoints/${endpointId}/runtime/6081/`);

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("unavailable");
  });
});

describe("runtime proxy websocket origin", () => {
  it("refuses a handshake from a cross-site origin", async () => {
    const runtime = await fakeRuntime();
    closers.push(() => new Promise<void>(resolve => runtime.server.close(() => resolve())));
    const wss = new WebSocketServer({ server: runtime.server, path: "/websockify" });
    wss.on("connection", client => client.on("message", data => client.send(`echo:${data.toString()}`)));
    const base = await build(async () => ({ host: "127.0.0.1", port: runtime.port }));

    const client = new WebSocket(`${base.replace("http", "ws")}/api/v1/endpoints/${endpointId}/runtime/${runtime.port}/websockify`, {
      headers: { origin: "https://evil.example" },
    });
    const code = await new Promise<number>((resolve, reject) => {
      client.on("close", resolve);
      client.on("error", reject);
      setTimeout(() => reject(new Error("socket was not refused")), 5000);
    });
    wss.close();

    expect(code).toBe(1008);
    expect(runtime.seen).toHaveLength(0);
  });
});
