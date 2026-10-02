// Usage analytics (stats.ts) and the daily rollup (rollup-main.ts): totals from Firestore and
// telemetry entries, never names or account lists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts, type DeviceRegistration } from "../src/accounts.ts";
import { DEFAULT_CAPABILITIES, type ClientKind, type Delivery } from "../src/contract.ts";
import { MemoryDocs } from "../src/docs.ts";
import { activeAccounts, activity, conversationStats, dailyStats, mergeConversationStats, rollingStats, usageSnapshot } from "../src/stats.ts";
import { rollup } from "../src/rollup-main.ts";
import { rollingRun } from "../src/rolling-main.ts";
import { MemorySink } from "../src/telemetry.ts";
import type { LogEntry } from "../src/log-reader.ts";

const DAY = 86_400_000;

const device = (clientKind: ClientKind, delivery: Delivery): DeviceRegistration => ({
  clientKind,
  delivery,
  availability: { enabled: true, notifications: "authorized" },
  capabilities: structuredClone(DEFAULT_CAPABILITIES),
});

async function sampleAccounts(now: number) {
  const docs = new MemoryDocs();
  const clock = { t: now - 10 * DAY };
  const accounts = new Accounts(docs, { now: () => clock.t });
  const alice = (await accounts.signInWithApple("apple.alice", "Alice")).user;
  const bob = (await accounts.signInWithApple("apple.bob", "Bob")).user;
  clock.t = now - 2 * DAY;
  const carol = (await accounts.signInWithApple("apple.carol", "Carol")).user;
  clock.t = now - 10 * DAY + 3_600_000;
  const invite = await accounts.createInvite(alice.id);
  await accounts.acceptInvite(invite.code, bob.id);
  clock.t = now - DAY / 2;
  await accounts.setAvatar(alice.id, "honey");
  await accounts.setFavorite(bob.id, alice.id, true);
  await accounts.setPreferredFormFactor(bob.id, "phone");
  await accounts.registerDevice(alice.id, "a-watch", device("watchos", { provider: "apns", mode: "alert", token: "w1", environment: "production" }));
  await accounts.registerDevice(bob.id, "b-phone", device("ios", { provider: "apns", mode: "pushtotalk", token: "p1", environment: "production" }));
  await accounts.registerDevice(bob.id, "b-watch", device("watchos", { provider: "apns", mode: "alert", token: "w2", environment: "production" }));
  // An iPhone rung only while the app is open.
  await accounts.registerDevice(carol.id, "c-phone", device("ios", { provider: "relay", mode: "foreground" }));
  await accounts.recordMessage(alice.id, bob.id, now - DAY / 4);
  return { docs, alice, bob, carol };
}

test("the usage snapshot counts pictures, friends, devices and Ring Me On", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const { docs } = await sampleAccounts(now);
  const usage = await usageSnapshot(docs, now);
  assert.equal(usage.accounts, 3);
  assert.equal(usage.newAccounts7d, 1);
  assert.deepEqual(usage.pictures, { honey: 1, default: 2 });
  assert.deepEqual(usage.friends, { "1": 2, "0": 1 });
  assert.equal(usage.friendships, 1);
  assert.equal(usage.hoursToFirstFriendP50, 1);
  assert.equal(usage.accountsWithFavorites, 1);
  assert.deepEqual(usage.devices, { watch: 1, both: 1, iphone: 1 });
  assert.deepEqual(usage.iphones, { walkieTalkie: 1, appOnly: 1 });
  assert.deepEqual(usage.ringOn, { default: 2, iphone: 1 });
  assert.deepEqual(usage.lastHeard, { never: 2, day: 1 });
  assert.doesNotMatch(JSON.stringify(usage), /Alice|Bob|Carol|u_/);
});

const entry = (timestamp: string, e: Omit<LogEntry, "timestamp" | "severity">): LogEntry => ({ timestamp, severity: "INFO", ...e }) as LogEntry;

