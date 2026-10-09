// The always-on Test Bot (test-bot.ts) inside the relay, with the account API, as a reviewer
// meets it: befriend it with its standing invite, ring it from a watch (the HTTP stream) or an
// iPhone (the WebSocket here; PushToTalk only matters for rings to the iPhone, which the bot
// never makes), hear the greeting and the echo, and block or report it.

import { test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { DryRunPusher } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { apiFromEnv } from "../src/api-main.ts";
import { MemoryDocs } from "../src/docs.ts";
import { Relay, type Peer } from "../src/relay.ts";
import { Codec, MAX_OPUS_PACKET_BYTES, type ServerMessage } from "../src/protocol.ts";
import { generateSigningKey } from "../src/session.ts";
import { MemorySink, TelemetryMetricsStore, conversationRecord } from "../src/telemetry.ts";
import { activeAccounts } from "../src/stats.ts";
import { JsonMetricsStore } from "../src/store.ts";
import { loadGreeting } from "../src/test-bot.ts";
import { DEFAULT_CAPABILITIES } from "../src/contract.ts";
import { sealBundle, usableKeys } from "../src/e2ee.ts";
import type { SpikeClient } from "../tools/client.ts";
import { call, deviceKeys, user, withServer, type Kind, type TestServer, type TestUser } from "./harness.ts";

const INVITE = "bot-invite-code-1234";
// A short stand-in for the committed greeting: three "Opus packets" the tests can tell apart.
const GREETING = [Buffer.from([0xa1, 1]), Buffer.from([0xa1, 2]), Buffer.from([0xa1, 3])];

interface Harness extends TestServer {
  botId: string;
  sink: MemorySink;
}

async function withBot(fn: (h: Harness) => Promise<void>, { authTtlMs, idleMs = 30_000, replyDelayMs = 20 }: { authTtlMs?: number; idleMs?: number; replyDelayMs?: number } = {}): Promise<void> {
  const docs = new MemoryDocs();
  // The bot's account and its "device", as tools/test-account.ts create writes them (it needs
  // the account's ID before the relay starts), and its E2EE keys, which the relay registers with
  // its test delivery when it starts.
  const setup = new Accounts(docs);
  const { user: bot } = await setup.signInWithApple("test-bot.overandout", "Test Bot");
  await setup.createSession(bot.id, "test-bot", "watchos");
  const keys = deviceKeys(bot.id, "test-bot", "watchos");
  const sink = new MemorySink();
  await withServer(async (h) => fn({ ...h, botId: bot.id, sink }), {
    docs,
    // The API's accounts know the bot's standing invite; the relay's share the same documents.
    api: { accounts: new Accounts(docs, { botInvite: { code: INVITE, userId: bot.id } }) },
    metrics: new TelemetryMetricsStore(sink, { endedMs: 5 }),
    ...(authTtlMs !== undefined ? { authTtlMs } : {}),
    testBot: { userId: bot.id, keys, greeting: GREETING, answerDelayMs: 10, replyDelayMs, frameMs: 0, idleMs, minEchoFrames: 2 },
  });
}

// A reviewer with the bot as their friend, by its standing invite. Their device is rung through
// APNs, so a ring from the bot would show up in the pusher.
async function reviewer(h: TestServer, name = "Reviewer", kind: Kind = "watchos"): Promise<TestUser> {
  const token = Buffer.from(name).toString("hex");
  const person = await user(h, name, { kind, ringing: { apns: kind === "ios" ? "pushtotalk" : "alert", token } });
  const accepted = await call(h.url, "POST", `/v2/invites/${INVITE}/accept`, person.token);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.friend.name, "Test Bot");
  return person;
}

// Distinct stand-in Opus packets (the apps send Opus), so the echo can be checked byte for byte.
function opus(frames: number, fill = 1): Buffer[] {
  return Array.from({ length: frames }, (_, seq) => Buffer.alloc(40, (seq * 7 + fill) & 0xff));
}

// Distinct PCM frames.
function pcm(frames: number, fill = 1): Buffer {
  const buf = Buffer.alloc(frames * 640);
  for (let i = 0; i < buf.length; i++) buf[i] = (i + fill) & 0xff;
  return buf;
}

