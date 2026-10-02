import { test } from "node:test";
import assert from "node:assert/strict";
import type { Accounts } from "../src/accounts.ts";
import { RecordParser, encodeJSONRecord } from "../src/records.ts";
import { befriend, call, clientHeaders, friends, pcm, user, withServer, type TestServer, type TestUser } from "./harness.ts";

// A real-looking APNs token: rings go through the pusher, and the push carries the ring.
const WATCH_PUSH = { apns: "alert", token: "abcdef0123456789" } as const;

// The ring in the nth push (APNs custom keys).
function pushed(h: TestServer, n: number): Record<string, unknown> & { ringId: string; conversationId: string; aps: Record<string, unknown> } {
  return h.pusher.sent[n].payload as never;
}

// Ring calls go through admission, like the app's.
function ringCall(h: TestServer, who: TestUser, method: string, path: string, body?: unknown) {
  return call(h.url, method, path, who.token, body, clientHeaders(who.kind));
}

test("the relay refuses calls without a session token, and the diagnostics without the admin token", async () => {
  await withServer(async (h) => {
    const alice = await user(h, "Alice");
    for (const path of ["/v2/rings/pending", "/v2/relay/stream", "/v2/time"]) {
      assert.equal((await call(h.url, "GET", path, null, undefined, clientHeaders("watchos"))).status, 401, path);
      assert.equal((await call(h.url, "GET", path, `${alice.token}x`, undefined, clientHeaders("watchos"))).status, 401, path);
    }
    // An account's session token isn't the operator's.
    assert.equal((await call(h.url, "GET", "/admin/status", null)).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/status", alice.token)).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/status", "admin")).status, 200);
  });
});

test("ring-to-start: rings an absent recipient, buffers, and replays on join", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const a = alice.client();
    await a.connect();

    const { conversationId, pushed: rang } = await a.talk(bob.id, pcm(25), { realtime: false });
    assert.equal(rang, true);
    assert.equal(h.pusher.sent.length, 1);
    const push = h.pusher.sent[0];
    const payload = pushed(h, 0);
    assert.equal(payload.conversationId, conversationId);
    assert.equal(payload.from, alice.id);
    assert.equal(payload.fromName, "Alice");
    assert.match(payload.ringId, /^r_/);
    assert.equal(payload.aps["interruption-level"], "time-sensitive");
    // The notification expires when the relay abandons the ring (35 s by default).
    assert.equal(push.expiresAt - (payload.pushSentAt as number), 35_000);

    // Bob's watch wakes, the user answers, the app connects and joins that ring.
    const b = bob.client();
    await b.connect();
    b.send({ type: "join", conversationId, ringId: payload.ringId });
    const joined = await b.waitFor("joined");
    assert.equal(joined.replayBursts, 1);
    assert.equal(joined.peer, alice.id);
    const start = await b.waitFor("burst-start");
    assert.equal(start.replay, true);
    assert.equal(start.codec, "pcm16le16k");
    await b.waitFor("burst-end");
    assert.equal(b.frames.length, 25);
    assert.deepEqual(
      b.frames.map((f) => f.readUInt32BE(1)),
      Array.from({ length: 25 }, (_, i) => i),
    );

    // Within the conversation window, Alice's next burst is live and doesn't ring again.
    const second = await a.talk(bob.id, pcm(5), { realtime: false });
    assert.equal(second.pushed, false);
    assert.equal(second.conversationId, conversationId);
    const live = await b.waitFor("burst-start");
    assert.equal(live.replay, false);
    await b.waitFor("burst-end");
    assert.equal(b.frames.length, 30);
    assert.equal(h.pusher.sent.length, 1);

    a.close();
    b.close();
  });
});

test("a burst still in progress when the recipient joins continues live", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    const burstId = "b1";
    a.send({ type: "talk-start", to: bob.id, burstId, codec: "pcm16le16k" });
    const granted = await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    assert.equal(ring.conversationId, granted.conversationId);

    for (let seq = 0; seq < 3; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 50));
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 3; seq < 6; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    a.send({ type: "talk-end", burstId });
    await b.waitFor("burst-end");
    assert.deepEqual(
      b.frames.map((f) => f.readUInt32BE(1)),
      [0, 1, 2, 3, 4, 5],
    );
    a.close();
    b.close();
  });
});