function sampleEntries(): LogEntry[] {
  return [
    entry("2026-10-09T08:00:00Z", { kind: "oao.conversation", from: "u_a", to: "u_b", outcome: "answered", ringPlatform: "watch", rings: [{}], callerTalkMs: 30_000, calleeTalkMs: 12_000, calleeBursts: 2 }),
    entry("2026-10-09T08:01:00Z", { kind: "oao.device", userId: "u_b", role: "receiver", platform: "watch", outcome: "answered", via: "notification" }),
    entry("2026-10-09T08:01:00Z", { kind: "oao.device", userId: "u_a", role: "sender", platform: "iphone", outcome: "sent" }),
    entry("2026-10-09T09:00:00Z", { kind: "oao.conversation", from: "u_b", to: "u_c", outcome: "unavailable", rings: [], callerTalkMs: 2_000 }),
    entry("2026-10-09T10:00:00Z", { kind: "oao.event", name: "appForeground", userId: "u_d" }),
    entry("2026-10-09T10:05:00Z", { kind: "oao.event", name: "onboardingFinished", userId: "u_d", walkieTalkieOn: true }),
    entry("2026-10-09T11:00:00Z", { kind: "oao.action", action: "account_created", userId: "u_d" }),
    entry("2026-10-09T11:10:00Z", { kind: "oao.action", action: "invite_created", userId: "u_d" }),
    entry("2026-10-09T12:00:00Z", { kind: "oao.action", action: "invite_accepted", userId: "u_e", inviteAgeMs: 3 * 3_600_000 }),
    entry("2026-10-09T12:30:00Z", { kind: "oao.action", action: "avatar_set", userId: "u_e", avatar: "pirate" }),
    entry("2026-10-09T13:00:00Z", { kind: "oao.device", userId: "u_c", role: "receiver", platform: "iphone", outcome: "declined" }),
    // Earlier in the week and the month: counted in WAU and MAU only.
    entry("2026-10-05T10:00:00Z", { kind: "oao.event", name: "appForeground", userId: "u_f" }),
    entry("2026-09-20T10:00:00Z", { kind: "oao.event", name: "appForeground", userId: "u_g" }),
  ];
}

test("a day's activity: active accounts, conversations, talk time, invites and onboarding", () => {
  const a = activity(sampleEntries().slice(0, 11));
  // Talked or listened to a friend: u_a and u_b (who answered, then rang u_c). u_c was rung but
  // never listened; u_d and u_e only used the app.
  assert.equal(a.activeAccounts, 2);
  assert.equal(a.talkers, 2);
  assert.equal(a.openedApp, 1);
  assert.deepEqual(a.conversations, { answered: 1, unavailable: 1 });
  assert.deepEqual(a.ringsTo, { watch: 1 });
  assert.equal(a.conversationsWithReplies, 1);
  assert.equal(a.talkMinutes, 0.73);
  assert.deepEqual(a.answeredVia, { "watch notification": 1 });
  assert.deepEqual(a.talkedFrom, { iphone: 1 });
  assert.equal(a.declined, 1);
  assert.deepEqual([a.newAccounts, a.invitesCreated, a.invitesAccepted, a.inviteAcceptHoursP50], [1, 1, 1, 3]);
  assert.deepEqual(a.pictureChanges, { pirate: 1 });
  assert.deepEqual([a.onboardingFinished, a.onboardingWalkieTalkieOn], [1, 1]);
});

test("DAU, WAU and MAU count distinct accounts over 1, 7 and 30 days", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const { docs } = await sampleAccounts(now);
  const stats = dailyStats("2026-10-09", [
    ...sampleEntries(),
    entry("2026-10-05T10:00:00Z", { kind: "oao.conversation", from: "u_f", to: "u_a", outcome: "missed", rings: [{}] }),
    entry("2026-09-20T10:00:00Z", { kind: "oao.conversation", from: "u_g", to: "u_a", outcome: "live", rings: [] }),
  ], await usageSnapshot(docs, now));
  assert.deepEqual([stats.dau, stats.wau, stats.mau], [2, 3, 4]);
});

