import { test } from "node:test";
import assert from "node:assert/strict";
import type { AccountDevice, Accounts } from "../src/accounts.ts";
import { RecordParser, encodeJSONRecord } from "../src/records.ts";
import { DryRunPusher } from "../src/apns.ts";
import { DEFAULT_CAPABILITIES, formFactorOf, type ClientKind, type CodecName, type Delivery } from "../src/contract.ts";
import { randomUUID } from "node:crypto";
import { sealBundle, usableKeys, type FriendKeysJSON } from "../src/e2ee.ts";
import type { EndpointKeys } from "../src/endpoint-keys.ts";
import { Codec, type ClientMessage, type ServerMessage } from "../src/protocol.ts";
import { Relay, type Peer } from "../src/relay.ts";
import { JsonMetricsStore } from "../src/store.ts";
import type { SpikeClient } from "../tools/client.ts";
import { befriend, call, clientHeaders, deviceKeys, friends, pcm, user, withServer, type TestServer, type TestUser } from "./harness.ts";

// A real-looking APNs token: rings go through the pusher, and the push carries the ring.
const WATCH_PUSH = { apns: "alert", token: "abcdef0123456789" } as const;

// The ring in the nth push (APNs custom keys).
function pushed(h: TestServer, n: number): Record<string, unknown> & { ringId: string; conversationId: string; aps: Record<string, unknown> } {
  return h.pusher.sent[n].payload as never;
}

// A Talk sealed to the friend's keys, as the apps send it. Returns what sends the burst's
// frames, sealed: by default a frame of its codec, or any payload in any codec, to send frames
// the apps couldn't decode.
async function talkStart(client: SpikeClient, to: string, burstId: string, codec: "pcm16le16k" | "opus16k" = "pcm16le16k") {
  const { message, cipher } = await client.sealedTalkStart(to, burstId, codec);
  client.send(message);
  return (seq: number, payload = Buffer.alloc(codec === "pcm16le16k" ? 640 : 60), frameCodec: number = Codec[codec]) =>
    client.sendSealedFrame(cipher, frameCodec, seq, payload);
}

// A sealed PCM frame on the wire: header, 640 bytes and the 16-byte tag.
const SEALED_PCM = 5 + 640 + 16;

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
    const frame = await talkStart(a, bob.id, burstId);
    const granted = await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    assert.equal(ring.conversationId, granted.conversationId);

    for (let seq = 0; seq < 3; seq++) frame(seq);
    await new Promise((r) => setTimeout(r, 50));
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 3; seq < 6; seq++) frame(seq);
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
    const frame = await talkStart(a, bob.id, burstId);
    await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 3; seq++) frame(seq);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(b.frames.map((f) => f.readUInt32BE(1)), [0, 1, 2]);

    // Run 106: the stream dies (airplane mode) while the friend keeps talking and finishes.
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 3; seq < 8; seq++) frame(seq);
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
    const frame = await talkStart(a, bob.id, burstId);
    await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 2; seq++) frame(seq);
    await new Promise((r) => setTimeout(r, 50));
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 2; seq < 4; seq++) frame(seq);
    await new Promise((r) => setTimeout(r, 50));

    // The apps rejoin in the request that opens the stream (?join=…&resumeBurst=…&resumeFrom=…).
    const back = bob.client({ transport: "http" });
    await back.connect(ring.conversationId, { burstId, fromSeq: 2 });
    assert.equal((await back.waitFor("joined")).resumedFrames, 2);
    await back.waitFor("burst-start");
    await new Promise((r) => setTimeout(r, 50));
    for (let seq = 4; seq < 6; seq++) frame(seq);
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

    await talkStart(a, bob.id, "a1");
    const { conversationId } = await a.waitFor("floor-granted");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("joined");

    await talkStart(b, alice.id, "b1");
    const denied = await b.waitFor("floor-denied");
    assert.equal(denied.holder, alice.id);

    a.send({ type: "talk-end", burstId: "a1" });
    await b.waitFor("burst-end");
    await talkStart(b, alice.id, "b2");
    const granted = await b.waitFor("floor-granted");
    assert.equal(granted.conversationId, conversationId);
    assert.equal(granted.pushed, false);
    a.close();
    b.close();
  });
});

