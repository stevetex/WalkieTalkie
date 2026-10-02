// The Over&Out Ops dashboard (OPS_DASHBOARD_SPEC.md): the Canary against a relay with the
// always-on Test Bot, the relay nodes' live views summed, and the Ops service's routes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Accounts } from "../src/accounts.ts";
import { CANARY_DEVICE, canaryToken, runCanary } from "../src/canary.ts";
import { DEFAULT_CAPABILITIES } from "../src/contract.ts";
import { MemoryDocs } from "../src/docs.ts";
import type { LogEntry } from "../src/log-reader.ts";
import { buildSummary, createOps } from "../src/ops-main.ts";
import { fetchRelayStats, sumRelayStats } from "../src/ops-relay.ts";
import { REPORTS, runReports } from "../src/reports.ts";
import { conversationStats } from "../src/stats.ts";
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

// ---- The Ops service (ops-main.ts) and the reports (reports.ts) ----

function conversationEntry(t: string, fields: Record<string, unknown>): LogEntry {
  return { timestamp: t, severity: "INFO", kind: "oao.conversation", rings: [], events: [], callerTalkMs: 1000, calleeTalkMs: 500, ...fields } as LogEntry;
}

async function serve(handler: ReturnType<typeof createOps>, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("the Ops service: IAP's user or nothing, the page, the cached live view, the summary and Regenerate", async () => {
  const out = new MemoryDocs();
  const now = Date.parse("2026-10-09T12:00:00Z");
  const day = (date: string, n: number) => ({
    set: `stats/${date}`,
    data: { date, dau: n, wau: n + 1, mau: n + 2, day: { conversations: { answered: n } }, usage: { accounts: 10 }, conversationStats: conversationStats([conversationEntry(`${date}T10:00:00Z`, { from: "u_a", to: "u_b", outcome: "answered", turns: n })]), createdAt: new Date() },
  });
  await out.commit([day("2026-10-07", 2), day("2026-10-08", 3), { set: "statsLive/2026-10-09", data: { date: "2026-10-09", dau: 4, generatedAt: now, conversationStats: conversationStats([conversationEntry("2026-10-09T09:00:00Z", { from: "u_a", to: "u_b", outcome: "missed", turns: 0 })]) } }]);
  let liveCalls = 0;
  const started: string[] = [];
  const logs: string[] = [];
  const handler = createOps({
    ctx: { docs: out, out, read: async () => [] },
    live: async () => {
      liveCalls++;
      return { now, nodes: [{ url: "http://relay", ok: true, node: "relay-1" }], conversations: { open: 1, talking: 1, ringing: 0, waiting: 0 }, streams: { ios: 1, watchos: 1, android: 0, wearos: 0 }, pcmOnly: 0, held: { bursts: 0, bytes: 0 }, peaks: { conversations: { value: 1, at: now }, streams: { value: 2, at: now } }, live: [] };
    },
    nearLive: async () => null,
    runReport: async (id) => void started.push(id),
    local: false,
    projectId: "walkie-talkie-relay",
    monitoringDashboard: "https://console.cloud.google.com/monitoring/dashboards/builder/x",
    now: () => now,
    log: (line) => logs.push(line),
  });
  await serve(handler, async (url) => {
    const iap = { "x-goog-authenticated-user-email": "accounts.google.com:steve@example.com" };
    // Only through IAP.
    assert.equal((await fetch(`${url}/`)).status, 403);
    assert.equal((await fetch(`${url}/api/live`)).status, 403);
    const page = await fetch(`${url}/`, { headers: iap });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.match(await page.text(), /Over&amp;Out Ops/);
    assert.equal((await fetch(`${url}/ops.js`, { headers: iap })).status, 200);
    // The live view, once for both requests (cached 3 s).
    const live = await (await fetch(`${url}/api/live`, { headers: iap })).json();
    await fetch(`${url}/api/live`, { headers: iap });
    assert.equal(liveCalls, 1);
    assert.equal(live.user, "steve@example.com");
    const summary = await (await fetch(`${url}/api/summary?range=7d`, { headers: iap })).json();
    assert.deepEqual(summary.days.map((d: any) => [d.date, d.dau, d.conversations]), [["2026-10-07", 2, 1], ["2026-10-08", 3, 1]]);
    assert.equal(summary.today.dau, 4);
    assert.equal(summary.ranges.today.conversationStats.conversations, 1);
    assert.equal(summary.ranges["7d"].conversationStats.conversations, 3);
    assert.equal(summary.ranges["7d"].conversationStats.depth.turnsSum, 5);
    assert.equal(summary.links.monitoring, "https://console.cloud.google.com/monitoring/dashboards/builder/x");
    // A report that hasn't been made yet; Regenerate needs the page's header.
    assert.equal((await fetch(`${url}/reports/when-people-talk`, { headers: iap })).status, 404);
    assert.equal((await fetch(`${url}/api/reports/when-people-talk/run`, { method: "POST", headers: iap })).status, 403);
    assert.equal((await fetch(`${url}/api/reports/nope/run`, { method: "POST", headers: { ...iap, "x-ops-request": "1" } })).status, 404);
    assert.equal((await fetch(`${url}/api/reports/when-people-talk/run`, { method: "POST", headers: { ...iap, "x-ops-request": "1" } })).status, 202);
    assert.deepEqual(started, ["when-people-talk"]);
    const list = await (await fetch(`${url}/api/reports`, { headers: iap })).json();
    assert.equal(list.reports.length, REPORTS.length);
  });
  // Who looked at what is in the service's log.
  assert.ok(logs.some((l) => JSON.parse(l).user === "steve@example.com" && JSON.parse(l).path === "/api/summary"));
  assert.ok(logs.some((l) => JSON.parse(l).message.includes("asked for report when-people-talk")));
});

test("the reports render, store their history, keep totals only, and retention adds each night once", async () => {
  const docs = new MemoryDocs();
  const accounts = new Accounts(docs, { now: () => Date.parse("2026-10-07T09:00:00Z") });
  const a = (await accounts.signInWithApple("apple.a", "Alice")).user;
  const b = (await accounts.signInWithApple("apple.b", "Bob")).user;
  await accounts.acceptInvite((await accounts.createInvite(a.id)).code, b.id);
  const entries: LogEntry[] = [
    conversationEntry("2026-10-08T10:00:00Z", { conversationId: "c1", from: a.id, to: b.id, outcome: "answered", delivered: true, turns: 3, replyGapsMs: [900, 1100, 1500], fromClientKind: "watchos", toClientKind: "ios", ringClientKind: "ios", rings: [{ clientKind: "ios", provider: "apns", results: [{ ok: true, ms: 70 }] }] }),
    conversationEntry("2026-10-08T11:00:00Z", { conversationId: "c2", from: b.id, to: a.id, outcome: "missed", turns: 0, replyGapsMs: [], fromClientKind: "ios", toClientKind: "android", rings: [{ clientKind: "android", provider: "fcm", results: [{ ok: true, simulated: true }] }], simulatedDelivery: true }),
    { timestamp: "2026-10-08T10:01:00Z", severity: "INFO", kind: "oao.device", conversationId: "c1", userId: b.id, role: "receiver", clientKind: "ios", build: "182", via: "pushtotalk", route: "BluetoothHFP", intervals: { pushToFirstAudioMs: 1100 }, problems: {}, levels: { sentRmsDb: -24, playedRmsDb: -27 } },
    { timestamp: "2026-10-08T10:02:00Z", severity: "INFO", kind: "oao.apns", event: "pushFailed", pushType: "alert", status: 410, reason: "Unregistered" },
    { timestamp: "2026-10-08T10:03:00Z", severity: "INFO", kind: "oao.action", action: "invite_created", userId: a.id },
  ];
  const ctx = { docs, out: docs, read: async () => entries, bots: {}, now: Date.parse("2026-10-09T00:40:00Z"), monitoring: null };
  const results = await runReports(null, ctx);
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.equal(results.length, 10);
  for (const report of REPORTS) {
    const [doc] = await docs.getAll([`opsReports/${report.id}`, `opsReports/${report.id}/history/2026-10-09`]).then((d) => [d[0]]);
    assert.equal(doc!.status, "ok", report.id);
    const html = String(doc!.html);
    assert.match(html, /^<!doctype html>/);
    assert.doesNotMatch(html, new RegExp(`${a.id}|${b.id}|Alice|Bob`), report.id);
    const [history] = await docs.getAll([`opsReports/${report.id}/history/2026-10-09`]);
    assert.ok(history!.expireAt instanceof Date);
  }
  // Alice and Bob signed up on 2026-10-07; on 2026-10-08 (day 1) both talked.
  const [retention] = await docs.getAll(["opsReports/retention-cohorts"]);
  const table = (retention!.data as any).table;
  assert.deepEqual(table["2026-10-05|all"].d1, { eligible: 2, active: 2 });
  assert.deepEqual(table["2026-10-05|provider:apple"].d1, { eligible: 2, active: 2 });
  // The same night again: re-rendered, not counted twice.
  await runReports(["retention-cohorts"], ctx);
  const [again] = await docs.getAll(["opsReports/retention-cohorts"]);
  assert.deepEqual((again!.data as any).table["2026-10-05|all"].d1, { eligible: 2, active: 2 });
  // The storage audit's counts feed the dashboard's Data section.
  const [audit] = await docs.getAll(["opsReports/storage-audit"]);
  assert.equal((audit!.data as any).counts.users, 2);
  assert.equal((audit!.data as any).counts["friends (all)"], 2);
  assert.match(String((await docs.getAll(["opsReports/cross-platform"]))[0]!.html), /Android–Apple/);
  // An unknown report is refused up front.
  await assert.rejects(runReports(["nope"], ctx), /no such report/);
  // The summary reads the audit.
  const summary = await buildSummary(docs, null, { monitoring: null, alerts: "", uptime: "" }, ctx.now);
  assert.equal((summary.storage as any).counts.users, 2);
});
