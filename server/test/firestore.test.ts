// The Firestore stores against the Firestore emulator. Skipped unless it's running:
//
//   gcloud emulators firestore start --host-port=localhost:8085
//   FIRESTORE_EMULATOR_HOST=localhost:8085 npm run test:firestore
//
// (npm run test:firestore starts and stops the emulator itself.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Firestore } from "../src/firestore.ts";
import { FirestoreDeviceStore, FirestoreMetricsStore } from "../src/store.ts";
import { startServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { SpikeClient } from "../tools/client.ts";
import { accountsSuite } from "./accounts-suite.ts";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulatorHost ? false : "FIRESTORE_EMULATOR_HOST not set";

// A fresh project per run, so runs don't see each other's documents.
function db(): Firestore {
  return new Firestore({ projectId: `demo-test-${randomUUID().slice(0, 8)}`, emulatorHost });
}

accountsSuite("firestore", () => db(), skip);

test("devices round-trip through Firestore", { skip }, async () => {
  const devices = new FirestoreDeviceStore(db());
  assert.equal(await devices.get("nobody"), undefined);
  const device = { userId: "watch-0d34", name: "Steve's Watch", pushToken: "ab".repeat(32), apnsEnvironment: "sandbox" as const, updatedAt: 1_790_000_000_123 };
  await devices.upsert(device);
  await devices.upsert({ userId: "bot", name: "Test Bot", pushToken: "local:bot", apnsEnvironment: "production", updatedAt: 2 });
  assert.deepEqual(await devices.get("watch-0d34"), device);
  await devices.upsert({ ...device, name: "Renamed" });
  assert.equal((await devices.get("watch-0d34"))?.name, "Renamed");
  assert.deepEqual((await devices.list()).map((d) => d.userId).sort(), ["bot", "watch-0d34"]);
});

test("values keep their types", { skip }, async () => {
  const store = db();
  const data = {
    s: "text with / and ünïcode",
    i: 1_790_000_000_123,
    d: 0.25,
    neg: -3,
    b: false,
    n: null,
    when: new Date("2026-09-26T12:00:00.000Z"),
    list: [1, "two", { three: 3 }],
    map: { nested: { deeper: true } },
  };
  await store.set("things", "an ïd?#%", data);
  assert.deepEqual(await store.get("things", "an ïd?#%"), data);
  await assert.rejects(store.set("things", "a/b", data), /invalid document ID/);
});

test("server events are buffered and written as one document per conversation", { skip }, async () => {
  const firestore = db();
  const metrics = new FirestoreMetricsStore(firestore, { quietMs: 50, node: "relay-test" });
  metrics.server("c1", "talkStart", 1000, "alice -> bob");
  metrics.server("c1", "pushSent", 1010);
  metrics.server("c2", "talkStart", 2000);
  // Buffered events are visible before they're written.
  assert.deepEqual((await metrics.timeline("c1")).map((e) => e.name), ["talkStart", "pushSent"]);
  await metrics.upload({
    conversationId: "c1",
    userId: "bob",
    role: "receiver",
    clockOffsetMs: 5,
    events: [{ name: "notificationDelivered", t: 1000 }],
  });
  await new Promise((r) => setTimeout(r, 150));
  await metrics.flush();

  const docs = await firestore.query("timelines", { where: { field: "conversationId", op: "EQUAL", value: "c1" } });
  assert.equal(docs.length, 2);
  const server = docs.find((d) => d.data.source === "server")!;
  assert.equal(server.data.writer, "relay-test");
  assert.equal((server.data.entries as unknown[]).length, 2);
  assert.ok(server.data.expireAt instanceof Date);

  const timeline = await metrics.timeline("c1");
  assert.deepEqual(
    timeline.map((e) => `${e.source}.${e.name}@${e.t}`),
    ["server.talkStart@1000", "receiver.notificationDelivered@1005", "server.pushSent@1010"],
  );
  const summaries = await metrics.conversations();
  assert.deepEqual(
    summaries.sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
    [
      { conversationId: "c1", startedAt: 1000, events: 3 },
      { conversationId: "c2", startedAt: 2000, events: 1 },
    ],
  );
});

test("a relay on Firestore rings, relays and records a conversation", { skip }, async () => {
  const firestore = db();
  const metrics = new FirestoreMetricsStore(firestore, { quietMs: 60_000 });
  const s = await startServer({
    port: 0,
    dataDir: null,
    devices: new FirestoreDeviceStore(firestore),
    metrics,
    token: "secret",
    sharedTokenClients: true,
    pusher: new DryRunPusher(),
  });
  try {
    const client = (userId: string) => new SpikeClient({ server: `http://localhost:${s.port}`, userId, token: "secret" });
    const alice = client("alice");
    const bob = client("bob");
    await alice.register("Alice");
    await bob.register("Bob");
    await alice.connect();
    await bob.connect();
    const { conversationId, pushed } = await alice.talk("bob", Buffer.alloc(640 * 5), { realtime: false });
    assert.equal(pushed, true);
    const ring = await bob.waitFor("ring");
    assert.equal(ring.fromName, "Alice");
    bob.send({ type: "join", conversationId });
    await bob.waitFor("burst-end");
    alice.close();
    bob.close();
    await s.close();
    // close() flushed the buffered server events.
    const names = (await metrics.timeline(conversationId)).map((e) => e.name);
    for (const name of ["talkStart", "pushSent", "pushAccepted", "floorGrantSent", "receiverJoined"]) assert.ok(names.includes(name), name);
  } finally {
    await s.close().catch(() => {});
  }
});
