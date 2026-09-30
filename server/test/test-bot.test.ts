// The always-on Test Bot (test-bot.ts) inside the relay, with the account API, as a reviewer
// meets it: befriend it with its standing invite, ring it from a watch (the HTTP stream) or an
// iPhone (the WebSocket here; PushToTalk only matters for rings to the iPhone, which the bot
// never makes), hear the greeting and the echo, and block or report it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { apiFromEnv } from "../src/api-main.ts";
import { createApi } from "../src/api.ts";
import { MemoryDocs } from "../src/docs.ts";
import { Relay, type Peer } from "../src/relay.ts";
import { Codec, MAX_OPUS_PACKET_BYTES, type ServerMessage } from "../src/protocol.ts";
import { SessionSigner, SessionVerifier, generateSigningKey } from "../src/session.ts";
import { MemorySink, TelemetryMetricsStore, conversationRecord } from "../src/telemetry.ts";
import { activeAccounts } from "../src/stats.ts";
import { JsonDeviceStore, JsonMetricsStore } from "../src/store.ts";
import { loadGreeting } from "../src/test-bot.ts";
import { SpikeClient } from "../tools/client.ts";

const INVITE = "bot-invite-code-1234";
// A short stand-in for the committed greeting: three "Opus packets" the tests can tell apart.
const GREETING = [Buffer.from([0xa1, 1]), Buffer.from([0xa1, 2]), Buffer.from([0xa1, 3])];

interface Harness {
  server: RunningServer;
  url: string;
  botId: string;
  sink: MemorySink;
  pusher: DryRunPusher;
}

async function withBot(fn: (h: Harness) => Promise<void>, { authTtlMs, idleMs = 30_000, replyDelayMs = 20 }: { authTtlMs?: number; idleMs?: number; replyDelayMs?: number } = {}): Promise<void> {
  const { signingKey, publicKeys } = generateSigningKey("test");
  const signer = new SessionSigner(signingKey);
  const verifier = new SessionVerifier(publicKeys);
  const docs = new MemoryDocs();
  // The bot's account and its "local:" device, as tools/test-account.ts create makes them.
  const setup = new Accounts(docs);
  const { user: bot } = await setup.signInWithApple("test-bot.overandout", "Test Bot");
  await setup.createSession(bot.id, "test-bot", "watch");
  await setup.registerDevice(bot.id, "test-bot", { platform: "watch", pushToken: `local:${bot.id}`, apnsEnvironment: "sandbox" });
  const accounts = new Accounts(docs, { botInvite: { code: INVITE, userId: bot.id } });
  const api = createApi({
    accounts,
    signer,
    verifier,
    apple: { verify: async (identityToken) => ({ sub: identityToken }) },
    revoker: null,
    inviteBaseUrl: "https://overandout.app/i/",
    log: () => {},
    telemetry: new MemorySink(),
  });
  const sink = new MemorySink();
  const pusher = new DryRunPusher();
  const server = await startServer({
    port: 0,
    dataDir: null,
    token: "shared",
    sessions: verifier,
    accounts,
    api,
    pusher,
    metrics: new TelemetryMetricsStore(sink, { endedMs: 5 }),
    ...(authTtlMs !== undefined ? { authTtlMs } : {}),
    testBot: { userId: bot.id, greeting: GREETING, answerDelayMs: 10, replyDelayMs, frameMs: 0, idleMs, minEchoFrames: 2 },
  });
  try {
    await fn({ server, url: `http://localhost:${server.port}`, botId: bot.id, sink, pusher });
  } finally {
    await server.close();
  }
}

