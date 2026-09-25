import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { SpikeClient } from "../tools/client.ts";

async function withServer(
  fn: (s: RunningServer, pusher: DryRunPusher) => Promise<void>,
  options: { ringTimeoutMs?: number; answerJoinTimeoutMs?: number } = {},
): Promise<void> {
  const pusher = new DryRunPusher();
  const running = await startServer({ port: 0, dataDir: null, token: "secret", pusher, ...options });
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
    const push = pusher.sent[0];
    const payload = push.payload as Record<string, unknown> & { aps: Record<string, unknown> };
    assert.equal(payload.conversationId, conversationId);
    assert.equal(payload.fromName, "Alice");
    assert.equal(payload.aps["interruption-level"], "time-sensitive");
    // The notification expires when the relay abandons the ring (35 s by default).
    assert.equal(push.expiresAt - (payload.pushSentAt as number), 35_000);

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

test("an unanswered ring drops the unheard audio and the next talk rings again", async () => {
  await withServer(
    async (s, pusher) => {
      const alice = client(s, "alice");
      const bob = client(s, "bob");
      await alice.register("Alice");
      await bob.register("Bob", "abcdef0123456789");
      await alice.connect();

      const first = await alice.talk("bob", pcm(10), { realtime: false });
      assert.equal(first.pushed, true);
      // A second burst while the ring is pending doesn't ring again.
      const queued = await alice.talk("bob", pcm(5), { realtime: false });
      assert.equal(queued.pushed, false);

      const timeout = await alice.waitFor("ring-timeout");
      assert.equal(timeout.peer, "bob");
      assert.equal(timeout.droppedBursts, 2);

      // Bob answering late hears nothing stale.
      await bob.connect();
      bob.send({ type: "join", conversationId: first.conversationId });
      const joined = await bob.waitFor("joined");
      assert.equal(joined.replayBursts, 0);
      bob.send({ type: "leave", conversationId: first.conversationId });
      await new Promise((r) => setTimeout(r, 20));

      const next = await alice.talk("bob", pcm(2), { realtime: false });
      assert.equal(next.pushed, true);
      assert.equal(pusher.sent.length, 2);
      alice.close();
      bob.close();
    },
    { ringTimeoutMs: 100 },
  );
});

test("rings for a polling device are collected once, and never sent to APNs", async () => {
  await withServer(async (s, pusher) => {
    const alice = client(s, "alice");
    const watch = client(s, "watch-nopush");
    await alice.register("Alice");
    await watch.register("No-push watch", "poll:watch-nopush");
    await alice.connect();
    const { conversationId, pushed } = await alice.talk("watch-nopush", pcm(2), { realtime: false });
    assert.equal(pushed, true);
    assert.equal(pusher.sent.length, 0);

    const rings = await watch.api("GET", "/v1/rings/poll?userId=watch-nopush");
    assert.equal(rings.length, 1);
    assert.equal(rings[0].conversationId, conversationId);
    assert.deepEqual(await watch.api("GET", "/v1/rings/poll?userId=watch-nopush"), []);
    alice.close();
  });
});

test("a ring that times out before it's collected is withdrawn", async () => {
  await withServer(
    async (s) => {
      const alice = client(s, "alice");
      const watch = client(s, "watch-nopush");
      await alice.register("Alice");
      await watch.register("No-push watch", "poll:watch-nopush");
      await alice.connect();
      await alice.talk("watch-nopush", pcm(2), { realtime: false });
      await alice.waitFor("ring-timeout");
      assert.deepEqual(await watch.api("GET", "/v1/rings/poll?userId=watch-nopush"), []);
      alice.close();
    },
    { ringTimeoutMs: 50 },
  );
});

test("a polled ring's timeout restarts when the watch collects it", async () => {
  await withServer(
    async (s) => {
      const alice = client(s, "alice");
      const watch = client(s, "watch-nopush");
      await alice.register("Alice");
      await watch.register("No-push watch", "poll:watch-nopush");
      await alice.connect();
      await watch.connect(); // connected but not joined, so only the join is timed
      const { conversationId } = await alice.talk("watch-nopush", pcm(3), { realtime: false });

      // Collected at ~200 ms, joined at ~650 ms: past a 600 ms timeout counted from the
      // push, but inside it counted from collection (~800 ms).
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await watch.api("GET", "/v1/rings/poll?userId=watch-nopush")).length, 1);
      await new Promise((r) => setTimeout(r, 450));
      watch.send({ type: "join", conversationId });
      assert.equal((await watch.waitFor("joined")).replayBursts, 1);
      alice.close();
      watch.close();
    },
    { ringTimeoutMs: 600 },
  );
});

test("reporting an answer keeps the audio while the socket is slow to open", async () => {
  await withServer(
    async (s) => {
      const alice = client(s, "alice");
      const bob = client(s, "bob");
      await alice.register("Alice");
      await bob.register("Bob", "abcdef0123456789");
      await alice.connect();
      await bob.connect(); // stands in for the watch's socket; only the join is timed
      const { conversationId } = await alice.talk("bob", pcm(4), { realtime: false });

      await new Promise((r) => setTimeout(r, 50));
      await bob.api("POST", "/v1/rings/answer", { userId: "bob", conversationId });
      // Joined at ~300 ms: past the 150 ms ring timeout, inside the 600 ms join allowance.
      await new Promise((r) => setTimeout(r, 250));
      bob.send({ type: "join", conversationId });
      assert.equal((await bob.waitFor("joined")).replayBursts, 1);
      await bob.waitFor("burst-end");
      assert.equal(bob.frames.length, 4);
      alice.close();
      bob.close();
    },
    { ringTimeoutMs: 150, answerJoinTimeoutMs: 600 },
  );
});

test("an answer that never joins still times out", async () => {
  await withServer(
    async (s) => {
      const alice = client(s, "alice");
      const bob = client(s, "bob");
      await alice.register("Alice");
      await bob.register("Bob", "abcdef0123456789");
      await alice.connect();
      const { conversationId } = await alice.talk("bob", pcm(2), { realtime: false });
      await bob.api("POST", "/v1/rings/answer", { userId: "bob", conversationId });
      const timeout = await alice.waitFor("ring-timeout");
      assert.equal(timeout.droppedBursts, 1);
      alice.close();
    },
    { ringTimeoutMs: 50, answerJoinTimeoutMs: 100 },
  );
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

test("registration still accepts the spike watch's voipToken field", async () => {
  await withServer(async (s) => {
    const res = await fetch(`http://localhost:${s.port}/v1/devices`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ userId: "watch", name: "Watch", voipToken: "poll:watch" }),
    });
    assert.equal(res.status, 200);
    assert.equal(s.devices.get("watch")?.pushToken, "poll:watch");
  });
});
