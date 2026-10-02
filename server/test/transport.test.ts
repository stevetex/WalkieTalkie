import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordParser, RecordType, encodeJSONRecord, encodeRecord } from "../src/records.ts";
import { call, clientHeaders, friends, user, withServer, type TestServer } from "./harness.ts";

test("record parser handles split and batched chunks", () => {
  const bytes = Buffer.concat([
    encodeJSONRecord({ type: "join", conversationId: "c1" }),
    encodeRecord(RecordType.audio, Buffer.from([1, 0, 0, 0, 7, 0xaa, 0xbb])),
  ]);
  const parser = new RecordParser();
  const records = [...parser.push(bytes.subarray(0, 3)), ...parser.push(bytes.subarray(3, 20)), ...parser.push(bytes.subarray(20))];
  assert.equal(records.length, 2);
  assert.deepEqual(JSON.parse(records[0].payload.toString()), { type: "join", conversationId: "c1" });
  assert.equal(records[1].type, RecordType.audio);
  assert.equal(records[1].payload.readUInt32BE(1), 7);
});

function pcm(frames: number): Buffer {
  return Buffer.alloc(frames * 640, 1);
}

// A watch rung through APNs, so the ring (and its ID) is in the push.
const WATCH_PUSH = { apns: "alert", token: "abcdef0123456789" } as const;

function ringId(h: TestServer, n: number): string {
  return (h.pusher.sent[n].payload as { ringId: string }).ringId;
}

test("a watch on the HTTP transport answers, gets the replay, and talks back", async () => {
  await withServer(async (h) => {
    const [botUser, watchUser] = await friends(h, "Bot", ["Watch", { ringing: WATCH_PUSH }]);
    const bot = botUser.client();
    const watch = watchUser.client({ transport: "http" });
    await bot.connect();

    const { conversationId } = await bot.talk(watchUser.id, pcm(20), { realtime: false });
    assert.equal(h.pusher.sent.length, 1);

    // Answer: the call ends and the app continues over HTTPS.
    await watch.connect();
    watch.send({ type: "join", conversationId, ringId: ringId(h, 0) });
    assert.equal((await watch.waitFor("joined")).replayBursts, 1);
    assert.equal((await watch.waitFor("burst-start")).replay, true);
    await watch.waitFor("burst-end");
    assert.equal(watch.frames.length, 20);
    assert.deepEqual(watch.frames.map((f) => f.readUInt32BE(1)), Array.from({ length: 20 }, (_, i) => i));

    // Reply from the watch goes out in POST batches and arrives in order.
    const reply = await watch.talk(botUser.id, pcm(15), { realtime: false });
    assert.equal(reply.pushed, false);
    await bot.waitFor("burst-start", (m) => m.from === watchUser.id);
    await bot.waitFor("burst-end");
    assert.deepEqual(bot.frames.map((f) => f.readUInt32BE(1)), Array.from({ length: 15 }, (_, i) => i));

    bot.close();
    watch.close();
  });
});

test("opening the HTTP stream can join in the same request", async () => {
  await withServer(async (h) => {
    const [botUser, watchUser] = await friends(h, "Bot", ["Watch", { ringing: WATCH_PUSH }]);
    const bot = botUser.client();
    const watch = watchUser.client({ transport: "http" });
    await bot.connect();

    // No such ring: the stream opens but says so.
    await watch.connect("nope", undefined, "r_nope");
    assert.equal((await watch.waitFor("error")).code, "ring-expired");
    watch.close();

    // The ring the notification carried is answered and joined by the stream request itself.
    const { conversationId } = await bot.talk(watchUser.id, pcm(10), { realtime: false });
    await watch.connect(conversationId, undefined, ringId(h, 0));
    const joined = await watch.waitFor("joined");
    assert.equal(joined.conversationId, conversationId);
    assert.equal(joined.peer, botUser.id);
    assert.equal(joined.ringId, ringId(h, 0));
    await watch.waitFor("burst-end");
    assert.equal(watch.frames.length, 10);
    assert.deepEqual((await call(h.url, "GET", "/v2/rings/pending", watchUser.token, undefined, clientHeaders("watchos"))).body.rings, []);
    watch.close();

    // Or join over a stream that's already open, as the watch does when it opened the
    // stream while the notification was being delivered.
    while (h.server.relay.snapshot().some((c) => c.joined.includes(watchUser.id))) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = await bot.talk(watchUser.id, pcm(5), { realtime: false });
    assert.equal(second.pushed, true);
    await watch.connect();
    watch.send({ type: "join", conversationId: second.conversationId, ringId: ringId(h, 1) });
    assert.equal((await watch.waitFor("joined")).conversationId, second.conversationId);
    watch.close();
    bot.close();
  });
});

test("the HTTP stream disconnecting leaves the conversation", async () => {
  await withServer(async (h) => {
    // Rung over its open stream.
    const [botUser, watchUser] = await friends(h, "Bot", "Watch");
    const bot = botUser.client();
    const watch = watchUser.client({ transport: "http" });
    await bot.connect();
    await watch.connect();
    const { conversationId } = await bot.talk(watchUser.id, pcm(2), { realtime: false });
    const ring = await watch.waitFor("ring");
    watch.send({ type: "join", conversationId, ringId: ring.ringId });
    await watch.waitFor("burst-end");

    watch.close();
    const left = await bot.waitFor("peer-left");
    assert.equal(left.peer, watchUser.id);
    bot.close();
  });
});

test("sending before opening the stream is rejected", async () => {
  await withServer(async (h) => {
    const nobody = await user(h, "Nobody");
    const res = await fetch(new URL("/v2/relay/send", h.url), {
      method: "POST",
      headers: { authorization: `Bearer ${nobody.token}` },
      body: encodeJSONRecord({ type: "leave", conversationId: "x" }),
    });
    assert.equal(res.status, 409);
  });
});
