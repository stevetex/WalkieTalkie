// Usage analytics (stats.ts) and the daily rollup (rollup-main.ts): totals from Firestore and
// telemetry entries, never names or account lists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { MemoryDocs } from "../src/docs.ts";
import { activity, dailyStats, usageSnapshot } from "../src/stats.ts";
import { rollup } from "../src/rollup-main.ts";
import { MemorySink } from "../src/telemetry.ts";
import type { LogEntry } from "../src/log-reader.ts";

const DAY = 86_400_000;

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
  await accounts.setRingOn(bob.id, "iphone");
  await accounts.registerDevice(alice.id, "a-watch", { platform: "watch", pushToken: "w1", apnsEnvironment: "production" });
  await accounts.registerDevice(bob.id, "b-phone", { platform: "iphone", pushToken: "p1", pushType: "pushtotalk", apnsEnvironment: "production" });
  await accounts.registerDevice(bob.id, "b-watch", { platform: "watch", pushToken: "w2", apnsEnvironment: "production" });
  await accounts.registerDevice(carol.id, "c-phone", { platform: "iphone", pushToken: "app:", apnsEnvironment: "production" });
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
  assert.equal(a.activeAccounts, 5); // u_a, u_b, u_d, u_e, u_c (declined)
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
  const stats = dailyStats("2026-10-09", sampleEntries(), await usageSnapshot(docs, now));
  assert.deepEqual([stats.dau, stats.wau, stats.mau], [5, 6, 7]);
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
  assert.equal(doc!.dau, 5);
  assert.equal((doc!.usage as any).accounts, 3);
  assert.equal((doc!.day as any).talkers, 2);
  assert.doesNotMatch(JSON.stringify(doc), /u_[a-g]"/);
  assert.deepEqual(sink.of("oao.daily").map((e) => [e.measure, e.value]), [["dau", 5], ["wau", 6], ["mau", 7], ["talkers", 2], ["conversations", 2]]);
});