test("End tells the friend (reason ended), so their app ends too; leaving by itself doesn't", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", "Bob");
    const a = alice.client();
    const b = bob.client();
    await a.connect();
    await b.connect();

    const { conversationId } = await a.talk(bob.id, pcm(2), { realtime: false });
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId, ringId: ring.ringId });
    await b.waitFor("burst-end");
    // The app leaving by itself (an idle timeout, a PushToTalk call iOS ended): "left".
    b.send({ type: "leave", conversationId });
    const left = await a.waitFor("peer-left");
    assert.equal(left.conversationId, conversationId);
    assert.equal(left.peer, bob.id);
    assert.equal(left.reason, "left");

    // Rung again in the same conversation, Bob joins and taps End: "ended".
    await a.talk(bob.id, pcm(2), { realtime: false });
    const again = await b.waitFor("ring");
    b.send({ type: "join", conversationId, ringId: again.ringId });
    await b.waitFor("burst-end");
    b.send({ type: "leave", conversationId, reason: "end" });
    const ended = await a.waitFor("peer-left");
    assert.equal(ended.reason, "ended");
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
    const frame = await talkStart(a, bob.id, "a1");
    for (let seq = 0; seq < 3; seq++) frame(seq);
    a.send({ type: "talk-end", burstId: "a1" });
    await talkStart(a, bob.id, "a2");
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
        await talkStart(a, bob.id, "a1");
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
    // null is valid JSON; so are messages missing their fields, a talk-start without its codec,
    // and format 1's talk-start (plaintext, retired), with or without its format.
    const bad = [null, 42, [], {}, { type: "talk-start" }, { type: "talk-start", to: "x", burstId: "b" },
      { type: "talk-start", to: "x", burstId: "b", codec: "pcm16le16k" }, { type: "talk-start", to: "x", burstId: "b", codec: "pcm16le16k", format: 1 },
      { type: "join", conversationId: 7 }, { type: "join", conversationId: "c", ringId: "nope" }, { type: "nope" }];
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
    const frame = await talkStart(a, bob.id, "b1");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    // All sealed, so Bob could open any the relay let through.
    frame(0, Buffer.alloc(1282)); // PCM that isn't 320 samples
    frame(1, Buffer.alloc(0));
    frame(2, Buffer.alloc(2000), Codec.opus16k); // bigger than any Opus packet
    frame(3, Buffer.alloc(640), 9); // no such codec
    frame(4);
    frame(5, Buffer.alloc(60), Codec.opus16k); // Opus, but the burst is PCM
    frame(6, Buffer.alloc(640 - 16)); // a format 1 frame's size: no room for the tag
    a.sendFrame(Codec.pcm16le16k, 7, Buffer.alloc(640)); // format 1 (plaintext, no tag)
    a.send({ type: "talk-end", burstId: "b1" });
    await b.waitFor("burst-end");
    assert.deepEqual(b.frames.map((f) => f.readUInt32BE(1)), [4]);

    // An Opus burst takes Opus packets, up to the largest there is.
    b.frames.length = 0;
    const opus = await talkStart(a, bob.id, "b2", "opus16k");
    assert.equal((await b.waitFor("burst-start")).codec, "opus16k");
    opus(0, Buffer.alloc(2000));
    opus(1, Buffer.alloc(640), Codec.pcm16le16k);
    opus(2);
    opus(3, Buffer.alloc(1275));
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
    const frame = await talkStart(a, bob.id, "b1");
    const ring = await b.waitFor("ring");
    b.send({ type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    await b.waitFor("burst-start");
    for (let seq = 0; seq < 5; seq++) frame(seq);
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
    const frame = await talkStart(a, bob.id, "b1");
    assert.equal((await a.waitFor("floor-granted")).pushed, true);
    for (let seq = 0; seq < 8; seq++) frame(seq);
    const error = await a.waitFor("error");
    assert.deepEqual([error.code, error.message], ["too-much-audio", "too much audio waiting"]);
    assert.equal(h.server.relay.snapshot()[0].bufferedBytes, 5 * SEALED_PCM);
    assert.equal(h.server.relay.snapshot()[0].floor, null);
    a.close();
  }, { maxBufferedBytes: 5 * SEALED_PCM + 100 });
});

test("a burst sent faster than real time is cut off at the longest burst's worth of frames", async () => {
  await withServer(async (h) => {
    const [alice, bob] = await friends(h, "Alice", ["Bob", { ringing: WATCH_PUSH }]);
    const a = alice.client();
    await a.connect();
    const frame = await talkStart(a, bob.id, "b1");
    await a.waitFor("floor-granted");
    // 10 frames = 200 ms; the 11th ends the burst long before its timer would.
    for (let seq = 0; seq < 15; seq++) frame(seq);
    const error = await a.waitFor("error", () => true, 150);
    assert.deepEqual([error.code, error.message], ["burst-too-long", "burst too long"]);
    assert.equal(h.server.relay.snapshot()[0].bufferedBytes, 10 * SEALED_PCM);
    a.close();
  }, { maxBurstMs: 200 });
});