test("a member whose stream drops mid-burst rejoins and resumes from the first frame missed", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    const burstId = "b1";
    a.send({ type: "talk-start", to: bob.id, burstId, codec: "pcm16le16k" });
    await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 3; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(b.frames.map((f) => f.readUInt32BE(1)), [0, 1, 2]);

    // Run 106: the stream dies (airplane mode) while the friend keeps talking and finishes.
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 3; seq < 8; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    a.send({ type: "talk-end", burstId });
    await new Promise((r) => setTimeout(r, 50));

    // Back online: a fresh stream that rejoins (no ring: he was already in it) and asks for the
    // burst from frame 3.
    const back = bob.client();
    await back.connect();
    back.send({ type: "join", conversationId: ring.conversationId, resume: { burstId, fromSeq: 3 } });
    const joined = await back.waitFor("joined");
    assert.equal(joined.replayBursts, 1);
    assert.equal(joined.resumedFrames, 5);
    const start = await back.waitFor("burst-start");
    assert.equal(start.burstId, burstId);
    assert.equal(start.resumed, true);
    await back.waitFor("burst-end");
    assert.deepEqual(back.frames.map((f) => f.readUInt32BE(1)), [3, 4, 5, 6, 7]);
    a.close();
    back.close();
  });
});

test("a rejoin can resume a burst that's still going, then hear the rest live", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client({ transport: "http" });
    await a.connect();
    await b.connect();

    const burstId = "b1";
    a.send({ type: "talk-start", to: bob.id, burstId, codec: "pcm16le16k" });
    await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 2; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 50));
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 2; seq < 4; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    await new Promise((r) => setTimeout(r, 50));

    // The apps rejoin in the request that opens the stream (?join=…&resumeBurst=…&resumeFrom=…).
    const back = bob.client({ transport: "http" });
    await back.connect(ring.conversationId, { burstId, fromSeq: 2 });
    assert.equal((await back.waitFor("joined")).resumedFrames, 2);
    await back.waitFor("burst-start");
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 4; seq < 6; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    a.send({ type: "talk-end", burstId });
    await back.waitFor("burst-end");
    assert.deepEqual(back.frames.map((f) => f.readUInt32BE(1)), [2, 3, 4, 5]);
    a.close();
    back.close();
  });
});

test("half duplex: the floor is denied while the other side is talking", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    a.send({ type: "talk-start", to: bob.id, burstId: "a1", codec: "pcm16le16k" });
    const { conversationId } = await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("joined");

    b.send({ type: "talk-start", to: alice.id, burstId: "b1", codec: "pcm16le16k" });
    const denied = await b.waitFor("floor-denied");
    assert.equal(denied.holder, alice.id);

    a.send({ type: "talk-end", burstId: "a1" });
    await b.waitFor("burst-end");
    b.send({ type: "talk-start", to: alice.id, burstId: "b2", codec: "pcm16le16k" });
    const granted = await b.waitFor("floor-granted");
    assert.equal(granted.conversationId, conversationId);
    assert.equal(granted.pushed, false);
    a.close();
    b.close();
  });
});

test("after both leave, the next talk rings again in a new conversation", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    const first = await a.talk(bob.id, pcm(2), { realtime: false });
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-end");
    b.send({ type: "leave", conversationId: first.conversationId });
    a.send({ type: "leave", conversationId: first.conversationId });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(h.server.relay.snapshot(), []);

    const second = await a.talk(bob.id, pcm(2), { realtime: false });
    assert.equal(second.pushed, true);
    assert.notEqual(second.conversationId, first.conversationId);
    const next = await b.waitFor("ring");
    assert.notEqual(next.ringId, ring.ringId);
    a.close();
    b.close();
  });
});

