import { describe, expect, it } from "vitest";
import { buildApi } from "../src/index.js";
import { AuthService } from "@botroost/auth";
import { InMemoryDatabase, digest } from "@botroost/database";

const csrf = (cookie: string) => /botroost_csrf=([^;]+)/.exec(cookie)?.[1] ?? "";
const mutation = (cookie: string) => ({ cookie, origin: "https://app.test", "x-csrf-token": csrf(cookie) });

async function fixture(capacity?: { cpuMillis: number; memoryMiB: number }) {
  const database = new InMemoryDatabase();
  const api = buildApi({ database: database as never, credentialKey: Buffer.alloc(32, 1), publicOrigin: "https://app.test" });
  await api.ready();
  await database.updatePlatformSettings(true);
  const auth = new AuthService(database as never);
  const owner = await auth.bootstrapOwner("owner@example.com", "owner password is long enough", "Primary");
  await database.updatePlatformSettings(false);
  await database.createRegisteredSession(owner.userId, owner.workspaceId, digest("token"), digest("csrf"), new Date(Date.now() + 60_000));
  const node = database.createNode(owner.workspaceId, "node", "napcat");
  const record = database.nodeRecords.find((item) => item.id === node.id)!;
  if (capacity) record.capacity = capacity;
  return { database, api, owner, node, cookie: "botroost_session=token; botroost_csrf=csrf" };
}

describe("endpoint admission against node capacity", () => {
  it("refuses an endpoint the node cannot place, and says why", async () => {
    const f = await fixture({ cpuMillis: 4000, memoryMiB: 4096 });
    const first = await f.api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(f.cookie), payload: { name: "one", providerId: "napcat", nodeId: f.node.id } });
    expect(first.statusCode).toBe(201);
    const second = await f.api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(f.cookie), payload: { name: "two", providerId: "napcat", nodeId: f.node.id } });
    expect(second.statusCode).toBe(201);
    // Two 2 vCPU / 2 GiB endpoints fill the node; a third would never schedule.
    const third = await f.api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(f.cookie), payload: { name: "three", providerId: "napcat", nodeId: f.node.id } });
    expect(third.statusCode).toBe(409);
    expect((third.json() as { error: { message: string } }).error.message).toContain("no room for another napcat endpoint");
    // The refused request created nothing.
    expect(f.database.endpoints.filter((endpoint) => endpoint.workspaceId === f.owner.workspaceId)).toHaveLength(2);
  });

  it("still accepts endpoints on a node that never reported capacity", async () => {
    const f = await fixture();
    for (const name of ["one", "two", "three"]) {
      const created = await f.api.inject({ method: "POST", url: "/api/v1/endpoints", headers: mutation(f.cookie), payload: { name, providerId: "napcat", nodeId: f.node.id } });
      expect(created.statusCode).toBe(201);
    }
  });
});