// ---- The Ops dashboard's live view (GET /admin/stats) ----

function fakeDevice(keys: EndpointKeys, clientKind: ClientKind, delivery: Delivery): AccountDevice {
  return {
    id: keys.secrets.deviceId,
    clientKind,
    formFactor: formFactorOf(clientKind),
    delivery,
    receiveMode: "tap",
    availability: { enabled: true, notifications: "authorized" },
    capabilities: { ...structuredClone(DEFAULT_CAPABILITIES), audioFormats: [2] },
    e2ee: keys.registration,
    lastActiveAt: 0,
    updatedAt: 0,
  };
}

// A connection with its device's keys (the device ID is the peer's).
function fakePeer(userId: string, clientKind: ClientKind, decode?: CodecName[]): Peer & { got: ServerMessage[]; keys: EndpointKeys } {
  const got: ServerMessage[] = [];
  const deviceId = `${userId}-${clientKind}`;
  return { userId, deviceId, clientKind, ...(decode ? { decode } : {}), keys: deviceKeys(userId, deviceId, clientKind), got, sendJSON: (m) => got.push(m), sendBinary: () => {} };
}

// A sealed PCM frame's size; the relay only reads its header.
function pcmFrame(seq: number): Buffer {
  const frame = Buffer.alloc(SEALED_PCM);
  frame[0] = Codec.pcm16le16k;
  frame.writeUInt32BE(seq, 1);
  return frame;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("the live view: states, anonymous rows, turns, peaks, pcmOnly, and the bots left out", async () => {
  let now = Date.parse("2026-10-02T10:00:00Z");
  const a = fakePeer("u_a", "ios");
  const b = fakePeer("u_b", "watchos");
  // An Android build without Opus.
  const c = fakePeer("u_c", "android", ["pcm16le16k"]);
  const d = fakePeer("u_d", "wearos");
  const bot = fakePeer("u_bot", "watchos");
  const canary = fakePeer("u_canary", "ios");
  // Who rings how: the watch by an APNs alert, the Wear OS watch and the bot over a connection;
  // the others are only ever talked to while connected.
  const devices: Record<string, AccountDevice[]> = {
    u_a: [fakeDevice(a.keys, "ios", { provider: "relay", mode: "foreground" })],
    u_b: [fakeDevice(b.keys, "watchos", { provider: "apns", mode: "alert", token: "abcdef0123456789", environment: "sandbox" })],
    u_c: [fakeDevice(c.keys, "android", { provider: "relay", mode: "foreground" })],
    u_d: [fakeDevice(d.keys, "wearos", { provider: "test", mode: "connection" })],
    u_bot: [fakeDevice(bot.keys, "watchos", { provider: "test", mode: "connection" })],
  };
  const friendKeys = async (userId: string): Promise<FriendKeysJSON> => ({
    phones: (devices[userId] ?? []).map((device) => device.e2ee!.phoneCert),
    devices: (devices[userId] ?? []).map((device) => ({ deviceId: device.id, clientKind: device.clientKind, deviceCert: device.e2ee!.deviceCert, encCert: device.e2ee!.encCert })),
  });
  // A Talk sealed to the friend's devices, in their conversation (a new one when there's none).
  const conversations = new Map<string, string>();
  const talkStart = async (from: typeof a, to: string, burstId: string): Promise<ClientMessage> => {
    const pair = [from.userId, to].sort().join(" ");
    const conversationId = conversations.get(pair) ?? randomUUID();
    conversations.set(pair, conversationId);
    const { bundle } = sealBundle({ conversationId, burstId, codec: "pcm16le16k", from: from.userId, to }, from.keys.sender,
      usableKeys(to, await friendKeys(to), now).recipients, now);
    return { type: "talk-start", to, burstId, codec: Codec.pcm16le16k, format: 2, conversationId, e2ee: bundle };
  };
  const relay = new Relay({
    accounts: {
      ringLookup: async (_from, to) => ({ allowed: true, fromName: "Someone", devices: devices[to] ?? [] }),
      friendKeys,
      devices: async (userId) => devices[userId] ?? [],
    },
    pusher: new DryRunPusher(),
    metrics: new JsonMetricsStore(null),
    now: () => now,
    testBotUserId: "u_bot",
    canaryUserId: "u_canary",
  });
  const log = console.log;
  console.log = () => {};
  try {
    for (const p of [a, b, c, d, bot, canary]) relay.connect(p);

    // 1. iPhone → watch, rung by an APNs alert; still talking, then held for the watch.
    relay.handleMessage(a, await talkStart(a, "u_b", "a1"));
    await settle();
    for (let i = 0; i < 3; i++) relay.handleAudio(a, pcmFrame(i));
    assert.equal(relay.stats().live[0].state, "talking");
    relay.handleMessage(a, { type: "talk-end", burstId: "a1" });

    // 2. Android → Wear OS: rung over its connection, joined, and a reply: one back-and-forth.
    now += 1000;
    relay.handleMessage(c, await talkStart(c, "u_d", "c1"));
    await settle();
    relay.handleAudio(c, pcmFrame(0));
    relay.handleMessage(c, { type: "talk-end", burstId: "c1" });
    const ring = d.got.find((m) => m.type === "ring") as Extract<ServerMessage, { type: "ring" }>;
    relay.handleMessage(d, { type: "join", conversationId: ring.conversationId, ringId: ring.ringId });
    relay.handleMessage(d, await talkStart(d, "u_c", "d1"));
    relay.handleMessage(d, { type: "talk-end", burstId: "d1" });

    // 3. The iPhone rings the Test Bot (shown, marked), and the Canary talks to it (left out).
    now += 1000;
    relay.handleMessage(a, await talkStart(a, "u_bot", "a2"));
    relay.handleMessage(a, { type: "talk-end", burstId: "a2" });
    relay.handleMessage(canary, await talkStart(canary, "u_bot", "k1"));
    relay.handleMessage(canary, { type: "talk-end", burstId: "k1" });
    await settle();

    now += 3000;
    const stats = relay.stats();
    assert.deepEqual(stats.streams, { ios: 1, watchos: 1, android: 1, wearos: 1 });
    assert.equal(stats.pcmOnly, 1);
    assert.deepEqual(stats.conversations, { open: 3, talking: 0, ringing: 2, waiting: 1 });
    assert.deepEqual(stats.held, { bursts: 2, bytes: 3 * SEALED_PCM });
    assert.deepEqual(stats.live, [
      { state: "ringing", from: "ios", to: "watchos", ageMs: 3000, turns: 0, held: 1, ring: "test/connection", rolledOver: false, testBot: true },
      { state: "waiting", from: "android", to: "wearos", ageMs: 4000, turns: 1, held: 0, ring: "test/connection", rolledOver: false },
      { state: "ringing", from: "ios", to: "watchos", ageMs: 5000, turns: 0, held: 1, ring: "apns/alert", rolledOver: false },
    ]);
    assert.deepEqual(stats.peaks, { conversations: { value: 3, at: now - 3000 }, streams: { value: 4, at: Date.parse("2026-10-02T10:00:00Z") } });
    assert.doesNotMatch(JSON.stringify(stats), /u_|r_|-ios|-watchos|a1|c1/);

    // The peaks stay after a disconnect, and a new day (UTC) starts them from what's open.
    relay.disconnect(c);
    assert.equal(relay.stats().streams.android, 0);
    assert.equal(relay.stats().peaks.streams.value, 4);
    now = Date.parse("2026-10-03T00:00:01Z");
    assert.deepEqual(relay.stats().peaks.streams, { value: 3, at: now });
  } finally {
    console.log = log;
    relay.close();
  }
});

test("/admin/stats opens only with the Ops token: never the diagnostics token or a session token", async () => {
  await withServer(async (h) => {
    const alice = await user(h, "Alice", { kind: "ios" });
    const a = alice.client();
    await a.connect();
    const ok = await call(h.url, "GET", "/admin/stats", "ops");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.streams.ios, 1);
    assert.equal(typeof ok.body.node, "string");
    assert.ok(ok.body.startedAt <= ok.body.now);
    assert.equal((await call(h.url, "GET", "/admin/stats", "admin")).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/stats", alice.token)).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/stats", null)).status, 401);
    // The Ops token opens nothing else.
    assert.equal((await call(h.url, "GET", "/admin/status", "ops")).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/metrics", "ops")).status, 401);
    a.close();
  }, { opsStatsToken: "ops" });
  // Not configured on a relay with a diagnostics token: closed to everyone.
  await withServer(async (h) => {
    assert.equal((await call(h.url, "GET", "/admin/stats", "admin")).status, 401);
    assert.equal((await call(h.url, "GET", "/admin/stats", null)).status, 401);
  });
});
