import { describe, expect, it } from "vitest";
import { InMemoryDatabase, runtimeRequestForProvider } from "../src/index.js";

describe("node capacity admission", () => {
  it("admits endpoints while the reported capacity and existing reservations leave room", async () => {
    const db = new InMemoryDatabase();
    const owner = db.createWorkspace("owner");
    const node = db.createNode(owner.id, "node");
    const record = db.nodeRecords.find((item) => item.id === node.id)!;
    record.capacity = { cpuMillis: 4000, memoryMiB: 4096 };
    expect((await db.nodeCapacity(owner.id, node.id, "napcat"))?.admitted).toBe(true);
    await db.createEndpoint(owner.id, "first", "napcat", node.id);
    // Two NapCat endpoints reserve exactly the reported 4 vCPU / 4 GiB, so a third cannot place.
    const verdict = await db.nodeCapacity(owner.id, node.id, "napcat");
    expect(verdict).toMatchObject({ admitted: true, reserved: { cpuMillis: 2000, memoryMiB: 2048, endpoints: 1 } });
    await db.createEndpoint(owner.id, "second", "napcat", node.id);
    expect(await db.nodeCapacity(owner.id, node.id, "napcat")).toMatchObject({
      admitted: false,
      required: { cpuMillis: 6000, memoryMiB: 6144 },
    });
  });

  it("counts every provider at its own size when judging the next endpoint", async () => {
    const db = new InMemoryDatabase();
    const owner = db.createWorkspace("owner");
    const node = db.createNode(owner.id, "node");
    db.nodeRecords.find((item) => item.id === node.id)!.capacity = { cpuMillis: 8000, memoryMiB: 8192 };
    await db.createEndpoint(owner.id, "napcat", "napcat", node.id);
    await db.createEndpoint(owner.id, "snowluma", "snowluma", node.id);
    const snowluma = runtimeRequestForProvider("snowluma").resources;
    expect(await db.nodeCapacity(owner.id, node.id, "llbot")).toMatchObject({
      reserved: { cpuMillis: 2000 + snowluma.cpuMillis, memoryMiB: 2048 + snowluma.memoryMiB, endpoints: 2 },
      admitted: true,
    });
  });

  it("does not refuse a node whose agent never reported capacity", async () => {
    const db = new InMemoryDatabase();
    const owner = db.createWorkspace("owner");
    const node = db.createNode(owner.id, "node");
    expect(await db.nodeCapacity(owner.id, node.id, "napcat")).toMatchObject({ capacity: null, admitted: true });
  });

  it("returns no verdict for a node the workspace cannot use", async () => {
    const db = new InMemoryDatabase();
    const owner = db.createWorkspace("owner");
    const stranger = db.createWorkspace("stranger");
    const node = db.createNode(owner.id, "private");
    expect(await db.nodeCapacity(stranger.id, node.id, "napcat")).toBeNull();
  });
});
