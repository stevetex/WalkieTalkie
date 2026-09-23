import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { RecordParser, RecordType, encodeJSONRecord, encodeRecord } from "../src/records.ts";
import { SpikeClient } from "../tools/client.ts";

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

async function withServer(fn: (s: RunningServer) => Promise<void>): Promise<void> {
  const running = await startServer({ port: 0, dataDir: null, token: "secret", pusher: new DryRunPusher() });
  try {
    await fn(running);
  } finally {
    await running.close();
  }
}

function pcm(frames: number): Buffer {
  return Buffer.alloc(frames * 640, 1);
}

test("a watch on the HTTP transport answers, gets the replay, and talks back", async () => {
  await withServer(async (s) => {
    const server = `http://localhost:${s.port}`;
    const bot = new SpikeClient({ server, userId: "bot", token: "secret" });
    const watch = new SpikeClient({ server, userId: "watch", token: "secret", transport: "http" });
    await bot.register("Bot");
    await watch.register("Watch", "poll:watch");
    await bot.connect();

    const { conversationId } = await bot.talk("watch", pcm(20), { realtime: false });
    assert.equal((await watch.api("GET", "/v1/rings/poll?userId=watch")).length, 1);

    // Answer: the call ends and the app continues over HTTPS.
    await watch.connect();
    watch.send({ type: "join", conversationId });
    assert.equal((await watch.waitFor("joined")).replayBursts, 1);
    assert.equal((await watch.waitFor("burst-start")).replay, true);
    await watch.waitFor("burst-end");
    assert.equal(watch.frames.length, 20);
    assert.deepEqual(watch.frames.map((f) => f.readUInt32BE(1)), Array.from({ length: 20 }, (_, i) => i));

    // Reply from the watch goes out in POST batches and arrives in order.
    const reply = await watch.talk("bot", pcm(15), { realtime: false });
    assert.equal(reply.pushed, false);
    await bot.waitFor("burst-start", (m) => m.from === "watch");
    await bot.waitFor("burst-end");
    assert.deepEqual(bot.frames.map((f) => f.readUInt32BE(1)), Array.from({ length: 15 }, (_, i) => i));

    bot.close();
    watch.close();
  });
});

test("the HTTP stream disconnecting leaves the conversation", async () => {
  await withServer(async (s) => {
    const server = `http://localhost:${s.port}`;
    const bot = new SpikeClient({ server, userId: "bot", token: "secret" });
    const watch = new SpikeClient({ server, userId: "watch", token: "secret", transport: "http" });
    await bot.register("Bot");
    await watch.register("Watch", "poll:watch");
    await bot.connect();
    await watch.connect();
    const { conversationId } = await bot.talk("watch", pcm(2), { realtime: false });
    await watch.api("GET", "/v1/rings/poll?userId=watch");
    watch.send({ type: "join", conversationId });
    await watch.waitFor("burst-end");

    watch.close();
    const left = await bot.waitFor("peer-left");
    assert.equal(left.peer, "watch");
    bot.close();
  });
});

test("sending before opening the stream is rejected", async () => {
  await withServer(async (s) => {
    const res = await fetch(`http://localhost:${s.port}/v1/relay/send?userId=nobody`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: encodeJSONRecord({ type: "leave", conversationId: "x" }),
    });
    assert.equal(res.status, 409);
  });
});
