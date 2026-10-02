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
import { FirestoreMetricsStore } from "../src/store.ts";
import { accountsSuite } from "./accounts-suite.ts";
import { friends, pcm, withServer } from "./harness.ts";

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulatorHost ? false : "FIRESTORE_EMULATOR_HOST not set";

// A fresh project per run, so runs don't see each other's documents.
function db(): Firestore {
  return new Firestore({ projectId: `demo-test-${randomUUID().slice(0, 8)}`, emulatorHost });
}

accountsSuite("firestore", () => db(), skip);

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
  const metrics = new FirestoreMetricsStore(db(), { quietMs: 60_000 });
  let conversationId = "";
  await withServer(async (h) => {
    // Bob's watch is rung by an alert (the dry-run pusher), then answers.
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: { apns: "alert", token: "abcdef0123456789" } }]);
    const a = alice.client();
    await a.connect();
    const talk = await a.talk(bob.id, pcm(5), { realtime: false });
    conversationId = talk.conversationId;
    assert.equal(talk.pushed, true);
    const ring = h.pusher.sent[0].payload as { fromName: string; ringId: string };
    assert.equal(ring.fromName, "Alice");
    const b = bob.client();
    await b.connect();
    b.send({ type: "join", conversationId, ringId: ring.ringId });
    await b.waitFor("burst-end");
    a.close();
    b.close();
  }, { metrics });
  // Closing the server flushed the buffered server events.
  const names = (await metrics.timeline(conversationId)).map((e) => e.name);
  for (const name of ["talkStart", "pushSent", "pushAccepted", "floorGrantSent", "receiverJoined"]) assert.ok(names.includes(name), name);
});

test("count(): a collection, a filter, and a collection group", { skip }, async () => {
  const store = db();
  await store.commit([
    { set: "users/u_1", data: { n: 1 } },
    { set: "users/u_2", data: { n: 2 } },
    { set: "users/u_1/friends/u_2", data: { since: new Date() } },
    { set: "users/u_2/friends/u_1", data: { since: new Date() } },
    { set: "invites/a", data: { expireAt: new Date("2026-01-01T00:00:00Z") } },
    { set: "invites/b", data: { expireAt: new Date("2027-01-01T00:00:00Z") } },
  ]);
  assert.equal(await store.count("users"), 2);
  assert.equal(await store.count("friends", { allDescendants: true }), 2);
  assert.equal(await store.count("users/u_1/friends"), 1);
  assert.equal(await store.count("invites", { where: { field: "expireAt", op: "LESS_THAN", value: new Date("2026-10-01T00:00:00Z") } }), 1);
});
