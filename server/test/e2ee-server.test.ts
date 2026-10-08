import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEndpointSecrets, openEndpointSecrets } from "../src/endpoint-keys.ts";
import { openBundle, sealBundle, usableKeys } from "../src/e2ee.ts";
import { Codec, parseClientMessage, isValidFrame } from "../src/protocol.ts";
import { RecordParser } from "../src/records.ts";
import { befriend, call, clientHeaders, registration, user, withServer, type TestServer, type TestUser } from "./harness.ts";

async function encryptedDevice(h: TestServer, person: TestUser) {
  const keys = openEndpointSecrets(createEndpointSecrets(person.id, person.deviceId, person.kind), person.id, person.deviceId);
  const ringing = person.kind === "ios" ? { apns: "pushtotalk" as const, token: `token-${person.deviceId}` } : { apns: "alert" as const, token: `token-${person.deviceId}` };
  const answer = await call(h.url, "PUT", "/v2/me/device", person.token, {
    ...registration(person.kind, ringing),
    capabilities: { relayProtocols: [2], audioFormats: [1, 2], decode: ["opus16k", "pcm16le16k"], encode: ["opus16k"], features: [] },
    e2ee: keys.registration,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return keys;
}

test("format 2 parsing bounds bundles and frame sizes", () => {
  assert.equal(isValidFrame(Buffer.alloc(5 + 60 + 16).fill(1, 0, 1), 2), true);
  assert.equal(isValidFrame(Buffer.alloc(5 + 16).fill(1, 0, 1), 2), false);
  assert.equal(parseClientMessage({ type: "talk-start", to: "u_bob", burstId: "b", codec: "opus16k", format: 2 }), null);
});

for (const transport of ["ws", "http"] as const) test(`validated registration and format 2 ${transport}: stale keys refuse; prefetch and replay preserve ciphertext`, async () => {
  await withServer(async (h) => {
    const alice = await user(h, "Alice", { kind: "ios", deviceId: "alice-phone" });
    const bob = await user(h, "Bob", { kind: "ios", deviceId: "bob-phone" });
    const bobWatch = await user(h, "Bob", { kind: "watchos", deviceId: "bob-watch" });
    await befriend(h, alice, bob);
    const ak = await encryptedDevice(h, alice);
    const bk = await encryptedDevice(h, bob);
    const partial = await call(h.url, "GET", "/v2/friends", alice.token);
    const partialKeys = partial.body.friends.find((f: { id: string }) => f.id === bob.id).keys;
    assert.equal(partialKeys.allDevicesHaveKeys, false);
    const partialClient = alice.client({ audioFormats: [1, 2], transport });
    await partialClient.connect();
    const partialId = randomUUID();
    const partialBurst = randomUUID();
    const partialSealed = sealBundle({ conversationId: partialId, burstId: partialBurst, codec: "opus16k",
      from: alice.id, to: bob.id }, ak.sender, usableKeys(bob.id, partialKeys, Date.now()).recipients, Date.now());
    partialClient.send({ type: "talk-start", to: bob.id, burstId: partialBurst, codec: "opus16k",
      format: 2, conversationId: partialId, e2ee: partialSealed.bundle });
    const partialRefusal = await partialClient.waitFor("talk-refused");
    assert.equal(partialRefusal.reason, "keys-stale");
    assert.equal(partialRefusal.keys?.allDevicesHaveKeys, false);
    partialClient.close();
    await encryptedDevice(h, bobWatch);
    const listed = await call(h.url, "GET", "/v2/friends", alice.token);
    assert.equal(listed.status, 200);
    const directory = listed.body.friends.find((f: { id: string }) => f.id === bob.id).keys;
    assert.equal(directory.devices.length, 2);
    assert.equal(directory.allDevicesHaveKeys, true);
    assert.equal(directory.phones.length, 2);
    const bad = await call(h.url, "PUT", "/v2/me/device", alice.token, {
      ...registration("ios", { apns: "pushtotalk", token: "old" }), e2ee: { ...ak.registration, encCert: bk.registration.encCert },
    });
    assert.equal(bad.status, 400);

    const a = alice.client({ audioFormats: [1, 2], transport });
    await a.connect();
    const codec = "opus16k";
    const all = usableKeys(bob.id, directory, Date.now()).recipients;
    assert.equal(all.length, 2);
    const staleId = randomUUID();
    const staleBurst = randomUUID();
    const stale = sealBundle({ conversationId: staleId, burstId: staleBurst, codec, from: alice.id, to: bob.id }, ak.sender, all.slice(0, 1), Date.now());
    a.send({ type: "talk-start", to: bob.id, burstId: staleBurst, codec, format: 2, conversationId: staleId, e2ee: stale.bundle });
    const refused = await a.waitFor("talk-refused");
    assert.equal(refused.reason, "keys-stale");
    assert.equal(refused.keys?.devices.length, 2);
    assert.equal(h.pusher.sent.length, 0);

    const conversationId = randomUUID();
    const burstId = randomUUID();
    const { bundle, cipher } = sealBundle({ conversationId, burstId, codec, from: alice.id, to: bob.id }, ak.sender, all, Date.now());
    a.send({ type: "talk-start", to: bob.id, burstId, codec, format: 2, conversationId, e2ee: bundle });
    assert.equal((await a.waitFor("floor-granted")).conversationId, conversationId);
    const payload = Buffer.alloc(60, 0x5a);
    const frame = cipher.seal(Codec.opus16k, 0, payload);
    a.sendFrame(Codec.opus16k, 0, frame.subarray(5));
    a.send({ type: "talk-end", burstId });
    assert.equal(h.pusher.sent.length, 1);
    const ring = h.pusher.sent[0].payload as { ringId: string };
    let records: ReturnType<RecordParser["push"]> = [];
    for (let i = 0; i < 50 && records.length < 3; i++) {
      const prefetch = await fetch(new URL(`/v2/rings/audio?conversationId=${conversationId}&ringId=${ring.ringId}`, h.url), {
        headers: { authorization: `Bearer ${bob.token}`, ...clientHeaders("ios") },
      });
      assert.equal(prefetch.status, 200);
      records = new RecordParser().push(Buffer.from(await prefetch.arrayBuffer()));
      if (records.length < 3) await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(records.length, 3);
    const start = JSON.parse(records[0].payload.toString());
    assert.equal(start.format, 2);
    assert.deepEqual(start.e2ee, bundle);
    assert.deepEqual(records[1].payload, frame);

    const b = bob.client({ audioFormats: [1, 2], transport, e2ee: { keys: bk, directory: async () => ({ phones: [], devices: [] }) } });
    await b.connect();
    b.send({ type: "join", conversationId, ringId: ring.ringId });
    await b.waitFor("joined");
    const replay = await b.waitFor("burst-start");
    assert.equal(replay.format, 2);
    assert.deepEqual(replay.e2ee, bundle);
    await b.waitFor("burst-end");
    assert.equal(b.frames.length, 1);
    assert.equal(b.frames[0][0], Codec.opus16k);
    assert.equal(b.frames[0].readUInt32BE(1), 0);
    assert.deepEqual(b.frames[0].subarray(5), payload);
    b.close();
    const resumed = bob.client({ audioFormats: [1, 2], transport, e2ee: { keys: bk, directory: async () => ({ phones: [], devices: [] }) } });
    await resumed.connect();
    resumed.send({ type: "join", conversationId, resume: { burstId, fromSeq: 0 } });
    await resumed.waitFor("joined");
    const resumedStart = await resumed.waitFor("burst-start");
    assert.equal(resumedStart.resumed, true);
    assert.deepEqual(resumedStart.e2ee, bundle);
    await resumed.waitFor("burst-end");
    assert.equal(resumed.frames.length, 1);
    assert.deepEqual(resumed.frames[0].subarray(5), payload);
    a.close();
    resumed.close();
  });
});

test("the Test Bot decrypts format 2 and returns an encrypted greeting and echo; the Canary verifies the greeting", async () => {
  const { Accounts } = await import("../src/accounts.ts");
  const { MemoryDocs } = await import("../src/docs.ts");
  const { runCanary } = await import("../src/canary.ts");
  const docs = new MemoryDocs();
  const setup = new Accounts(docs);
  const { user: bot } = await setup.signInWithApple("e2ee-bot", "Test Bot");
  await setup.createSession(bot.id, "test-bot", "watchos");
  const botKeys = openEndpointSecrets(createEndpointSecrets(bot.id, "test-bot", "watchos"), bot.id, "test-bot");
  const invite = await setup.createInvite(bot.id);
  await withServer(async (h) => {
    const reviewer = await user(h, "Reviewer", { kind: "ios", deviceId: "reviewer-phone" });
    const reviewerKeys = await encryptedDevice(h, reviewer);
    assert.equal((await call(h.url, "POST", `/v2/invites/${invite.code}/accept`, reviewer.token)).status, 200);
    const result = await runCanary({ relayUrl: h.url, token: reviewer.token, botUserId: bot.id,
      keys: reviewerKeys, botKeys: await h.accounts.friendKeys(bot.id), timeoutMs: 5000 });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.firstFrameMs !== undefined);
    const client = reviewer.client({ audioFormats: [1, 2], e2ee: { keys: reviewerKeys, directory: async () => await h.accounts.friendKeys(bot.id) } });
    await client.connect();
    const heard: Array<{ start: { conversationId: string; burstId: string; codec?: string; format?: number; e2ee?: any }; frames: Buffer[]; ended: boolean }> = [];
    client.onMessage = (message) => {
      if (message.type === "burst-start" && message.from === bot.id) heard.push({ start: message, frames: [], ended: false });
      if (message.type === "burst-end" && heard.length) heard.at(-1)!.ended = true;
    };
    client.onFrame = (frame) => heard.at(-1)?.frames.push(frame);
    const conversationId = randomUUID();
    const burstId = randomUUID();
    const { bundle, cipher } = sealBundle({ conversationId, burstId, codec: "opus16k", from: reviewer.id, to: bot.id },
      reviewerKeys.sender, usableKeys(bot.id, await h.accounts.friendKeys(bot.id), Date.now()).recipients, Date.now());
    client.send({ type: "talk-start", to: bot.id, burstId, codec: "opus16k", format: 2, conversationId, e2ee: bundle });
    await client.waitFor("floor-granted");
    for (let seq = 0; seq < 2; seq++) client.sendFrame(Codec.opus16k, seq, cipher.seal(Codec.opus16k, seq, Buffer.alloc(60, seq + 1)).subarray(5));
    client.send({ type: "talk-end", burstId });
    const deadline = Date.now() + 2500;
    while (heard.filter((b) => b.ended).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.equal(heard.filter((b) => b.ended).length, 2);
    const opened = heard.map((burst) => {
      assert.equal(burst.start.format, 2);
      const context = { conversationId, burstId: burst.start.burstId, codec: burst.start.codec!, from: bot.id, to: reviewer.id };
      openBundle(burst.start.e2ee!, context,
        { deviceId: reviewer.deviceId, keys: reviewerKeys.encryption }, Date.now());
      return burst.frames.map((frame) => frame.subarray(5));
    });
    assert.deepEqual(opened[0], [Buffer.from([0xa1, 1]), Buffer.from([0xa1, 2])]);
    assert.deepEqual(opened[1], [Buffer.alloc(60, 1), Buffer.alloc(60, 2)]);
    client.close();
  }, { docs, testBot: { userId: bot.id, deviceId: "test-bot", keys: botKeys,
    greeting: [Buffer.from([0xa1, 1]), Buffer.from([0xa1, 2])], answerDelayMs: 10, replyDelayMs: 10, frameMs: 0, minEchoFrames: 2 } });
});