// A Talk sealed to the bot's keys, as the apps send it, with its frames' cipher.
async function talkStart(client: SpikeClient, to: string, burstId: string, codec: "opus16k" | "pcm16le16k") {
  const { message, cipher } = await client.sealedTalkStart(to, burstId, codec);
  client.send(message);
  return cipher;
}

// One burst of Opus packets, all at once.
function say(client: SpikeClient, to: string, frames: Buffer[]): Promise<{ conversationId: string; pushed: boolean }> {
  return client.talkFrames(to, { codec: Codec.opus16k, frames }, { realtime: false });
}

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// The bursts a caller hears, as they arrive; next() waits for the next one to end and returns
// its frames' codecs, sequence numbers and payloads.
function listen(client: SpikeClient) {
  const bursts: Array<{ from: string; codec?: string; frames: Buffer[]; ended: boolean }> = [];
  let taken = 0;
  client.onMessage = (m) => {
    if (m.type === "burst-start") bursts.push({ from: m.from, codec: m.codec, frames: [], ended: false });
    else if (m.type === "burst-end" && bursts.length) bursts.at(-1)!.ended = true;
  };
  client.onFrame = (f) => bursts.at(-1)?.frames.push(f);
  return {
    get started(): number {
      return bursts.length;
    },
    async next(): Promise<{ from: string; codec?: string; codecs: number[]; seqs: number[]; payloads: Buffer[] }> {
      await until(() => bursts[taken]?.ended === true, "a burst");
      const { from, codec, frames } = bursts[taken++];
      return { from, codec, codecs: frames.map((f) => f[0]), seqs: frames.map((f) => f.readUInt32BE(1)), payloads: frames.map((f) => f.subarray(5)) };
    },
  };
}

test("the Test Bot answers an iPhone caller on either transport, and never through APNs", async () => {
  await withBot(async (h) => {
    const phone = await reviewer(h, "Reviewer", "ios");
    for (const transport of ["http", "ws"] as const) {
      const client = phone.client({ transport });
      await client.connect();
      const heard = listen(client);
      const sent = opus(6);
      const { pushed } = await say(client, h.botId, sent);
      assert.equal(pushed, true);
      assert.equal(h.pusher.sent.length, 0);
      assert.deepEqual((await heard.next()).payloads, GREETING);
      assert.deepEqual((await heard.next()).payloads, sent);
      client.close();
      await until(() => h.server.testBot!.conversationCount === 0 && h.server.relay.snapshot().length === 0, "the bot to leave");
    }
  });
});

for (const transport of ["http", "ws"] as const) {
  test(`the Test Bot answers a ring, greets, says each burst back, and leaves with the caller (${transport === "http" ? "the watch's HTTP stream" : "WebSocket"})`, async () => {
    await withBot(async (h) => {
      const { server, botId, sink, pusher } = h;
      const client = (await reviewer(h)).client({ transport });
      await client.connect();
      const heard = listen(client);

      // The ring goes to the bot inside the relay, not through APNs.
      const sent = opus(12);
      const { conversationId, pushed } = await say(client, botId, sent);
      assert.equal(pushed, true);
      assert.equal(pusher.sent.length, 0);

      const greeting = await heard.next();
      assert.equal(greeting.from, botId);
      assert.equal(greeting.codec, "opus16k");
      assert.deepEqual(greeting.codecs, [Codec.opus16k, Codec.opus16k, Codec.opus16k]);
      assert.deepEqual(greeting.seqs, [0, 1, 2]);
      assert.deepEqual(greeting.payloads, GREETING);
      const echo = await heard.next();
      assert.deepEqual(echo.seqs, Array.from({ length: 12 }, (_, i) => i));
      assert.ok(echo.codecs.every((c) => c === Codec.opus16k));
      assert.deepEqual(echo.payloads, sent);

      // Live now: the next burst is said back without ringing or greeting again.
      const again = opus(3, 7);
      const second = await say(client, botId, again);
      assert.equal(second.pushed, false);
      assert.equal(second.conversationId, conversationId);
      assert.deepEqual((await heard.next()).payloads, again);

      // A tap on Talk (shorter than minEchoFrames) isn't said back.
      await say(client, botId, opus(1));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(heard.started, 3);

      // The caller leaves; so does the bot, and the relay forgets the conversation.
      client.send({ type: "leave", conversationId });
      await until(() => server.relay.snapshot().length === 0 && server.testBot!.conversationCount === 0, "the bot to leave");
      client.close();

      // Telemetry: answered, and marked as the bot's, so it isn't counted as a person.
      await until(() => sink.of("oao.conversation").length > 0, "the conversation record");
      const [record] = sink.of("oao.conversation");
      assert.equal(record.outcome, "answered");
      assert.equal(record.testBot, true);
      assert.equal(record.to, botId);
      assert.equal(record.callerBursts, 3);
      assert.equal(record.calleeBursts, 3);
      // Talking to the Test Bot isn't talking to a friend, unless the dashboard's switch asks.
      assert.deepEqual([...activeAccounts([{ ...record, timestamp: "" } as never])], []);
      assert.deepEqual([...activeAccounts([{ ...record, timestamp: "" } as never], { testBot: botId, includeTestBot: true })], [record.from]);
    });
  });
}

