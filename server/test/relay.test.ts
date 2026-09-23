import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { SpikeClient } from "../tools/client.ts";

async function withServer(fn: (s: RunningServer, pusher: DryRunPusher) => Promise<void>): Promise<void> {
  const pusher = new DryRunPusher();
  const running = await startServer({ port: 0, dataDir: null, token: "secret", pusher });
  try {
    await fn(running, pusher);
  } finally {
    await running.close();
  }
}

function client(s: RunningServer, userId: string): SpikeClient {
  return new SpikeClient({ server: `http://localhost:${s.port}`, userId, token: "secret" });
}

// 0.5 s of a ramp so frames are distinguishable.
function pcm(frames: number): Buffer {
  const buf = Buffer.alloc(frames * 640);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE((i * 37) % 32000, i * 2);
  return buf;
}

test("rejects unauthenticated API calls", async () => {
  await withServer(async (s) => {
    const res = await fetch(`http://localhost:${s.port}/v1/users`);
    assert.equal(res.status, 401);
  });
});

test("ring-to-start: rings an absent recipient, buffers, and replays on join", async () => {
  await withServer(async (s, pusher) => {
    const alice = client(s, "alice");
    const bob = client(s, "bob");
    await alice.register("Alice");
    await bob.register("Bob", "abcdef0123456789"); // real-looking token: goes through the pusher
    await alice.connect();

    const { conversationId, pushed } = await alice.talk("bob", pcm(25), { realtime: false });
    assert.equal(pushed, true);
    assert.equal(pusher.sent.length, 1);
    const payload = pusher.sent[0].payload as Record<string, unknown>;
    assert.equal(payload.conversationId, conversationId);
    assert.equal(payload.fromName, "Alice");

    // Bob's watch wakes, the user answers, the app connects and joins.
    await bob.connect();
    bob.send({ type: "join", conversationId });
    const joined = await bob.waitFor("joined");
    assert.equal(joined.replayBursts, 1);
    const start = await bob.waitFor("burst-start");
    assert.equal(start.replay, true);
    await bob.waitFor("burst-end");
    assert.equal(bob.frames.length, 25);
    assert.deepEqual(
      bob.frames.map((f) => f.readUInt32BE(1)),
      Array.from({ length: 25 }, (_, i) => i),
    );

    // Within the conversation window, Alice's next burst is live and doesn't ring again.
    const second = await alice.talk("bob", pcm(5), { realtime: false });
    assert.equal(second.pushed, false);
    assert.equal(second.conversationId, conversationId);
    const live = await bob.waitFor("burst-start");
    assert.equal(live.replay, false);
    await bob.waitFor("burst-end");
    assert.equal(bob.frames.length, 30);
    assert.equal(pusher.sent.length, 1);

    alice.close();
    bob.close();
  });
});

test("a burst still in progress when the recipient joins continues live", async () => {
  await withServer(async (s) => {
    const alice = client(s, "alice");
    const bob = client(s, "bob");
    await alice.register("Alice");
    await bob.register("Bob");
    await alice.connect();
    await bob.connect();

    const burstId = "b1";
    alice.send({ type: "talk-start", to: "bob", burstId });
    const granted = await alice.waitFor("floor-granted");
    const ring = await bob.waitFor("ring");
    assert.equal(ring.conversationId, granted.conversationId);

    for (let seq = 0; seq < 3; seq++) alice.sendFrame(2, seq, Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 50));
    bob.send({ type: "join", conversationId: ring.conversationId });
    await bob.waitFor("burst-start");
    for (let seq = 3; seq < 6; seq++) alice.sendFrame(2, seq, Buffer.alloc(640));
    alice.send({ type: "talk-end", burstId });
    await bob.waitFor("burst-end");
    assert.deepEqual(
      bob.frames.map((f) => f.readUInt32BE(1)),
      [0, 1, 2, 3, 4, 5],
    );
    alice.close();
    bob.close();
  });
});

