// The Over&Out Ops dashboard (OPS_DASHBOARD_SPEC.md): the Canary against a relay with the
// always-on Test Bot, the relay nodes' live views summed, and the Ops service's routes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { CANARY_DEVICE, canaryToken, runCanary } from "../src/canary.ts";
import { DEFAULT_CAPABILITIES } from "../src/contract.ts";
import { MemoryDocs } from "../src/docs.ts";
import { fetchRelayStats, sumRelayStats } from "../src/ops-relay.ts";
import { call, withServer, type TestServer } from "./harness.ts";

const GREETING = [Buffer.from([0xa1, 1]), Buffer.from([0xa1, 2]), Buffer.from([0xa1, 3])];

// The Test Bot and the Canary as tools/test-account.ts makes them: accounts made before the relay
// starts (it needs their IDs), the bot rung over its connection, the Canary with an iPhone
// session and the bot as its friend.
async function withBots(fn: (h: TestServer & { botId: string; canaryId: string }) => Promise<void>, { friends = true } = {}): Promise<void> {
  const docs = new MemoryDocs();
  const setup = new Accounts(docs);
  const { user: bot } = await setup.signInWithApple("test-bot.overandout", "Test Bot");
  await setup.createSession(bot.id, "test-bot", "watchos");
  await setup.registerDevice(bot.id, "test-bot", {
    clientKind: "watchos",
    delivery: { provider: "test", mode: "connection" },
    availability: { enabled: true, notifications: "authorized" },
    capabilities: structuredClone(DEFAULT_CAPABILITIES),
  });
  const { user: canary } = await setup.signInWithApple("canary.overandout", "Canary");
  await setup.createSession(canary.id, CANARY_DEVICE, "ios");
  if (friends) await setup.acceptInvite((await setup.createInvite(bot.id)).code, canary.id);
  await withServer(async (h) => fn({ ...h, botId: bot.id, canaryId: canary.id }), {
    docs,
    opsStatsToken: "ops",
    canaryUserId: canary.id,
    testBot: { userId: bot.id, greeting: GREETING, answerDelayMs: 10, replyDelayMs: 20, frameMs: 0, idleMs: 30_000, minEchoFrames: 2 },
  });
}

test("the Canary talks to the Test Bot and times connect, go-ahead and the greeting, out of the live counts", async () => {
  await withBots(async (h) => {
    const token = await canaryToken(h.docs, h.canaryId, h.signer);
    const result = await runCanary({ relayUrl: h.url, token, botUserId: h.botId, timeoutMs: 5000 });
    assert.equal(result.ok, true, result.error);
    for (const ms of [result.connectMs, result.goAheadMs, result.firstFrameMs]) assert.ok(typeof ms === "number" && ms >= 0);
    assert.ok(result.firstFrameMs! >= result.goAheadMs!);
    // Neither the bot nor the Canary shows in the live view, even at its peak.
    const stats = await call(h.url, "GET", "/admin/stats", "ops");
    assert.deepEqual(stats.body.streams, { ios: 0, watchos: 0, android: 0, wearos: 0 });
    assert.deepEqual([stats.body.peaks.conversations.value, stats.body.peaks.streams.value, stats.body.live.length], [0, 0, 0]);
  });
});

test("a Canary that can't talk to the bot says which step failed", async () => {
  await withBots(async (h) => {
    const token = await canaryToken(h.docs, h.canaryId, h.signer);
    const refused = await runCanary({ relayUrl: h.url, token, botUserId: h.botId, timeoutMs: 5000 });
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /^go-ahead: talk-refused not-friends/);
    // A token the relay doesn't take fails at the connection.
    const bad = await runCanary({ relayUrl: h.url, token: `${token}x`, botUserId: h.botId, timeoutMs: 5000 });
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /^connect: /);
    // Without its session, there's no token to sign.
    await h.docs.commit([{ delete: `users/${h.canaryId}/sessions/${CANARY_DEVICE}` }]);
    await assert.rejects(canaryToken(h.docs, h.canaryId, h.signer), /no session/);
  }, { friends: false });
});

test("every node's live view summed; a node that doesn't answer is marked down", async () => {
  await withBots(async (h) => {
    const answers = await fetchRelayStats([h.url, "http://127.0.0.1:9", h.url], "ops", 500);
    assert.deepEqual(answers.map((a) => a.ok), [true, false, true]);
    const sum = sumRelayStats(answers);
    assert.deepEqual(sum.nodes.map((n) => n.ok), [true, false, true]);
    assert.equal(typeof sum.nodes[0].revision, "string");
    assert.deepEqual(sum.conversations, { open: 0, talking: 0, ringing: 0, waiting: 0 });
    // Without the token, the node refuses.
    const [refused] = await fetchRelayStats([h.url], "wrong");
    assert.deepEqual([refused.ok, refused.error], [false, "HTTP 401"]);
  });
});