test("a PCM burst is said back in PCM", async () => {
  await withBot(async (h) => {
    const client = (await reviewer(h)).client();
    await client.connect();
    const heard = listen(client);
    const sent = pcm(6);
    await client.talk(h.botId, sent, { realtime: false });
    assert.deepEqual((await heard.next()).payloads, GREETING);
    const echo = await heard.next();
    assert.equal(echo.codec, "pcm16le16k");
    assert.ok(echo.codecs.every((c) => c === Codec.pcm16le16k));
    assert.deepEqual(Buffer.concat(echo.payloads), sent);
    client.close();
  });
});

test("a caller who keeps talking isn't talked over: the bot replies once they stop", async () => {
  await withBot(async (h) => {
    const client = (await reviewer(h)).client();
    await client.connect();
    const heard = listen(client);
    const first = opus(4, 1);
    await say(client, h.botId, first);
    // Talking again before the bot replies, and holding the floor for a while.
    const cipher = await talkStart(client, h.botId, "b2", "opus16k");
    const second = opus(5, 9);
    for (const [seq, packet] of second.entries()) {
      client.sendSealedFrame(cipher, Codec.opus16k, seq, packet);
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(heard.started, 0);
    client.send({ type: "talk-end", burstId: "b2" });
    assert.deepEqual((await heard.next()).payloads, GREETING);
    assert.deepEqual((await heard.next()).payloads, first);
    assert.deepEqual((await heard.next()).payloads, second);
    client.close();
  }, { replyDelayMs: 100 });
});

test("the Test Bot talks in one conversation at a time: a second caller waits their turn", async () => {
  await withBot(async (h) => {
    const callers = [await reviewer(h, "Ann"), await reviewer(h, "Ben")];
    const clients = callers.map((c) => c.client());
    for (const client of clients) await client.connect();
    const heard = clients.map(listen);
    const sent = [opus(4, 3), opus(4, 5)];
    await Promise.all(clients.map((client, i) => say(client, h.botId, sent[i])));
    // Each hears the greeting and their own burst back, in order, nothing of the other's.
    for (const [i, listener] of heard.entries()) {
      assert.deepEqual((await listener.next()).payloads, GREETING);
      assert.deepEqual((await listener.next()).payloads, sent[i]);
    }
    for (const client of clients) client.close();
  });
});

test("the Test Bot leaves a quiet conversation after the apps' window", async () => {
  await withBot(async (h) => {
    const client = (await reviewer(h)).client();
    await client.connect();
    const heard = listen(client);
    const { conversationId } = await say(client, h.botId, opus(4));
    await heard.next();
    await heard.next();
    const left = await client.waitFor("peer-left");
    assert.equal(left.conversationId, conversationId);
    assert.equal(left.peer, h.botId);
    assert.equal(h.server.testBot!.conversationCount, 0);
    client.close();
  }, { idleMs: 200 });
});

test("the Test Bot's standing invite: anyone can use it, any number of times, only for the bot", async () => {
  await withBot(async (h) => {
    const { url, botId } = h;
    const alice = await user(h, "Alice", { kind: "ios", ringing: "none" });
    const preview = await call(url, "GET", `/v2/invites/${INVITE}`, alice.token);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.from, { id: botId, name: "Test Bot" });
    assert.equal(preview.body.alreadyFriends, false);
    assert.ok(preview.body.expiresAt > Date.now());
    assert.equal((await call(url, "POST", `/v2/invites/${INVITE}/accept`, alice.token)).status, 200);
    // Not used up: Alice again (already friends), then Bob.
    assert.equal((await call(url, "GET", `/v2/invites/${INVITE}`, alice.token)).body.alreadyFriends, true);
    assert.equal((await call(url, "POST", `/v2/invites/${INVITE}/accept`, alice.token)).status, 200);
    await reviewer(h, "Bob");
    // Alice and Bob are the bot's friends, not each other's.
    assert.deepEqual((await call(url, "GET", "/v2/friends", alice.token)).body.friends.map((f: { name: string }) => f.name), ["Test Bot"]);
    // It isn't a stored invite: nobody can cancel it, and the bot's own invites are as usual.
    assert.equal((await call(url, "DELETE", `/v2/invites/${INVITE}`, alice.token)).status, 404);
    // A different code of the same shape is just an unknown invite.
    assert.equal((await call(url, "GET", `/v2/invites/${INVITE}x`, alice.token)).status, 404);
  });
});