test("the rollup writes stats/{date} and logs the daily measures", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const { docs } = await sampleAccounts(now);
  const sink = new MemorySink();
  let asked: [string, string] | undefined;
  await rollup("2026-10-09", docs, async (since, until) => {
    asked = [since.toISOString(), until.toISOString()];
    return sampleEntries();
  }, sink as any);
  assert.deepEqual(asked, ["2026-09-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z"]);
  const [doc] = await docs.getAll(["stats/2026-10-09"]);
  assert.equal(doc!.dau, 2);
  assert.equal((doc!.usage as any).accounts, 3);
  assert.equal((doc!.day as any).talkers, 2);
  assert.doesNotMatch(JSON.stringify(doc), /u_[a-g]"/);
  assert.deepEqual(sink.of("oao.daily").map((e) => [e.measure, e.value]), [["dau", 2], ["wau", 2], ["mau", 2], ["talkers", 2], ["conversations", 2]]);
  assert.deepEqual(doc!.dauByProvider, { unknown: 2 });
  assert.equal((doc!.conversationStats as any).conversations, 2);
});

// ---- The Ops dashboard's numbers ----

const BOTS = { testBot: "u_bot", canary: "u_canary" };

test("active means talked or listened to a friend; the bots and their conversations don't count", () => {
  const entries = [
    entry("2026-10-09T08:00:00Z", { kind: "oao.conversation", from: "u_a", to: "u_b", outcome: "answered", rings: [{}] }),
    entry("2026-10-09T08:10:00Z", { kind: "oao.conversation", from: "u_c", to: "u_bot", outcome: "answered", testBot: true, rings: [{}] }),
    entry("2026-10-09T08:20:00Z", { kind: "oao.conversation", from: "u_canary", to: "u_bot", outcome: "answered", testBot: true, rings: [{}] }),
    entry("2026-10-09T08:30:00Z", { kind: "oao.conversation", from: "u_d", to: "u_e", outcome: "missed", rings: [{}] }),
    entry("2026-10-09T08:40:00Z", { kind: "oao.conversation", from: "u_f", to: "u_g", outcome: "live", rings: [] }),
    entry("2026-10-09T08:50:00Z", { kind: "oao.event", name: "appForeground", userId: "u_h" }),
  ];
  assert.deepEqual([...activeAccounts(entries, BOTS)].sort(), ["u_a", "u_b", "u_d", "u_f", "u_g"]);
  // The Test Bot switch: its callers count, the bot itself and the Canary never.
  assert.deepEqual([...activeAccounts(entries, { ...BOTS, includeTestBot: true })].sort(), ["u_a", "u_b", "u_c", "u_d", "u_f", "u_g"]);
  // Even without the IDs, a conversation the bot answered is marked.
  assert.ok(!activeAccounts(entries).has("u_c"));
});

// A conversation record as the relay writes it (telemetry.ts), with the fields the dashboard reads.
function conversation(t: string, fields: Record<string, unknown>): LogEntry {
  return entry(t, { kind: "oao.conversation", rings: [], events: [], callerTalkMs: 0, calleeTalkMs: 0, ...fields } as never);
}

const ring = (clientKind: string, provider: string, ok: boolean, extra: Record<string, unknown> = {}) => ({ clientKind, provider, platform: clientKind === "ios" ? "iphone" : "watch", results: [{ ok, ms: 80, ...extra }] });