test("an unanswered ring drops the unheard audio and the next talk rings again", async () => {
  await withServer(
    async (h) => {
      const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
      const a = alice.client();
      await a.connect();

      const first = await a.talk(bob.id, pcm(10), { realtime: false });
      assert.equal(first.pushed, true);
      // A second burst while the ring is pending doesn't ring again.
      const queued = await a.talk(bob.id, pcm(5), { realtime: false });
      assert.equal(queued.pushed, false);

      const timeout = await a.waitFor("ring-timeout");
      assert.equal(timeout.peer, bob.id);
      assert.equal(timeout.droppedBursts, 2);
      // The watch's "Tap to listen" is replaced: same collapse ID, no sound, no ring ID (so the
      // app doesn't take it for a ring), passive.
      assert.equal(h.pusher.sent.length, 2);
      const [ring, missed] = h.pusher.sent;
      const notice = missed.payload as Record<string, unknown> & { aps: Record<string, unknown> };
      assert.equal(missed.collapseId, ring.collapseId);
      assert.deepEqual(notice.aps.alert, { title: "Alice", body: "Missed message" });
      assert.equal(notice.aps["interruption-level"], "passive");
      assert.equal(notice.aps.sound, undefined);
      assert.equal(notice.ringId, undefined);
      assert.deepEqual([notice.missed, notice.conversationId, notice.from], [1, first.conversationId, alice.id]);
      assert.ok(missed.expiresAt > Date.now() + 23 * 3600_000);

      // Bob answering late hears nothing stale: that ring has ended.
      const late = pushed(h, 0).ringId;
      const b = bob.client();
      await b.connect();
      b.send({ type: "join", conversationId: first.conversationId, ringId: late });
      assert.equal((await b.waitFor("error")).code, "ring-expired");

      const next = await a.talk(bob.id, pcm(2), { realtime: false });
      assert.equal(next.pushed, true);
      assert.equal(h.pusher.sent.length, 3);
      const ringId = pushed(h, 2).ringId;
      assert.notEqual(ringId, late);
      b.send({ type: "join", conversationId: next.conversationId, ringId });
      assert.equal((await b.waitFor("joined")).replayBursts, 1);
      await b.waitFor("burst-end");
      assert.equal(b.frames.length, 2);
      a.close();
      b.close();
    },
    { ringTimeoutMs: 100 },
  );
});

test("a ring that times out is no longer pending", async () => {
  await withServer(
    async (h) => {
      const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
      const a = alice.client();
      await a.connect();
      const { conversationId } = await a.talk(bob.id, pcm(2), { realtime: false });
      const pending = await ringCall(h, bob, "GET", "/v2/rings/pending");
      assert.deepEqual(pending.body.rings.map((r: { conversationId: string }) => r.conversationId), [conversationId]);
      await a.waitFor("ring-timeout");
      assert.deepEqual((await ringCall(h, bob, "GET", "/v2/rings/pending")).body.rings, []);
      a.close();
    },
    { ringTimeoutMs: 50 },
  );
});

test("reporting an answer keeps the audio while the socket is slow to open", async () => {
  await withServer(
    async (h) => {
      const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
      const a = alice.client();
      const b = bob.client();
      await a.connect();
      await b.connect(); // stands in for the watch's socket; only the join is timed
      const { conversationId } = await a.talk(bob.id, pcm(4), { realtime: false });
      const { ringId } = pushed(h, 0);

      await new Promise((r) => setTimeout(r, 50));
      const answered = await ringCall(h, bob, "POST", "/v2/rings/answer", { conversationId, ringId });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      // Joined at ~300 ms: past the 150 ms ring timeout, inside the 600 ms join allowance.
      await new Promise((r) => setTimeout(r, 250));
      b.send({ type: "join", conversationId, ringId });
      assert.equal((await b.waitFor("joined")).replayBursts, 1);
      await b.waitFor("burst-end");
      assert.equal(b.frames.length, 4);
      a.close();
      b.close();
    },
    { ringTimeoutMs: 150, answerJoinTimeoutMs: 600 },
  );
});

test("an answer that never joins still times out", async () => {
  await withServer(
    async (h) => {
      const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
      const a = alice.client();
      await a.connect();
      const { conversationId } = await a.talk(bob.id, pcm(2), { realtime: false });
      const answered = await ringCall(h, bob, "POST", "/v2/rings/answer", { conversationId, ringId: pushed(h, 0).ringId });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      const timeout = await a.waitFor("ring-timeout");
      assert.equal(timeout.droppedBursts, 1);
      a.close();
    },
    { ringTimeoutMs: 50, answerJoinTimeoutMs: 100 },
  );
});