test("the standing invite needs the bot's account and a long enough code", () => {
  const env = { SERVE_API: "1" };
  assert.throws(() => apiFromEnv({ ...env, SESSION_SIGNING_KEY: key(), TEST_BOT_INVITE: "short" }, new MemoryDocs(), null), /12–64/);
  assert.throws(() => apiFromEnv({ ...env, SESSION_SIGNING_KEY: key(), TEST_BOT_INVITE: INVITE }, new MemoryDocs(), null), /TEST_BOT_USER_ID/);
  const setup = apiFromEnv({ ...env, SESSION_SIGNING_KEY: key(), TEST_BOT_INVITE: INVITE, TEST_BOT_USER_ID: "u_bot" }, new MemoryDocs(), null);
  assert.ok(setup.notes.some((n) => n.includes("u_bot") && !n.includes(INVITE)));
});

function key(): string {
  return JSON.stringify(generateSigningKey("k").signingKey);
}

test("a reviewer who blocks and reports the Test Bot can't ring it, or re-add it until they unblock", async () => {
  await withBot(async (h) => {
    const { server, url, botId } = h;
    const person = await reviewer(h);
    const report = await call(url, "POST", "/v2/reports", person.token, { userId: botId, reason: "spam", block: true });
    assert.equal(report.status, 200);
    assert.deepEqual((await call(url, "GET", "/v2/friends", person.token)).body.friends, []);

    const client = person.client();
    await client.connect();
    await talkStart(client, botId, "b1", "pcm16le16k");
    assert.equal((await client.waitFor("talk-refused")).reason, "not-friends");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.testBot!.conversationCount, 0);
    assert.ok(!client.received.some((m) => m.type === "burst-start"));

    // The standing invite respects the block, both ways.
    assert.equal((await call(url, "GET", `/v2/invites/${INVITE}`, person.token)).status, 404);
    assert.equal((await call(url, "POST", `/v2/invites/${INVITE}/accept`, person.token)).status, 404);
    assert.equal((await call(url, "DELETE", `/v2/blocks/${botId}`, person.token)).status, 200);
    assert.equal((await call(url, "POST", `/v2/invites/${INVITE}/accept`, person.token)).status, 200);
    client.close();
  });
});

test("blocking the Test Bot mid-conversation ends it, and the bot stops answering", async () => {
  await withBot(async (h) => {
    const { server, url, botId } = h;
    const person = await reviewer(h);
    const client = person.client({ transport: "http" });
    await client.connect();
    const heard = listen(client);
    const { conversationId } = await say(client, botId, opus(4));
    await heard.next();
    await heard.next();

    assert.equal((await call(url, "POST", "/v2/blocks", person.token, { userId: botId })).status, 200);
    // The next Talk is checked again (no grace period here): the conversation ends for both.
    await talkStart(client, botId, "after-block", "pcm16le16k");
    assert.equal((await client.waitFor("talk-refused")).reason, "not-friends");
    assert.ok(!server.relay.snapshot().some((c) => c.id === conversationId));
    await until(() => server.testBot!.conversationCount === 0 && server.relay.snapshot().length === 0, "the bot to drop it");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(heard.started, 2);
    client.close();
  }, { authTtlMs: 0 });
});