function todayEntries(): LogEntry[] {
  return [
    // Watch → iPhone, answered, three back-and-forths.
    conversation("2026-10-09T00:05:00Z", { from: "u_a", to: "u_b", outcome: "answered", turns: 3, replyGapsMs: [800, 1200, 2000], fromClientKind: "watchos", toClientKind: "ios", ringClientKind: "ios", rings: [ring("ios", "apns", true)], callerTalkMs: 4000, calleeTalkMs: 3000, events: [{ name: "burstEnded", t: 1, detail: "u_a 2000 ms, 100 frames" }, { name: "burstEnded", t: 2, detail: "u_b 3000 ms, 150 frames" }] }),
    // iPhone → watch, missed after rolling over to the phone.
    conversation("2026-10-09T01:00:00Z", { from: "u_b", to: "u_a", outcome: "missed", turns: 0, replyGapsMs: [], fromClientKind: "ios", toClientKind: "watchos", ringClientKind: "watchos", rings: [ring("watchos", "apns", true), ring("ios", "apns", true)], events: [{ name: "ringRolledOver", t: 1 }, { name: "codecRefused", t: 2 }] }),
    // Apple → Android over the FCM stub: never delivered.
    conversation("2026-10-09T01:30:00Z", { from: "u_a", to: "u_c", outcome: "missed", turns: 0, replyGapsMs: [], fromClientKind: "watchos", toClientKind: "android", ringClientKind: "android", simulatedDelivery: true, rings: [ring("android", "fcm", true, { simulated: true })] }),
    // A push APNs refused for good, and a refused ring.
    conversation("2026-10-09T02:00:00Z", { from: "u_c", to: "u_a", outcome: "push-failed", rings: [{ clientKind: "watchos", provider: "apns", results: [{ ok: false, status: 410, reason: "Unregistered", ms: 50 }] }] }),
    conversation("2026-10-09T02:10:00Z", { from: "u_d", to: "u_a", outcome: "refused", rings: [], events: [{ name: "ringRefused", t: 1 }] }),
    // From a relay before turns were recorded: unknown, not 0.
    conversation("2026-10-09T02:20:00Z", { from: "u_a", to: "u_b", outcome: "live" }),
    // The bots.
    conversation("2026-10-09T02:30:00Z", { from: "u_a", to: "u_bot", outcome: "answered", testBot: true, turns: 2, replyGapsMs: [100, 100], rings: [ring("watchos", "test", true)] }),
    conversation("2026-10-09T02:40:00Z", { from: "u_canary", to: "u_bot", outcome: "answered", testBot: true, turns: 1, replyGapsMs: [100], rings: [ring("watchos", "test", true)] }),
    entry("2026-10-09T00:06:00Z", { kind: "oao.device", userId: "u_b", deviceId: "d_b", role: "receiver", platform: "iphone", clientKind: "ios", build: "182", via: "pushtotalk", outcome: "answered", intervals: { pushToFirstAudioMs: 1100, ringDeliveryMs: 300 }, problems: { relayDropped: 1 }, levels: { sentBursts: 4 } }),
    entry("2026-10-09T00:06:00Z", { kind: "oao.device", userId: "u_a", deviceId: "d_a", role: "sender", platform: "watch", clientKind: "watchos", build: "171", outcome: "sent", intervals: { talkToGoAheadMs: 420 }, problems: {} }),
    entry("2026-10-09T01:06:00Z", { kind: "oao.device", userId: "u_a", deviceId: "d_a", role: "receiver", platform: "watch", clientKind: "watchos", build: "182", via: "notification", outcome: "answered", intervals: { tapToFirstAudioMs: 1300, ringDeliveryMs: 20 }, problems: {} }),
    entry("2026-10-09T01:07:00Z", { kind: "oao.device", userId: "u_bot", role: "receiver", platform: "watch", via: "notification", intervals: { tapToFirstAudioMs: 1 }, problems: {} }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.event", name: "uncleanExit", userId: "u_a", clientKind: "watchos" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.levels", levelDropDb: 12.5 }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.admission", userId: "u_e", error: "client-upgrade-required", clientKind: "ios", build: "143" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.action", action: "account_created", userId: "u_e", provider: "apple" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.action", action: "reported", userId: "u_a", reason: "photo" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.action", action: "blocked", userId: "u_a" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.api", error: "name-not-allowed", status: 400 }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.feedback", userId: "u_b" }),
    entry("2026-10-09T03:00:00Z", { kind: "oao.registration", userId: "u_e" }),
  ];
}