test("metrics uploads merge into one timeline with intervals", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    const { conversationId } = await a.talk(bob.id, pcm(2), { realtime: false });
    const ring = await b.waitFor("ring");
    b.mark("pushReceived");
    b.mark("callReported");
    b.mark("answerTapped");
    b.send({ type: "join", conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    b.mark("firstAudioScheduled");
    await a.uploadMetrics(conversationId, "sender");
    await b.uploadMetrics(conversationId, "receiver");

    const report = (await call(h.url, "GET", `/admin/metrics/${conversationId}`, "admin")).body;
    const names = report.timeline.map((e: { source: string; name: string }) => `${e.source}.${e.name}`);
    for (const expected of ["sender.talkPressed", "server.pushSent", "receiver.answerTapped", "server.receiverJoined"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    const labels = report.attempts[0].intervals.map((i: { label: string }) => i.label);
    assert.ok(labels.includes("Watch: answer → first audio"));
    a.close();
    b.close();
  });
});

// Ring lookups that take a while, or fail, like a remote database having a bad day.
function slowRingLookups(accounts: Accounts, delayMs: number): { lookups: number; fail: boolean } {
  const state = { lookups: 0, fail: false };
  const lookup = accounts.ringLookup.bind(accounts);
  accounts.ringLookup = async (from, to) => {
    state.lookups++;
    await new Promise((r) => setTimeout(r, delayMs));
    if (state.fail) throw new Error("store unavailable");
    return lookup(from, to);
  };
  return state;
}

test("a slow ring lookup buffers early audio and rings only once", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const store = slowRingLookups(h.accounts, 150);
    const a = alice.client();
    await a.connect();

    // Frames sent before the floor is granted, and a second burst, while the lookup runs.
    a.send({ type: "talk-start", to: bob.id, burstId: "a1", codec: "pcm16le16k" });
    for (let seq = 0; seq < 3; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    a.send({ type: "talk-end", burstId: "a1" });
    a.send({ type: "talk-start", to: bob.id, burstId: "a2", codec: "pcm16le16k" });
    const first = await a.waitFor("floor-granted", (m) => m.burstId === "a1");
    const second = await a.waitFor("floor-granted", (m) => m.burstId === "a2");
    assert.equal(first.pushed, true);
    assert.equal(second.pushed, false);
    assert.equal(h.pusher.sent.length, 1);
    assert.equal(store.lookups, 1);
    a.send({ type: "talk-end", burstId: "a2" });

    const b = bob.client();
    await b.connect();
    b.send({ type: "join", conversationId: first.conversationId, ringId: pushed(h, 0).ringId });
    const joined = await b.waitFor("joined");
    assert.equal(joined.replayBursts, 2);
    await b.waitFor("burst-end", (m) => m.burstId === "a1");
    assert.equal(b.frames.length, 3);
    a.close();
    b.close();
  });
});

test("a failed ring lookup grants the floor without ringing", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const store = slowRingLookups(h.accounts, 0);
    const a = alice.client();
    await a.connect();
    store.fail = true;
    const { conversationId, pushed: rang } = await a.talk(bob.id, pcm(2), { realtime: false });
    assert.equal(rang, false);
    assert.equal(h.pusher.sent.length, 0);
    const timeline = await h.server.metrics.timeline(conversationId);
    assert.ok(timeline.some((e) => e.name === "pushFailed" && e.detail?.includes("store unavailable")));
    a.close();
  });
});