async function call(url: string, method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function signIn(url: string, sub: string, name: string): Promise<{ token: string; user: { id: string; name: string } }> {
  const res = await call(url, "POST", "/v1/auth/apple", null, { identityToken: sub, nonce: "nonce", name, deviceId: `${sub}-phone`, platform: "iphone" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

// A reviewer with the bot as their friend, by its standing invite.
async function reviewer(url: string, sub = "apple.reviewer", name = "Reviewer") {
  const account = await signIn(url, sub, name);
  const accepted = await call(url, "POST", `/v1/invites/${INVITE}/accept`, account.token);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.friend.name, "Test Bot");
  return account;
}

// Distinct PCM frames, so the echo can be checked byte for byte.
function pcm(frames: number, fill = 1): Buffer {
  const buf = Buffer.alloc(frames * 640);
  for (let i = 0; i < buf.length; i++) buf[i] = (i + fill) & 0xff;
  return buf;
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
  const bursts: Array<{ from: string; frames: Buffer[]; ended: boolean }> = [];
  let taken = 0;
  client.onMessage = (m) => {
    if (m.type === "burst-start") bursts.push({ from: m.from, frames: [], ended: false });
    else if (m.type === "burst-end" && bursts.length) bursts.at(-1)!.ended = true;
  };
  client.onFrame = (f) => bursts.at(-1)?.frames.push(f);
  return {
    get started(): number {
      return bursts.length;
    },
    async next(): Promise<{ from: string; codecs: number[]; seqs: number[]; payloads: Buffer[] }> {
      await until(() => bursts[taken]?.ended === true, "a burst");
      const { from, frames } = bursts[taken++];
      return { from, codecs: frames.map((f) => f[0]), seqs: frames.map((f) => f.readUInt32BE(1)), payloads: frames.map((f) => f.subarray(5)) };
    },
  };
}

for (const transport of ["http", "ws"] as const) {
  test(`the Test Bot answers a ring, greets, says each burst back, and leaves with the caller (${transport === "http" ? "the watch's HTTP stream" : "WebSocket"})`, async () => {
    await withBot(async ({ server, url, botId, sink, pusher }) => {
      const { token } = await reviewer(url);
      const client = new SpikeClient({ server: url, userId: "ignored", token, transport });
      await client.connect();
      const heard = listen(client);

      // The ring goes to the bot inside the relay, not through APNs.
      const sent = pcm(12);
      const { conversationId, pushed } = await client.talk(botId, sent, { realtime: false });
      assert.equal(pushed, true);
      assert.equal(pusher.sent.length, 0);

      const greeting = await heard.next();
      assert.equal(greeting.from, botId);
      assert.deepEqual(greeting.codecs, [Codec.opus16k, Codec.opus16k, Codec.opus16k]);
      assert.deepEqual(greeting.seqs, [0, 1, 2]);
      assert.deepEqual(greeting.payloads, GREETING);
      const echo = await heard.next();
      assert.deepEqual(echo.seqs, Array.from({ length: 12 }, (_, i) => i));
      assert.ok(echo.codecs.every((c) => c === Codec.pcm16le16k));
      assert.deepEqual(Buffer.concat(echo.payloads), sent);

      // Live now: the next burst is said back without ringing or greeting again.
      const again = pcm(3, 7);
      const second = await client.talk(botId, again, { realtime: false });
      assert.equal(second.pushed, false);
      assert.equal(second.conversationId, conversationId);
      assert.deepEqual(Buffer.concat((await heard.next()).payloads), again);

      // A tap on Talk (shorter than minEchoFrames) isn't said back.
      await client.talk(botId, pcm(1), { realtime: false });
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
      assert.deepEqual([...activeAccounts([{ ...record, timestamp: "" } as never])], [record.from]);
    });
  });
}

test("a caller who keeps talking isn't talked over: the bot replies once they stop", async () => {
  await withBot(async ({ url, botId }) => {
    const { token } = await reviewer(url);
    const client = new SpikeClient({ server: url, userId: "ignored", token });
    await client.connect();
    const heard = listen(client);
    const first = pcm(4, 1);
    await client.talk(botId, first, { realtime: false });
    // Talking again before the bot replies, and holding the floor for a while.
    client.send({ type: "talk-start", to: botId, burstId: "b2" });
    const second = pcm(5, 9);
    for (let seq = 0; seq < 5; seq++) {
      client.sendFrame(Codec.pcm16le16k, seq, second.subarray(seq * 640, (seq + 1) * 640));
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.equal(heard.started, 0);
    client.send({ type: "talk-end", burstId: "b2" });
    assert.deepEqual((await heard.next()).payloads, GREETING);
    assert.deepEqual(Buffer.concat((await heard.next()).payloads), first);
    assert.deepEqual(Buffer.concat((await heard.next()).payloads), second);
    client.close();
  }, { replyDelayMs: 100 });
});

test("the Test Bot leaves a quiet conversation after the apps' window", async () => {
  await withBot(async ({ server, url, botId }) => {
    const { token } = await reviewer(url);
    const client = new SpikeClient({ server: url, userId: "ignored", token });
    await client.connect();
    const heard = listen(client);
    const { conversationId } = await client.talk(botId, pcm(4), { realtime: false });
    await heard.next();
    await heard.next();
    const left = await client.waitFor("peer-left");
    assert.equal(left.conversationId, conversationId);
    assert.equal(left.peer, botId);
    assert.equal(server.testBot!.conversationCount, 0);
    client.close();
  }, { idleMs: 200 });
});

test("the Test Bot's standing invite: anyone can use it, any number of times, only for the bot", async () => {
  await withBot(async ({ url, botId }) => {
    const alice = await signIn(url, "apple.alice", "Alice");
    const preview = await call(url, "GET", `/v1/invites/${INVITE}`, alice.token);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.from, { id: botId, name: "Test Bot" });
    assert.equal(preview.body.alreadyFriends, false);
    assert.ok(preview.body.expiresAt > Date.now());
    assert.equal((await call(url, "POST", `/v1/invites/${INVITE}/accept`, alice.token)).status, 200);
    // Not used up: Alice again (already friends), then Bob.
    assert.equal((await call(url, "GET", `/v1/invites/${INVITE}`, alice.token)).body.alreadyFriends, true);
    assert.equal((await call(url, "POST", `/v1/invites/${INVITE}/accept`, alice.token)).status, 200);
    await reviewer(url, "apple.bob", "Bob");
    // Alice and Bob are the bot's friends, not each other's.
    assert.deepEqual((await call(url, "GET", "/v1/friends", alice.token)).body.friends.map((f: { name: string }) => f.name), ["Test Bot"]);
    // It isn't a stored invite: nobody can cancel it, and the bot's own invites are as usual.
    assert.equal((await call(url, "DELETE", `/v1/invites/${INVITE}`, alice.token)).status, 404);
    // A different code of the same shape is just an unknown invite.
    assert.equal((await call(url, "GET", `/v1/invites/${INVITE}x`, alice.token)).status, 404);
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
  await withBot(async ({ server, url, botId }) => {
    const { token } = await reviewer(url);
    const report = await call(url, "POST", "/v1/reports", token, { userId: botId, reason: "spam", block: true });
    assert.equal(report.status, 200);
    assert.deepEqual((await call(url, "GET", "/v1/friends", token)).body.friends, []);

    const client = new SpikeClient({ server: url, userId: "ignored", token });
    await client.connect();
    client.send({ type: "talk-start", to: botId, burstId: "b1" });
    assert.equal((await client.waitFor("talk-refused")).reason, "not-friends");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.testBot!.conversationCount, 0);
    assert.ok(!client.received.some((m) => m.type === "burst-start"));

    // The standing invite respects the block, both ways.
    assert.equal((await call(url, "GET", `/v1/invites/${INVITE}`, token)).status, 404);
    assert.equal((await call(url, "POST", `/v1/invites/${INVITE}/accept`, token)).status, 404);
    assert.equal((await call(url, "DELETE", `/v1/blocks/${botId}`, token)).status, 200);
    assert.equal((await call(url, "POST", `/v1/invites/${INVITE}/accept`, token)).status, 200);
    client.close();
  });
});

test("blocking the Test Bot mid-conversation ends it, and the bot stops answering", async () => {
  await withBot(async ({ server, url, botId }) => {
    const { token } = await reviewer(url);
    const client = new SpikeClient({ server: url, userId: "ignored", token, transport: "http" });
    await client.connect();
    const heard = listen(client);
    const { conversationId } = await client.talk(botId, pcm(4), { realtime: false });
    await heard.next();
    await heard.next();

    assert.equal((await call(url, "POST", "/v1/blocks", token, { userId: botId })).status, 200);
    // The next Talk is checked again (no grace period here): the conversation ends for both.
    client.send({ type: "talk-start", to: botId, burstId: "after-block" });
    assert.equal((await client.waitFor("talk-refused")).reason, "not-friends");
    assert.ok(!server.relay.snapshot().some((c) => c.id === conversationId));
    await until(() => server.testBot!.conversationCount === 0 && server.relay.snapshot().length === 0, "the bot to drop it");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(heard.started, 2);
    client.close();
  }, { authTtlMs: 0 });
});

test("the Test Bot never rings: a caller who left before the echo isn't rung", async () => {
  await withBot(async ({ server, url, botId, pusher }) => {
    const { token } = await reviewer(url);
    await call(url, "PUT", "/v1/me/device", token, { platform: "iphone", pushToken: "abcdef0123456789", apnsEnvironment: "sandbox" });
    const client = new SpikeClient({ server: url, userId: "ignored", token });
    await client.connect();
    const { conversationId } = await client.talk(botId, pcm(4), { realtime: false });
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
  const relay = new Relay({
    devices: new JsonDeviceStore(null),
    accounts: {
      ringLookup: async () => ({ allowed: true, fromName: "Test Bot", devices: [{ id: "phone", platform: "iphone", pushToken: "abcdef", pushType: "alert", apnsEnvironment: "sandbox", updatedAt: 0 }] }),
    },
    pusher,
    metrics,
  });
  const received: ServerMessage[] = [];
  const bot: Peer = { userId: "u_bot", deviceId: "relay-bot", account: true, noRings: true, sendJSON: (m) => received.push(m), sendBinary: () => {} };
  relay.connect(bot);
  relay.handleMessage(bot, { type: "talk-start", to: "u_alice", burstId: "b1" });
  assert.deepEqual(received, [{ type: "talk-refused", burstId: "b1", reason: "unavailable" }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pusher.sent.length, 0);
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
    { source: "server", name: "pushSent", t: 2, detail: "watch" },
    { source: "server", name: "pushAccepted", t: 3, detail: "local ring" },
    { source: "server", name: "testBotAnswered", t: 500, detail: "1 buffered" },
    { source: "server", name: "receiverJoined", t: 501, detail: "1 buffered" },
  ];
  assert.equal(conversationRecord("c1", events).testBot, true);
  assert.equal(conversationRecord("c2", events.filter((e) => e.name !== "testBotAnswered")).testBot, undefined);
});