test("today so far: depth, rings, push, speed against targets, quality, builds and safety, with no IDs", () => {
  const now = Date.parse("2026-10-09T03:10:00Z");
  const providers = new Map([["u_a", "apple"], ["u_b", "apple"], ["u_c", "google"]]);
  const r = rollingStats("2026-10-09", todayEntries(), { bots: BOTS, providers, minimumBuilds: { watchos: 180 }, now });
  // Active: u_a, u_b (answered), u_c (rang u_a), u_d (talked, refused).
  assert.equal(r.dau, 4);
  assert.deepEqual(r.dauByProvider, { apple: 2, google: 1, unknown: 1 });
  const c = r.conversationStats;
  assert.equal(c.conversations, 6);
  assert.deepEqual(c.depth.histogram, { "0": 2, "1": 0, "2-3": 1, "4-6": 0, "7-12": 0, "13+": 0 });
  assert.deepEqual([c.depth.conversations, c.depth.turnsSum, c.depth.gotReply, c.depth.replyGapMedianMs], [3, 3, 1, 1200]);
  assert.equal(c.activePairs, 3);
  assert.deepEqual([c.talkMs, c.bursts, c.burstMedianMs], [7000, 2, 2500]);
  assert.deepEqual(c.ecosystems, { "apple-apple": 2, "android-apple": 1 });
  assert.deepEqual(c.formFactors, { "phone-watch": 3 });
  assert.deepEqual(c.startedFrom, { watchos: 2, ios: 1 });
  const rings = c.rings;
  assert.deepEqual([rings.rings, rings.accepted, rings.answered, rings.rolledOver, rings.missed, rings.pushFailed, rings.simulated], [4, 2, 1, 1, 2, 1, 1]);
  assert.deepEqual(rings.byKind, { ios: { accepted: 1, answered: 1 }, watchos: { accepted: 1, answered: 0 }, android: { accepted: 0, answered: 0 } });
  assert.deepEqual(rings.rangOn, { phone: 2, watch: 2 });
  assert.equal(rings.movedFormFactor, 1);
  // The Test Bot's conversation, for the switch.
  assert.equal(r.withTestBot.conversationStats.conversations, 7);
  assert.equal(r.withTestBot.dau, 4);
  // APNs: 3 accepted, 1 gone for good; the stub's delivery apart.
  assert.deepEqual(r.push.byProvider.apns, { accepted: 3, permanent: 1, failed: 0, retried: 0, p50Ms: 80, p95Ms: 80, reasons: { Unregistered: 1 } });
  assert.equal(r.push.simulated, 1);
  const row = (step: string, kind: string) => r.speed.find((x) => x.step === step && x.clientKind === kind)!;
  assert.deepEqual(row("watchTap", "watchos"), { step: "watchTap", clientKind: "watchos", n: 1, p50: 1300, p95: 1300, targetMs: 1000 });
  assert.deepEqual(row("phonePush", "ios"), { step: "phonePush", clientKind: "ios", n: 1, p50: 1100, p95: 1100, targetMs: 1500 });
  assert.deepEqual(row("firstPress", "watchos"), { step: "firstPress", clientKind: "watchos", n: 1, p50: 420, p95: 420, targetMs: 500 });
  assert.deepEqual(row("watchTap", "android"), { step: "watchTap", clientKind: "android", n: 0 });
  assert.deepEqual(r.quality.byKind, { ios: { conversations: 1, crashes: 0 }, watchos: { conversations: 2, crashes: 1 } });
  assert.deepEqual(r.quality.problems, { relayDropped: 1, uncleanExit: 1 });
  assert.deepEqual([r.quality.burstsSent, r.quality.levelDrops, r.quality.levelDropMedianDb], [4, 1, 12.5]);
  assert.deepEqual(r.quality.refusals, { codecRefused: 1 });
  assert.deepEqual(r.quality.admission, { byError: { "client-upgrade-required": 1 }, byBuild: { "ios 143": 1 } });
  assert.deepEqual(r.builds, { ios: { devices: 1, newest: "182", onNewest: 1, belowMinimum: 0 }, watchos: { devices: 1, newest: "182", onNewest: 1, belowMinimum: 0 } });
  assert.deepEqual(r.safety, { reports: 1, photoReports: 1, blocks: 1, namesRefused: 1, deletions: 0, ringsRefused: 1 });
  assert.deepEqual(r.growth, { signUps: { apple: 1 }, registrations: 1 });
  assert.deepEqual(r.feedback, { problemReports: 1, diagnosticsUploads: 0 });
  // Fifteen-minute slots: running totals so far, null for what's still to come.
  assert.equal(r.slots.dau.length, 96);
  assert.deepEqual(r.slots.dau.slice(0, 13), [2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 4, 4, 4]);
  assert.equal(r.slots.dau[13], null);
  assert.deepEqual(r.slots.conversations.slice(0, 13), [1, 1, 1, 1, 2, 2, 3, 3, 5, 6, 6, 6, 6]);
  assert.doesNotMatch(JSON.stringify(r), /u_[a-z]/);
});