test("prefetch: a second push once the first burst ends, and the buffered audio to download", async () => {
  await withServer(
    async (h) => {
      const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
      const a = alice.client();
      await a.connect();

      const { conversationId } = await a.talk(bob.id, pcm(10), { realtime: false });
      for (let i = 0; i < 50 && h.pusher.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(h.pusher.sent.length, 2);
      const { ringId } = pushed(h, 0);
      const prefetch = pushed(h, 1);
      assert.equal(prefetch.prefetch, 1);
      assert.equal(prefetch.conversationId, conversationId);
      // The same ring, so the download and the tap can name it.
      assert.equal(prefetch.ringId, ringId);
      assert.equal(prefetch.aps["mutable-content"], 1);
      assert.equal(prefetch.aps.sound, undefined);
      assert.equal(h.pusher.sent[1].collapseId, h.pusher.sent[0].collapseId);

      const res = await fetch(new URL(`/v2/rings/audio?conversationId=${conversationId}&ringId=${ringId}`, h.url), {
        headers: { authorization: `Bearer ${bob.token}`, ...clientHeaders(bob.kind) },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-frames"), "10");
      assert.equal(res.headers.get("x-ring-id"), ringId);
      const records = new RecordParser().push(Buffer.from(await res.arrayBuffer()));
      assert.equal(records.length, 12); // burst-start, 10 frames, burst-end
      assert.equal(JSON.parse(records[0].payload.toString()).type, "burst-start");
      assert.equal(records[1].payload.readUInt32BE(1), 0);

      // Downloading doesn't count as heard: the join still replays everything.
      const b = bob.client();
      await b.connect();
      b.send({ type: "join", conversationId, ringId });
      assert.equal((await b.waitFor("joined")).replayBursts, 1);
      await b.waitFor("burst-end");
      assert.equal(b.frames.length, 10);
      a.close();
      b.close();
    },
    { prefetchPushAfterMs: 3_000 },
  );
});

test("prefetch: no second push if the recipient joined first, and none unless enabled", async () => {
  for (const prefetchPushAfterMs of [50, 0]) {
    await withServer(
      async (h) => {
        const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
        const a = alice.client();
        const b = bob.client();
        await a.connect();
        await b.connect();
        a.send({ type: "talk-start", to: bob.id, burstId: "a1", codec: "pcm16le16k" });
        const { conversationId } = await a.waitFor("floor-granted");
        b.send({ type: "join", conversationId, ringId: pushed(h, 0).ringId });
        await b.waitFor("joined");
        a.send({ type: "talk-end", burstId: "a1" });
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(h.pusher.sent.length, 1);
        a.close();
        b.close();
      },
      { prefetchPushAfterMs },
    );
  }
});

test("prefetch: other users can't download a conversation's audio", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    // Eve is Alice's friend too, but not in Alice and Bob's conversation.
    const eve = await user(h, "Eve");
    await befriend(h, alice, eve);
    const a = alice.client();
    await a.connect();
    const { conversationId } = await a.talk(bob.id, pcm(2), { realtime: false });
    const { ringId } = pushed(h, 0);
    const audio = (who: TestUser, id: string) =>
      fetch(new URL(`/v2/rings/audio?conversationId=${id}&ringId=${ringId}`, h.url), {
        headers: { authorization: `Bearer ${who.token}`, ...clientHeaders(who.kind) },
      });
    assert.equal((await audio(eve, conversationId)).status, 404);
    assert.equal((await audio(eve, "nope")).status, 410);
    // The sender's ring isn't hers to download either.
    assert.equal((await audio(alice, conversationId)).status, 410);
    assert.equal((await audio(bob, conversationId)).status, 200);
    a.close();
  });
});

test("malformed messages get an error, and the relay keeps going", async () => {
  await withServer(async (h) => {
    const bob = await user(h, "Bob");
    const b = bob.client();
    await b.connect();
    // null is valid JSON; so are messages missing their fields, and a talk-start without its codec.
    const bad = [null, 42, [], {}, { type: "talk-start" }, { type: "talk-start", to: "x", burstId: "b" }, { type: "join", conversationId: 7 }, { type: "join", conversationId: "c", ringId: "nope" }, { type: "nope" }];
    for (const message of bad) b.send(message as never);
    for (let i = 0; i < bad.length; i++) {
      const error = await b.waitFor("error", (m) => m.message === "invalid message");
      assert.equal(error.code, "unknown-message");
    }

    // The HTTP transport: the POST is refused.
    const carol = await user(h, "Carol");
    const watch = carol.client({ transport: "http" });
    await watch.connect();
    const res = await fetch(new URL("/v2/relay/send", h.url), {
      method: "POST",
      headers: { authorization: `Bearer ${carol.token}` },
      body: encodeJSONRecord(null),
    });
    assert.equal(res.status, 400);

    b.send({ type: "hello", clientTime: 1 });
    assert.equal((await b.waitFor("hello-ack")).clientTime, 1);
    watch.close();
    b.close();
  });
});