test("half duplex: the floor is denied while the other side is talking", async () => {
  await withServer(async (s) => {
    const alice = client(s, "alice");
    const bob = client(s, "bob");
    await alice.register("Alice");
    await bob.register("Bob");
    await alice.connect();
    await bob.connect();

    alice.send({ type: "talk-start", to: "bob", burstId: "a1" });
    const { conversationId } = await alice.waitFor("floor-granted");
    const ring = await bob.waitFor("ring");
    bob.send({ type: "join", conversationId: ring.conversationId });
    await bob.waitFor("joined");

    bob.send({ type: "talk-start", to: "alice", burstId: "b1" });
    const denied = await bob.waitFor("floor-denied");
    assert.equal(denied.holder, "alice");

    alice.send({ type: "talk-end", burstId: "a1" });
    await bob.waitFor("burst-end");
    bob.send({ type: "talk-start", to: "alice", burstId: "b2" });
    const granted = await bob.waitFor("floor-granted");
    assert.equal(granted.conversationId, conversationId);
    assert.equal(granted.pushed, false);
    alice.close();
    bob.close();
  });
});

test("after both leave, the next talk rings again in a new conversation", async () => {
  await withServer(async (s) => {
    const alice = client(s, "alice");
    const bob = client(s, "bob");
    await alice.register("Alice");
    await bob.register("Bob");
    await alice.connect();
    await bob.connect();

    const first = await alice.talk("bob", pcm(2), { realtime: false });
    const ring = await bob.waitFor("ring");
    bob.send({ type: "join", conversationId: ring.conversationId });
    await bob.waitFor("burst-end");
    bob.send({ type: "leave", conversationId: first.conversationId });
    alice.send({ type: "leave", conversationId: first.conversationId });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(s.relay.snapshot(), []);

    const second = await alice.talk("bob", pcm(2), { realtime: false });
    assert.equal(second.pushed, true);
    assert.notEqual(second.conversationId, first.conversationId);
    await bob.waitFor("ring");
    alice.close();
    bob.close();
  });
});

test("dry-run pushes can be collected once by the simulator", async () => {
  await withServer(async (s) => {
    const alice = client(s, "alice");
    const sim = client(s, "watch-sim");
    await alice.register("Alice");
    await sim.register("Simulator", "sim:watch-sim");
    await alice.connect();
    const { conversationId } = await alice.talk("watch-sim", pcm(2), { realtime: false });

    const rings = await sim.api("GET", "/v1/debug/rings?userId=watch-sim");
    assert.equal(rings.length, 1);
    assert.equal(rings[0].conversationId, conversationId);
    assert.deepEqual(await sim.api("GET", "/v1/debug/rings?userId=watch-sim"), []);
    alice.close();
  });
});

test("metrics uploads merge into one timeline with intervals", async () => {
  await withServer(async (s) => {
    const alice = client(s, "alice");
    const bob = client(s, "bob");
    await alice.register("Alice");
    await bob.register("Bob");
    await alice.connect();
    await bob.connect();

    const { conversationId } = await alice.talk("bob", pcm(2), { realtime: false });
    await bob.waitFor("ring");
    bob.mark("pushReceived");
    bob.mark("callReported");
    bob.mark("answerTapped");
    bob.send({ type: "join", conversationId });
    await bob.waitFor("burst-start");
    bob.mark("firstAudioScheduled");
    await alice.uploadMetrics(conversationId, "sender");
    await bob.uploadMetrics(conversationId, "receiver");

    const report = await alice.api("GET", `/v1/metrics/${conversationId}`);
    const names = report.timeline.map((e: { source: string; name: string }) => `${e.source}.${e.name}`);
    for (const expected of ["sender.talkPressed", "server.pushSent", "receiver.answerTapped", "server.receiverJoined"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    const labels = report.attempts[0].intervals.map((i: { label: string }) => i.label);
    assert.ok(labels.includes("Watch: answer → first audio"));
    alice.close();
    bob.close();
  });
});