test("the Test Bot never rings: a caller who left before the echo isn't rung", async () => {
  await withBot(async (h) => {
    const { server, botId, pusher } = h;
    // An iPhone the bot could ring through PushToTalk, if it ever rang.
    const client = (await reviewer(h, "Reviewer", "ios")).client();
    await client.connect();
    const { conversationId } = await say(client, botId, opus(4));
    // Leave while the bot waits to reply.
    await until(() => server.relay.snapshot().some((c) => c.joined.includes(botId)), "the bot to answer");
    client.send({ type: "leave", conversationId });
    await until(() => server.testBot!.conversationCount === 0 && server.relay.snapshot().length === 0, "the bot to leave");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pusher.sent.length, 0);
    client.close();
  }, { replyDelayMs: 150 });
});

test("the relay refuses, rather than rings, a noRings peer talking to someone who isn't there", async () => {
  const pusher = new DryRunPusher();
  const metrics = new JsonMetricsStore(null);
  const botKeys = deviceKeys("u_bot", "relay-bot", "watchos");
  const phoneKeys = deviceKeys("u_alice", "phone", "ios");
  const phone = {
    id: "phone",
    clientKind: "ios" as const,
    formFactor: "phone" as const,
    delivery: { provider: "apns" as const, mode: "pushtotalk" as const, token: "abcdef", environment: "sandbox" as const },
    receiveMode: "automatic" as const,
    availability: { enabled: true, notifications: "unknown" as const },
    capabilities: { ...structuredClone(DEFAULT_CAPABILITIES), audioFormats: [2] },
    e2ee: phoneKeys.registration,
    lastActiveAt: 0,
    updatedAt: 0,
  };
  const directory = { phones: [phoneKeys.registration.phoneCert], devices: [{ deviceId: "phone", clientKind: "ios", deviceCert: phoneKeys.registration.deviceCert, encCert: phoneKeys.registration.encCert }] };
  let lookups = 0;
  const relay = new Relay({
    accounts: {
      ringLookup: async () => {
        lookups++;
        return { allowed: true, fromName: "Test Bot", devices: [phone] };
      },
      canTalk: async () => true,
      friendKeys: async () => directory,
      devices: async () => [phone],
    },
    pusher,
    metrics,
  });
  const received: ServerMessage[] = [];
  const bot: Peer = { userId: "u_bot", deviceId: "relay-bot", noRings: true, sendJSON: (m) => received.push(m), sendBinary: () => {} };
  relay.connect(bot);
  const conversationId = randomUUID();
  const { bundle } = sealBundle({ conversationId, burstId: "b1", codec: "opus16k", from: "u_bot", to: "u_alice" }, botKeys.sender,
    usableKeys("u_alice", directory, Date.now()).recipients, Date.now());
  relay.handleMessage(bot, { type: "talk-start", to: "u_alice", burstId: "b1", codec: Codec.opus16k, format: 2, conversationId, e2ee: bundle });
  // Refused once the friendship and keys are checked, before any ring is looked up.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(received, [{ type: "talk-refused", burstId: "b1", reason: "unavailable" }]);
  assert.equal(pusher.sent.length, 0);
  assert.equal(lookups, 0);
  assert.deepEqual(relay.snapshot(), []);
  relay.close();
});

test("the committed greeting is Opus frames the apps can play", () => {
  const greeting = loadGreeting();
  assert.ok(greeting.length >= 100 && greeting.length <= 750, `${greeting.length} frames`);
  assert.ok(greeting.every((p) => p.length > 0 && p.length <= MAX_OPUS_PACKET_BYTES));
});

test("telemetry marks the Test Bot's conversations", () => {
  const events = [
    { source: "server", name: "talkStart", t: 1, detail: "u_rev -> u_bot" },
    { source: "server", name: "pushSent", t: 2, detail: "watch; r_abc; watchos test/connection" },
    { source: "server", name: "pushAccepted", t: 3, detail: "local ring" },
    { source: "server", name: "testBotAnswered", t: 500, detail: "1 buffered" },
    { source: "server", name: "receiverJoined", t: 501, detail: "1 buffered" },
  ];
  assert.equal(conversationRecord("c1", events).testBot, true);
  assert.equal(conversationRecord("c2", events.filter((e) => e.name !== "testBotAnswered")).testBot, undefined);
});