test("frames the apps can't decode aren't relayed", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();
    a.send({ type: "talk-start", to: bob.id, burstId: "b1", codec: "pcm16le16k" });
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    a.sendFrame(2, 0, Buffer.alloc(1282)); // PCM that isn't 320 samples
    a.sendFrame(2, 1, Buffer.alloc(0));
    a.sendFrame(1, 2, Buffer.alloc(2000)); // bigger than any Opus packet
    a.sendFrame(9, 3, Buffer.alloc(640)); // no such codec
    a.sendFrame(2, 4, Buffer.alloc(640));
    a.sendFrame(1, 5, Buffer.alloc(60)); // Opus, but the burst is PCM
    a.send({ type: "talk-end", burstId: "b1" });
    await b.waitFor("burst-end");
    assert.deepEqual(b.frames.map((f) => f.readUInt32BE(1)), [4]);

    // An Opus burst takes Opus packets, up to the largest there is.
    b.frames.length = 0;
    a.send({ type: "talk-start", to: bob.id, burstId: "b2", codec: "opus16k" });
    assert.equal((await b.waitFor("burst-start")).codec, "opus16k");
    a.sendFrame(1, 0, Buffer.alloc(2000));
    a.sendFrame(2, 1, Buffer.alloc(640));
    a.sendFrame(1, 2, Buffer.alloc(60));
    a.sendFrame(1, 3, Buffer.alloc(1275));
    a.send({ type: "talk-end", burstId: "b2" });
    await b.waitFor("burst-end");
    assert.deepEqual(b.frames.map((f) => f.readUInt32BE(1)), [2, 3]);
    a.close();
    b.close();
  });
});

test("audio heard live isn't kept, and a burst that never ends is ended", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();
    a.send({ type: "talk-start", to: bob.id, burstId: "b1", codec: "pcm16le16k" });
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 5; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    while (b.frames.length < 5) await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.server.relay.snapshot()[0].floor, alice.id);
    assert.equal(h.server.relay.snapshot()[0].bufferedBytes, 0);

    // No talk-end: the relay ends the burst at maxBurstMs, frees the floor and says why.
    const error = await a.waitFor("error");
    assert.deepEqual([error.code, error.message], ["burst-too-long", "burst too long"]);
    await b.waitFor("burst-end");
    assert.equal(h.server.relay.snapshot()[0].floor, null);
    a.close();
    b.close();
  }, { maxBurstMs: 300 });
});

test("a conversation holds only so much audio for someone who hasn't heard it", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const a = alice.client();
    await a.connect();
    // Bob is rung but doesn't answer, so it buffers: room for 5 frames.
    a.send({ type: "talk-start", to: bob.id, burstId: "b1", codec: "pcm16le16k" });
    assert.equal((await a.waitFor("floor-granted")).pushed, true);
    for (let seq = 0; seq < 8; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    const error = await a.waitFor("error");
    assert.deepEqual([error.code, error.message], ["too-much-audio", "too much audio waiting"]);
    assert.equal(h.server.relay.snapshot()[0].bufferedBytes, 5 * 645);
    assert.equal(h.server.relay.snapshot()[0].floor, null);
    a.close();
  }, { maxBufferedBytes: 5 * 645 + 100 });
});

test("a burst sent faster than real time is cut off at the longest burst's worth of frames", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const a = alice.client();
    await a.connect();
    a.send({ type: "talk-start", to: bob.id, burstId: "b1", codec: "pcm16le16k" });
    await a.waitFor("floor-granted");
    // 10 frames = 200 ms; the 11th ends the burst long before its timer would.
    for (let seq = 0; seq < 15; seq++) a.sendFrame(2, seq, Buffer.alloc(640));
    const error = await a.waitFor("error", () => true, 150);
    assert.deepEqual([error.code, error.message], ["burst-too-long", "burst too long"]);
    assert.equal(h.server.relay.snapshot()[0].bufferedBytes, 10 * 645);
    a.close();
  }, { maxBurstMs: 200 });
});