test("several days' conversation numbers add up", () => {
  const day = conversationStats(todayEntries(), BOTS);
  const both = mergeConversationStats([day, day]);
  assert.equal(both.conversations, 12);
  assert.equal(both.depth.histogram["2-3"], 2);
  assert.equal(both.depth.replyGapMedianMs, 1200);
  assert.equal(both.rings.answered, 2);
  assert.deepEqual(both.rings.byKind.ios, { accepted: 2, answered: 2 });
  assert.equal(both.activePairs, 3);
});

test("the usage snapshot's new splits: sign-in providers, Roll Over and reachability", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const { docs, bob } = await sampleAccounts(now);
  await new Accounts(docs).setRollOver(bob.id, true);
  const usage = await usageSnapshot(docs, now);
  assert.deepEqual(usage.providers, { apple: 3 });
  assert.equal(usage.rollOver, 1);
  // Carol's iPhone is rung only while the app is open.
  assert.deepEqual(usage.reachability, { unreachable: 1, appOnly: 1, notificationsDenied: 0, availabilityOff: 0 });
});

test("the rolling run: statsLive/{date}, the peaks kept, the Canary's history and open reports", async () => {
  const docs = new MemoryDocs();
  const accounts = new Accounts(docs, { now: () => Date.parse("2026-10-09T01:00:00Z") });
  const a = (await accounts.signInWithApple("apple.a", "A")).user;
  const b = (await accounts.signInWithApple("apple.b", "B")).user;
  await accounts.report(a.id, { userId: b.id, reason: "spam" });
  const sink = new MemorySink();
  const read = async (kinds: string[], since: Date, until: Date) => {
    assert.ok(kinds.includes("oao.admission"));
    assert.deepEqual([since.toISOString(), until.toISOString()], ["2026-10-09T00:00:00.000Z", "2026-10-09T03:10:00.000Z"]);
    return todayEntries();
  };
  const first = await rollingRun({
    now: Date.parse("2026-10-09T03:10:00Z"),
    docs,
    out: docs,
    read,
    bots: BOTS,
    relay: async () => ({ total: 1, answering: 1, peaks: { conversations: { value: 5, at: Date.parse("2026-10-09T02:00:00Z") }, streams: { value: 9, at: Date.parse("2026-10-09T02:00:00Z") } } }),
    canary: async () => ({ at: Date.parse("2026-10-09T03:10:00Z"), ok: true, connectMs: 120, goAheadMs: 90, firstFrameMs: 700 }),
    sink,
  });
  assert.deepEqual(first.openReports, { count: 1, oldestAt: Date.parse("2026-10-09T01:00:00Z") });
  assert.deepEqual(first.accounts, { total: 2, byProvider: { apple: 2 } });
  assert.equal(first.canary.passes, 1);
  // The relay restarted (its peaks are lower) and the Canary failed: the day's peaks stay.
  const second = await rollingRun({
    now: Date.parse("2026-10-09T03:10:00Z"),
    docs,
    out: docs,
    read,
    bots: BOTS,
    relay: async () => ({ total: 1, answering: 1, peaks: { conversations: { value: 1, at: Date.parse("2026-10-09T03:00:00Z") }, streams: { value: 12, at: Date.parse("2026-10-09T03:00:00Z") } } }),
    canary: async () => ({ at: Date.parse("2026-10-09T03:25:00Z"), ok: false, error: "the bot's greeting: timed out" }),
    sink,
  });
  assert.deepEqual(second.peaks.conversations.value, 5);
  assert.deepEqual(second.peaks.streams.value, 12);
  assert.deepEqual([second.canary.runs, second.canary.passes, second.canary.last?.ok], [2, 1, false]);
  const [stored] = await docs.getAll(["statsLive/2026-10-09"]);
  assert.equal((stored!.expireAt as Date).toISOString(), "2026-10-23T00:00:00.000Z");
  assert.equal(stored!.dau, 4);
  assert.doesNotMatch(JSON.stringify(stored), /u_[A-Za-z0-9_-]{10}/);
  assert.deepEqual(sink.of("oao.canary").map((e) => [e.ok, e.severity]), [[true, "INFO"], [false, "WARNING"]]);
});
