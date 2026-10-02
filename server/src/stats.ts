// Usage analytics (the Beta telemetry spec's "Usage analytics", approved 2026-09-29, and the
// Over&Out Ops dashboard, OPS_DASHBOARD_SPEC.md): totals only, never names or lists of accounts.
//
//   usageSnapshot      what the accounts look like now, from Firestore: pictures, friends,
//                      favorites, devices, Ring Me On, sign-in providers, reachability
//   activity           what people did in a window, from telemetry entries: active accounts,
//                      conversations, talk time, sign-ups, invites, onboarding
//   conversationStats  how conversations went: back-and-forths, reply gaps, rings and their
//                      outcomes, device pairs. Additive, so the dashboard can sum days
//   dailyStats         one day's activity, plus 7- and 30-day active counts and the snapshot: the
//                      stats/{YYYY-MM-DD} document rollup-main.ts writes
//   rollingStats       today so far, every 15 minutes: statsLive/{YYYY-MM-DD} (rolling-main.ts)
//
// Active (decided 2026-10-01): the account talked or listened to a friend. Opening the app
// doesn't count, and neither do the bots: the Test Bot's and the Canary's accounts never, and
// conversations with them only when the dashboard's Test Bot switch asks (the Canary's never).

import { preferredFormFactorOf, toDevice } from "./accounts.ts";
import { formFactorOf, isClientKind, isNotificationDelivery, platformLabel, type ClientKind, type FormFactor, type MinimumBuilds } from "./contract.ts";
import type { Docs } from "./docs.ts";
import type { FirestoreDocument } from "./firestore.ts";
import type { LogEntry } from "./log-reader.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---- The bots ----

// The accounts usage numbers leave out (TEST_BOT_USER_ID, CANARY_USER_ID), and whether the
// dashboard's Test Bot switch is on.
export interface Bots {
  testBot?: string;
  canary?: string;
  includeTestBot?: boolean;
}

export function botsFromEnv(env: NodeJS.ProcessEnv): Bots {
  return { ...(env.TEST_BOT_USER_ID ? { testBot: env.TEST_BOT_USER_ID } : {}), ...(env.CANARY_USER_ID ? { canary: env.CANARY_USER_ID } : {}) };
}

function isBot(userId: unknown, bots: Bots): boolean {
  return typeof userId === "string" && (userId === bots.testBot || userId === bots.canary);
}

// A conversation usage numbers skip: the Canary's always, the Test Bot's unless asked for.
function skipConversation(e: LogEntry, bots: Bots): boolean {
  const members = [e.from, e.to];
  if (bots.canary && members.includes(bots.canary)) return true;
  const withBot = e.testBot === true || (bots.testBot !== undefined && members.includes(bots.testBot));
  return withBot && !bots.includeTestBot;
}

// ---- What the accounts look like now ----

export interface UsageSnapshot {
  accounts: number;
  newAccounts7d: number;
  // A mascot's ID, "photo", or "default" (Honey).
  pictures: Record<string, number>;
  // Accounts by number of friends: "0", "1", "2-3", "4-9", "10+".
  friends: Record<string, number>;
  friendships: number;
  // Hours from creating the account to its first friend, for accounts that have one.
  hoursToFirstFriendP50?: number;
  accountsWithFavorites: number;
  // "iphone", "watch", "both" or "none": the kinds of device registered for rings.
  devices: Record<string, number>;
  // iPhones in the PushToTalk channel, or reachable only while the app is open.
  iphones: { walkieTalkie: number; appOnly: number };
  // "watch", "iphone" or "default".
  ringOn: Record<string, number>;
  // When each account last heard from anyone: "day", "week", "month", "older", "never".
  lastHeard: Record<string, number>;
  // The Ops dashboard's splits: accounts by sign-in provider ("apple", "google"); accounts with
  // Roll Over on; reachability (no device that rings with the app closed; of those, ones rung
  // only while the app is open; devices with notifications denied or switched off); accounts
  // whose diagnostics were asked for in the last 7 days.
  providers?: Record<string, number>;
  rollOver?: number;
  reachability?: { unreachable: number; appOnly: number; notificationsDenied: number; availabilityOff: number };
  diagnosticsRequested?: number;
}

// Ring Me On as the dashboards label it.
function ringOnLabel(formFactor: FormFactor | undefined): string {
  return formFactor === "phone" ? "iphone" : formFactor ?? "default";
}

function friendBucket(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+";
}

// `users` saves listing them again when the caller has (rollup-main.ts). The bots' accounts are
// left out.
export async function usageSnapshot(docs: Docs, now = Date.now(), listed?: FirestoreDocument[], bots: Bots = {}): Promise<UsageSnapshot> {
  const users = (listed ?? (await docs.list("users"))).filter((u) => !isBot(u.id, bots));
  const snapshot: UsageSnapshot = {
    accounts: users.length,
    newAccounts7d: 0,
    pictures: {},
    friends: {},
    friendships: 0,
    accountsWithFavorites: 0,
    devices: {},
    iphones: { walkieTalkie: 0, appOnly: 0 },
    ringOn: {},
    lastHeard: {},
    providers: {},
    rollOver: 0,
    reachability: { unreachable: 0, appOnly: 0, notificationsDenied: 0, availabilityOff: 0 },
    diagnosticsRequested: 0,
  };
  const reach = snapshot.reachability!;
  const hoursToFirst: number[] = [];
  const perUser = await Promise.all(users.map(async (u) => {
    const [friends, devices] = await Promise.all([docs.list(`users/${u.id}/friends`), docs.list(`users/${u.id}/devices`)]);
    return { u, friends, devices };
  }));
  for (const { u, friends, devices } of perUser) {
    const created = millis(u.data.createdAt);
    if (now - created < 7 * DAY_MS) snapshot.newAccounts7d++;
    bump(snapshot.pictures, typeof u.data.avatar === "string" ? u.data.avatar : typeof u.data.photoVersion === "number" ? "photo" : "default");
    bump(snapshot.friends, friendBucket(friends.length));
    snapshot.friendships += friends.length;
    if (friends.some((f) => f.data.favorite === true)) snapshot.accountsWithFavorites++;
    if (friends.length) hoursToFirst.push((Math.min(...friends.map((f) => millis(f.data.since))) - created) / 3_600_000);
    // Registrations, labelled as the dashboards always have.
    const registered = devices.flatMap((d) => toDevice(d.id, d.data) ?? []);
    const kinds = new Set(registered.map((d) => platformLabel(d.clientKind)));
    bump(snapshot.devices, kinds.has("iphone") && kinds.has("watch") ? "both" : kinds.has("iphone") ? "iphone" : kinds.has("watch") ? "watch" : kinds.size ? [...kinds].sort().join("+") : "none");
    for (const d of registered) {
      if (d.clientKind !== "ios") continue;
      if (d.delivery.provider === "apns" && d.delivery.mode === "pushtotalk") snapshot.iphones.walkieTalkie++;
      else if (d.delivery.provider === "relay") snapshot.iphones.appOnly++;
    }
    bump(snapshot.ringOn, ringOnLabel(preferredFormFactorOf(u.data)));
    const identity = u.data.identity as { provider?: unknown } | undefined;
    bump(snapshot.providers!, typeof identity?.provider === "string" ? identity.provider : "unknown");
    if (u.data.rollOver === true) snapshot.rollOver!++;
    if (now - millis(u.data.diagnosticsRequestedAt) < 7 * DAY_MS) snapshot.diagnosticsRequested!++;
    // Rung with the app closed: switched on, with a push route the person hasn't turned off.
    const rings = registered.some((d) => d.availability.enabled && d.delivery.provider !== "relay" && !(isNotificationDelivery(d.delivery) && d.availability.notifications === "denied"));
    if (!rings) {
      reach.unreachable++;
      if (registered.some((d) => d.delivery.provider === "relay")) reach.appOnly++;
    }
    for (const d of registered) {
      if (d.availability.notifications === "denied") reach.notificationsDenied++;
      if (!d.availability.enabled) reach.availabilityOff++;
    }
    const heard = Math.max(0, ...friends.map((f) => millis(f.data.lastMessageAt)));
    const ago = now - heard;
    bump(snapshot.lastHeard, !heard ? "never" : ago < DAY_MS ? "day" : ago < 7 * DAY_MS ? "week" : ago < 30 * DAY_MS ? "month" : "older");
  }
  // Two entries per friendship, one on each side.
  snapshot.friendships /= 2;
  const p50 = percentile(hoursToFirst, 50);
  if (p50 !== undefined) snapshot.hoursToFirstFriendP50 = Math.round(p50 * 10) / 10;
  return snapshot;
}

// ---- What people did ----

// The entry kinds activity() reads.
export const ACTIVITY_KINDS = ["oao.conversation", "oao.device", "oao.event", "oao.action"];

// Accounts that talked or listened to a friend: the caller of any conversation with a friend in
// it, and the other side once they listened (answered, already there, or replied). The bots'
// accounts never count; conversations with them only as `bots` says.
export function activeAccounts(entries: LogEntry[], bots: Bots = {}): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "oao.conversation" || !e.from || !e.to || skipConversation(e, bots)) continue;
    if (!isBot(e.from, bots)) ids.add(e.from);
    const listened = e.outcome === "answered" || e.outcome === "live" || (e.calleeBursts ?? 0) > 0;
    if (listened && !e.testBot && !isBot(e.to, bots)) ids.add(e.to);
  }
  return ids;
}

export interface Activity {
  activeAccounts: number;
  // Accounts that rang someone.
  talkers: number;
  // Accounts whose app came to the front (build 79 and later).
  openedApp: number;
  conversations: Record<string, number>;
  ringsTo: Record<string, number>;
  conversationsWithReplies: number;
  talkMinutes: number;
  answeredVia: Record<string, number>;
  talkedFrom: Record<string, number>;
  declined: number;
  newAccounts: number;
  deletedAccounts: number;
  invitesCreated: number;
  invitesAccepted: number;
  inviteAcceptHoursP50?: number;
  pictureChanges: Record<string, number>;
  favoritesAdded: number;
  onboardingFinished: number;
  onboardingWalkieTalkieOn: number;
}

export function activity(entries: LogEntry[], bots: Bots = {}): Activity {
  const a: Activity = {
    activeAccounts: activeAccounts(entries, bots).size,
    talkers: 0,
    openedApp: 0,
    conversations: {},
    ringsTo: {},
    conversationsWithReplies: 0,
    talkMinutes: 0,
    answeredVia: {},
    talkedFrom: {},
    declined: 0,
    newAccounts: 0,
    deletedAccounts: 0,
    invitesCreated: 0,
    invitesAccepted: 0,
    pictureChanges: {},
    favoritesAdded: 0,
    onboardingFinished: 0,
    onboardingWalkieTalkieOn: 0,
  };
  const talkers = new Set<string>();
  const opened = new Set<string>();
  const inviteHours: number[] = [];
  let talkMs = 0;
  for (const e of entries) {
    switch (e.kind) {
      case "oao.conversation":
        if (!e.to || skipConversation(e, bots)) break;
        bump(a.conversations, e.outcome);
        if (e.ringPlatform) bump(a.ringsTo, e.ringPlatform);
        if (e.from) talkers.add(e.from);
        if ((e.calleeBursts ?? 0) > 0) a.conversationsWithReplies++;
        talkMs += (e.callerTalkMs ?? 0) + (e.calleeTalkMs ?? 0);
        break;
      case "oao.device":
        if (e.role === "receiver" && e.outcome === "answered" && e.via) bump(a.answeredVia, `${e.platform} ${e.via}`);
        if (e.role === "sender") bump(a.talkedFrom, e.platform ?? "unknown");
        if (e.outcome === "declined") a.declined++;
        break;
      case "oao.event":
        if (e.name === "appForeground" || e.name === "appLaunched") opened.add(e.userId);
        if (e.name === "onboardingFinished") {
          a.onboardingFinished++;
          if (e.walkieTalkieOn === true) a.onboardingWalkieTalkieOn++;
        }
        break;
      case "oao.action":
        if (e.action === "account_created") a.newAccounts++;
        else if (e.action === "account_deleted") a.deletedAccounts++;
        else if (e.action === "invite_created") a.invitesCreated++;
        else if (e.action === "invite_accepted") {
          a.invitesAccepted++;
          if (typeof e.inviteAgeMs === "number") inviteHours.push(e.inviteAgeMs / 3_600_000);
        } else if (e.action === "avatar_set") bump(a.pictureChanges, String(e.avatar));
        else if (e.action === "photo_set") bump(a.pictureChanges, "photo");
        else if (e.action === "favorite" && e.on === true) a.favoritesAdded++;
        break;
    }
  }
  a.talkers = talkers.size;
  a.openedApp = opened.size;
  a.talkMinutes = Math.round(talkMs / 600) / 100;
  const p50 = percentile(inviteHours, 50);
  if (p50 !== undefined) a.inviteAcceptHoursP50 = Math.round(p50 * 10) / 10;
  return a;
}

// ---- One day ----

export interface DailyStats {
  date: string;
  dau: number;
  wau: number;
  mau: number;
  // DAU by sign-in provider (from the accounts), when they were given.
  dauByProvider?: Record<string, number>;
  day: Activity;
  // The day's conversations (the Ops dashboard sums these for 7 and 30 days).
  conversationStats?: ConversationStats;
  // The same with the Test Bot's conversations, for the dashboard's switch.
  withTestBot?: { dau: number; wau: number; mau: number; conversationStats: ConversationStats };
  usage: UsageSnapshot;
}

// `entries` covers the 30 days up to the end of `date` (UTC). `providers`: each account's
// sign-in provider, for the DAU split; never stored.
export function dailyStats(date: string, entries: LogEntry[], usage: UsageSnapshot, bots: Bots = {}, providers?: Map<string, string>): DailyStats {
  const end = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  const within = (days: number) => entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= end - days * DAY_MS && t < end;
  });
  const today = within(1);
  const withBot = { ...bots, includeTestBot: true };
  const active = activeAccounts(today, bots);
  return {
    date,
    dau: active.size,
    wau: activeAccounts(within(7), bots).size,
    mau: activeAccounts(within(30), bots).size,
    ...(providers ? { dauByProvider: byProvider(active, providers) } : {}),
    day: activity(today, bots),
    conversationStats: conversationStats(today, bots),
    withTestBot: {
      dau: activeAccounts(today, withBot).size,
      wau: activeAccounts(within(7), withBot).size,
      mau: activeAccounts(within(30), withBot).size,
      conversationStats: conversationStats(today, withBot),
    },
    usage,
  };
}

export function byProvider(accounts: Set<string>, providers: Map<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of accounts) bump(out, providers.get(id) ?? "unknown");
  return out;
}

// Each account's sign-in provider, from users/{uid}.identity.
export function providersOf(users: FirestoreDocument[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const u of users) {
    const provider = (u.data.identity as { provider?: unknown } | undefined)?.provider;
    if (typeof provider === "string") map.set(u.id, provider);
  }
  return map;
}

// ---- How conversations went (the Ops dashboard) ----

// Back-and-forths per conversation: 0 (no reply), 1, 2–3, 4–6, 7–12, 13+.
export const TURN_BUCKETS = ["0", "1", "2-3", "4-6", "7-12", "13+"] as const;

function turnBucket(turns: number): string {
  return turns === 0 ? "0" : turns === 1 ? "1" : turns <= 3 ? "2-3" : turns <= 6 ? "4-6" : turns <= 12 ? "7-12" : "13+";
}

// The pair of ecosystems ("apple-apple", "apple-android", "android-android") and of form
// factors ("phone-watch", sorted) of a conversation's two sides.
function ecosystem(kind: ClientKind): string {
  return kind === "ios" || kind === "watchos" ? "apple" : "android";
}

function pairOf(a: string, b: string): string {
  return [a, b].sort().join("-");
}

export interface ConversationStats {
  // Conversations with a friend (not the bots, unless asked for), by outcome.
  conversations: number;
  outcomes: Record<string, number>;
  // Started by each client kind (the caller's, when known).
  startedFrom: Record<string, number>;
  // Back-and-forths, over the conversations whose record has them (relays from 2026-10 on).
  depth: {
    conversations: number;
    turnsSum: number;
    turnsMedian?: number;
    histogram: Record<string, number>;
    gotReply: number;
    replyGaps: number;
    replyGapMedianMs?: number;
  };
  // Distinct pairs of friends who had a conversation (a total; the pairs aren't kept).
  activePairs: number;
  talkMs: number;
  bursts: number;
  burstMedianMs?: number;
  // By pair, where both sides' kinds are known.
  formFactors: Record<string, number>;
  ecosystems: Record<string, number>;
  rings: RingStats;
}

export interface RingStats {
  // Conversations that rang someone.
  rings: number;
  // A provider accepted the push (simulated deliveries never count).
  accepted: number;
  answered: number;
  rolledOver: number;
  missed: number;
  declined: number;
  unavailable: number;
  pushFailed: number;
  refused: number;
  // Rung only through a stand-in (the FCM stub, a dry run): listed apart, never delivered.
  simulated: number;
  // Answered and accepted, by the first ring's client kind, for the answer rate.
  byKind: Record<string, { accepted: number; answered: number }>;
  // The first ring's form factor, and rings that moved to the other one (a rollover, or a
  // fallback when the first device couldn't be rung). A ring keeps its ID, so each counts once.
  rangOn: Record<string, number>;
  movedFormFactor: number;
}

function emptyRings(): RingStats {
  return { rings: 0, accepted: 0, answered: 0, rolledOver: 0, missed: 0, declined: 0, unavailable: 0, pushFailed: 0, refused: 0, simulated: 0, byKind: {}, rangOn: {}, movedFormFactor: 0 };
}

export function conversationStats(entries: LogEntry[], bots: Bots = {}): ConversationStats {
  const out: ConversationStats = {
    conversations: 0,
    outcomes: {},
    startedFrom: {},
    depth: { conversations: 0, turnsSum: 0, histogram: Object.fromEntries(TURN_BUCKETS.map((b) => [b, 0])), gotReply: 0, replyGaps: 0 },
    activePairs: 0,
    talkMs: 0,
    bursts: 0,
    formFactors: {},
    ecosystems: {},
    rings: emptyRings(),
  };
  const turns: number[] = [];
  const gaps: number[] = [];
  const burstMs: number[] = [];
  const pairs = new Set<string>();
  const r = out.rings;
  for (const e of entries) {
    if (e.kind !== "oao.conversation" || !e.to || skipConversation(e, bots)) continue;
    out.conversations++;
    bump(out.outcomes, String(e.outcome));
    if (e.fromClientKind) bump(out.startedFrom, e.fromClientKind);
    if (e.from) pairs.add(pairOf(e.from, e.to));
    out.talkMs += (e.callerTalkMs ?? 0) + (e.calleeTalkMs ?? 0);
    const events = (e.events ?? []) as Array<{ name: string; detail?: string }>;
    for (const ev of events) {
      const ms = ev.name === "burstEnded" ? Number(ev.detail?.match(/^\S+ (\d+) ms/)?.[1]) : NaN;
      if (Number.isFinite(ms)) burstMs.push(ms);
    }
    if (typeof e.turns === "number") {
      out.depth.conversations++;
      out.depth.turnsSum += e.turns;
      turns.push(e.turns);
      bump(out.depth.histogram, turnBucket(e.turns));
      if (e.turns >= 1) out.depth.gotReply++;
      for (const g of (e.replyGapsMs ?? []) as number[]) gaps.push(g);
    }
    if (isClientKind(e.fromClientKind) && isClientKind(e.toClientKind)) {
      bump(out.formFactors, pairOf(formFactorOf(e.fromClientKind), formFactorOf(e.toClientKind)));
      bump(out.ecosystems, pairOf(ecosystem(e.fromClientKind), ecosystem(e.toClientKind)));
    }
    const rings = (e.rings ?? []) as Array<{ clientKind?: string; platform?: string; results?: Array<{ ok: boolean; simulated?: boolean }> }>;
    if (!rings.length) continue;
    r.rings++;
    const accepted = rings.some((ring) => ring.results?.some((x) => x.ok && !x.simulated));
    if (accepted) r.accepted++;
    if (e.simulatedDelivery) r.simulated++;
    const has = (name: string) => events.some((ev) => ev.name === name);
    if (e.outcome === "answered") r.answered++;
    if (has("ringRolledOver")) r.rolledOver++;
    if (e.outcome === "missed") r.missed++;
    if (has("declineReported")) r.declined++;
    if (e.outcome === "unavailable") r.unavailable++;
    if (e.outcome === "push-failed") r.pushFailed++;
    if (e.outcome === "refused") r.refused++;
    const kind = e.ringClientKind ?? rings[0].clientKind;
    const kindLabel = typeof kind === "string" ? kind : rings[0].platform === "iphone" ? "ios" : rings[0].platform === "watch" ? "watchos" : "unknown";
    const byKind = (r.byKind[kindLabel] ??= { accepted: 0, answered: 0 });
    if (accepted && !e.simulatedDelivery) {
      byKind.accepted++;
      if (e.outcome === "answered") byKind.answered++;
    }
    const factors = rings.map((ring) => (isClientKind(ring.clientKind) ? formFactorOf(ring.clientKind) : ring.platform === "iphone" ? "phone" : ring.platform === "watch" ? "watch" : "unknown"));
    bump(r.rangOn, factors[0]);
    if (new Set(factors).size > 1) r.movedFormFactor++;
  }
  out.activePairs = pairs.size;
  out.bursts = burstMs.length;
  const turnsMedian = median(turns);
  if (turnsMedian !== undefined) out.depth.turnsMedian = turnsMedian;
  out.depth.replyGaps = gaps.length;
  const gapMedian = median(gaps);
  if (gapMedian !== undefined) out.depth.replyGapMedianMs = Math.round(gapMedian);
  const burstMedian = median(burstMs);
  if (burstMedian !== undefined) out.burstMedianMs = Math.round(burstMedian);
  return out;
}

// Several days' ConversationStats as one: counts add up; medians are each day's, weighted by
// its count (the documents keep no per-conversation values to take a true median of).
export function mergeConversationStats(days: ConversationStats[]): ConversationStats {
  const out = conversationStats([]);
  const weighted = (pick: (d: ConversationStats) => number | undefined, weight: (d: ConversationStats) => number): number | undefined => {
    let sum = 0;
    let n = 0;
    for (const d of days) {
      const v = pick(d);
      if (v === undefined || !weight(d)) continue;
      sum += v * weight(d);
      n += weight(d);
    }
    return n ? sum / n : undefined;
  };
  const add = (into: Record<string, number>, from: Record<string, number> | undefined) => {
    for (const [k, v] of Object.entries(from ?? {})) bump(into, k, v);
  };
  for (const d of days) {
    out.conversations += d.conversations;
    add(out.outcomes, d.outcomes);
    add(out.startedFrom, d.startedFrom);
    out.depth.conversations += d.depth.conversations;
    out.depth.turnsSum += d.depth.turnsSum;
    add(out.depth.histogram, d.depth.histogram);
    out.depth.gotReply += d.depth.gotReply;
    out.depth.replyGaps += d.depth.replyGaps;
    // Pairs can repeat across days: the most in one day is the floor, the sum the ceiling.
    out.activePairs = Math.max(out.activePairs, d.activePairs);
    out.talkMs += d.talkMs;
    out.bursts += d.bursts;
    add(out.formFactors, d.formFactors);
    add(out.ecosystems, d.ecosystems);
    const r = out.rings;
    for (const key of ["rings", "accepted", "answered", "rolledOver", "missed", "declined", "unavailable", "pushFailed", "refused", "simulated", "movedFormFactor"] as const) r[key] += d.rings[key];
    add(r.rangOn, d.rings.rangOn);
    for (const [kind, v] of Object.entries(d.rings.byKind)) {
      const into = (r.byKind[kind] ??= { accepted: 0, answered: 0 });
      into.accepted += v.accepted;
      into.answered += v.answered;
    }
  }
  const turnsMedian = weighted((d) => d.depth.turnsMedian, (d) => d.depth.conversations);
  if (turnsMedian !== undefined) out.depth.turnsMedian = Math.round(turnsMedian * 10) / 10;
  const gap = weighted((d) => d.depth.replyGapMedianMs, (d) => d.depth.replyGaps);
  if (gap !== undefined) out.depth.replyGapMedianMs = Math.round(gap);
  const burst = weighted((d) => d.burstMedianMs, (d) => d.bursts);
  if (burst !== undefined) out.burstMedianMs = Math.round(burst);
  return out;
}

// ---- Today so far (the rolling job) ----

// The entry kinds rollingStats reads.
export const ROLLING_KINDS = [
  "oao.conversation", "oao.device", "oao.apns", "oao.push", "oao.admission", "oao.event", "oao.action",
  "oao.registration", "oao.feedback", "oao.diagnostics", "oao.levels", "oao.api",
];

// The steps the Speed section measures, with their targets (p50, decided 2026-10-01). Android's
// targets come from Phase 1's measurements; until then its rows have none.
export const SPEED_STEPS = [
  { id: "watchTap", label: "Watch: tap → first audio", detail: "app closed, ring notification", interval: "tapToFirstAudioMs", role: "receiver", via: "notification", kinds: ["watchos", "wearos", "android"], targetMs: { watchos: 1000 } },
  { id: "watchAnswer", label: "Watch: in-app Answer → first audio", detail: "app open", interval: "tapToFirstAudioMs", role: "receiver", via: "in app", kinds: ["watchos", "wearos"], targetMs: { watchos: 1500 } },
  { id: "phonePush", label: "iPhone: push sent → first audio", detail: "PushToTalk, no tap", interval: "pushToFirstAudioMs", role: "receiver", kinds: ["ios"], targetMs: { ios: 1500 } },
  { id: "firstPress", label: "First press → go-ahead", detail: "the caller's talk button", interval: "talkToGoAheadMs", role: "sender", kinds: ["watchos", "ios", "android", "wearos"], targetMs: { watchos: 500, ios: 500 } },
  { id: "ringShown", label: "Ring sent → ring shown", detail: "push delivery to the device", interval: "ringDeliveryMs", role: "receiver", kinds: ["watchos", "ios", "android", "wearos"], targetMs: { watchos: 1000, ios: 1000 } },
] as const;

export interface SpeedRow {
  step: string;
  clientKind: string;
  n: number;
  p50?: number;
  p95?: number;
  targetMs?: number;
}

// A device summary's client kind: its own, or from the platform label older builds sent.
function deviceKind(e: LogEntry): string {
  if (isClientKind(e.clientKind)) return e.clientKind;
  return e.platform === "iphone" ? "ios" : e.platform === "watch" ? "watchos" : String(e.platform ?? "unknown");
}

export function speed(entries: LogEntry[], bots: Bots = {}): SpeedRow[] {
  const devices = entries.filter((e) => e.kind === "oao.device" && !isBot(e.userId, bots));
  const rows: SpeedRow[] = [];
  for (const step of SPEED_STEPS) {
    for (const kind of step.kinds) {
      const values = devices
        .filter((e) => e.role === step.role && deviceKind(e) === kind && (!("via" in step) || e.via === step.via))
        .map((e) => e.intervals?.[step.interval])
        .filter((v): v is number => typeof v === "number");
      const target = (step.targetMs as Partial<Record<string, number>>)[kind];
      rows.push({
        step: step.id,
        clientKind: kind,
        n: values.length,
        ...(values.length ? { p50: percentile(values, 50), p95: percentile(values, 95) } : {}),
        ...(target ? { targetMs: target } : {}),
      });
    }
  }
  return rows;
}

export interface PushStats {
  // By provider ("apns", "fcm", "relay", "test"): accepted, rejected for good (the token is gone),
  // other failures, send times, failures by reason.
  byProvider: Record<string, { accepted: number; permanent: number; failed: number; retried: number; p50Ms?: number; p95Ms?: number; reasons: Record<string, number> }>;
  // Stand-in deliveries (the FCM stub, dry runs): never accepted.
  simulated: number;
}

const PERMANENT_REASONS = /Unregistered|BadDeviceToken|DeviceTokenNotForTopic|UNREGISTERED|NOT_FOUND/;

export function pushStats(entries: LogEntry[], bots: Bots = {}): PushStats {
  const out: PushStats = { byProvider: {}, simulated: 0 };
  const times: Record<string, number[]> = {};
  for (const e of entries) {
    if (e.kind !== "oao.conversation" || skipConversation(e, bots)) continue;
    for (const ring of (e.rings ?? []) as Array<{ provider?: string; platform?: string; results?: Array<{ ok: boolean; status?: number; reason?: string; ms?: number; retried?: boolean; simulated?: boolean }> }>) {
      const provider = ring.provider ?? "apns";
      for (const x of ring.results ?? []) {
        if (x.simulated) {
          out.simulated++;
          continue;
        }
        const p = (out.byProvider[provider] ??= { accepted: 0, permanent: 0, failed: 0, retried: 0, reasons: {} });
        if (x.retried) p.retried++;
        if (x.ok) p.accepted++;
        else if (x.status === 410 || PERMANENT_REASONS.test(x.reason ?? "")) p.permanent++;
        else p.failed++;
        if (!x.ok) bump(p.reasons, x.reason ?? (x.status ? `status ${x.status}` : "no answer"));
        if (typeof x.ms === "number") (times[provider] ??= []).push(x.ms);
      }
    }
  }
  for (const [provider, values] of Object.entries(times)) {
    const p = out.byProvider[provider];
    if (!p) continue;
    p.p50Ms = percentile(values, 50);
    p.p95Ms = percentile(values, 95);
  }
  return out;
}

export interface QualityStats {
  // Device summaries (one per device per conversation) and crash-like events, by client kind.
  // Crash-free conversations ≈ 1 − crashes ÷ device summaries: crashes aren't tied to a
  // conversation, so this is the share, not an exact count.
  byKind: Record<string, { conversations: number; crashes: number }>;
  problems: Record<string, number>;
  // Bursts sent, from the per-burst levels, for the silent and clipped shares.
  burstsSent: number;
  levelDropMedianDb?: number;
  levelDrops: number;
  // The relay refused a burst's codec, skipped a burst a device couldn't play, or refused a join.
  refusals: Record<string, number>;
  // Relay admission errors, by error, and by "<clientKind> <build>".
  admission: { byError: Record<string, number>; byBuild: Record<string, number> };
}

const CRASH_EVENTS = new Set(["crash", "hang", "uncleanExit"]);
const EVENT_PROBLEMS = new Set(["pttJoinFailed", "refreshFailed", "uncleanExit", "crash", "hang", "extensionUnfinished", "registrationFailed"]);

export function qualityStats(entries: LogEntry[], bots: Bots = {}): QualityStats {
  const out: QualityStats = { byKind: {}, problems: {}, burstsSent: 0, levelDrops: 0, refusals: {}, admission: { byError: {}, byBuild: {} } };
  const drops: number[] = [];
  for (const e of entries) {
    if (isBot(e.userId, bots)) continue;
    switch (e.kind) {
      case "oao.device": {
        (out.byKind[deviceKind(e)] ??= { conversations: 0, crashes: 0 }).conversations++;
        for (const [name, n] of Object.entries((e.problems ?? {}) as Record<string, number>)) bump(out.problems, name, n);
        out.burstsSent += e.levels?.sentBursts ?? 0;
        break;
      }
      case "oao.event":
        if (CRASH_EVENTS.has(e.name)) (out.byKind[deviceKind(e)] ??= { conversations: 0, crashes: 0 }).crashes++;
        if (EVENT_PROBLEMS.has(e.name)) bump(out.problems, e.name);
        break;
      case "oao.levels":
        if (typeof e.levelDropDb === "number") drops.push(e.levelDropDb);
        if (e.levelDropDb > 10) out.levelDrops++;
        break;
      case "oao.conversation":
        if (skipConversation(e, bots)) break;
        for (const ev of (e.events ?? []) as Array<{ name: string }>) {
          if (ev.name === "codecRefused" || ev.name === "burstUndecodable" || ev.name === "joinRefused") bump(out.refusals, ev.name);
        }
        break;
      case "oao.admission":
        bump(out.admission.byError, String(e.error));
        bump(out.admission.byBuild, `${e.clientKind ?? "unknown"} ${e.build ?? "?"}`);
        break;
    }
  }
  const m = median(drops);
  if (m !== undefined) out.levelDropMedianDb = Math.round(m * 10) / 10;
  return out;
}

// Devices seen in conversations, by client kind: the share on that kind's newest build, and on
// builds below the minimum.
export function buildStats(entries: LogEntry[], minimumBuilds: MinimumBuilds = {}): Record<string, { devices: number; newest: string; onNewest: number; belowMinimum: number }> {
  const latest = new Map<string, { kind: string; build: number }>();
  for (const e of entries) {
    if (e.kind !== "oao.device" || !e.build || !/^\d+$/.test(String(e.build))) continue;
    const key = String(e.deviceId ?? `${e.userId}:${deviceKind(e)}`);
    const build = Number(e.build);
    const seen = latest.get(key);
    if (!seen || build > seen.build) latest.set(key, { kind: deviceKind(e), build });
  }
  const out: Record<string, { devices: number; newest: string; onNewest: number; belowMinimum: number }> = {};
  for (const { kind, build } of latest.values()) {
    const k = (out[kind] ??= { devices: 0, newest: "0", onNewest: 0, belowMinimum: 0 });
    k.devices++;
    if (build > Number(k.newest)) k.newest = String(build);
    const minimum = isClientKind(kind) ? minimumBuilds[kind] : undefined;
    if (minimum !== undefined && build < minimum) k.belowMinimum++;
  }
  for (const { kind, build } of latest.values()) if (String(build) === out[kind].newest) out[kind].onNewest++;
  return out;
}

export interface SafetyStats {
  reports: number;
  photoReports: number;
  blocks: number;
  namesRefused: number;
  deletions: number;
  ringsRefused: number;
}

export function safetyStats(entries: LogEntry[]): SafetyStats {
  const out: SafetyStats = { reports: 0, photoReports: 0, blocks: 0, namesRefused: 0, deletions: 0, ringsRefused: 0 };
  for (const e of entries) {
    if (e.kind === "oao.action") {
      if (e.action === "reported") {
        out.reports++;
        if (e.reason === "photo") out.photoReports++;
      } else if (e.action === "blocked") out.blocks++;
      else if (e.action === "account_deleted") out.deletions++;
    } else if (e.kind === "oao.api" && e.error === "name-not-allowed") out.namesRefused++;
    else if (e.kind === "oao.conversation" && ((e.events ?? []) as Array<{ name: string }>).some((ev) => ev.name === "ringRefused")) out.ringsRefused++;
  }
  return out;
}

// 96 fifteen-minute slots from midnight UTC: each slot's running total at its end (DAU so far,
// conversations so far), or null for slots still to come. For "vs yesterday at this hour".
export function slots(date: string, entries: LogEntry[], bots: Bots, now: number): { dau: Array<number | null>; conversations: Array<number | null> } {
  const start = Date.parse(`${date}T00:00:00Z`);
  const slotMs = 15 * 60_000;
  const dauAt = new Array<number>(96).fill(0);
  const convAt = new Array<number>(96).fill(0);
  const firstActive = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "oao.conversation" || !e.to || skipConversation(e, bots)) continue;
    const slot = Math.min(95, Math.max(0, Math.floor((Date.parse(e.timestamp) - start) / slotMs)));
    convAt[slot]++;
    for (const id of activeAccounts([e], bots)) firstActive.set(id, Math.min(firstActive.get(id) ?? 95, slot));
  }
  for (const slot of firstActive.values()) dauAt[slot]++;
  const last = Math.floor((now - start) / slotMs);
  const running = (counts: number[]) => {
    let total = 0;
    return counts.map((n, i) => {
      total += n;
      return i <= last ? total : null;
    });
  };
  return { dau: running(dauAt), conversations: running(convAt) };
}

export interface RollingStats {
  date: string;
  generatedAt: number;
  dau: number;
  dauByProvider: Record<string, number>;
  day: Activity;
  conversationStats: ConversationStats;
  speed: SpeedRow[];
  push: PushStats;
  quality: QualityStats;
  builds: ReturnType<typeof buildStats>;
  safety: SafetyStats;
  growth: { signUps: Record<string, number>; registrations: number };
  feedback: { problemReports: number; diagnosticsUploads: number };
  slots: ReturnType<typeof slots>;
  withTestBot: { dau: number; day: Activity; conversationStats: ConversationStats; slots: ReturnType<typeof slots> };
}

// Today so far (UTC), from today's telemetry entries. `providers` maps accounts to their sign-in
// provider for the DAU split; neither it nor any account ID is in the result.
export function rollingStats(date: string, entries: LogEntry[], options: { bots?: Bots; providers?: Map<string, string>; minimumBuilds?: MinimumBuilds; now?: number } = {}): RollingStats {
  const bots = options.bots ?? {};
  const withBot = { ...bots, includeTestBot: true };
  const now = options.now ?? Date.now();
  const active = activeAccounts(entries, bots);
  const signUps: Record<string, number> = {};
  let registrations = 0;
  let problemReports = 0;
  let diagnosticsUploads = 0;
  for (const e of entries) {
    if (isBot(e.userId, bots)) continue;
    if (e.kind === "oao.action" && e.action === "account_created") bump(signUps, String(e.provider ?? "unknown"));
    else if (e.kind === "oao.registration") registrations++;
    else if (e.kind === "oao.feedback") problemReports++;
    else if (e.kind === "oao.diagnostics") diagnosticsUploads++;
  }
  return {
    date,
    generatedAt: now,
    dau: active.size,
    dauByProvider: byProvider(active, options.providers ?? new Map()),
    day: activity(entries, bots),
    conversationStats: conversationStats(entries, bots),
    speed: speed(entries, bots),
    push: pushStats(entries, bots),
    quality: qualityStats(entries, bots),
    builds: buildStats(entries.filter((e) => !isBot(e.userId, bots)), options.minimumBuilds),
    safety: safetyStats(entries),
    growth: { signUps, registrations },
    feedback: { problemReports, diagnosticsUploads },
    slots: slots(date, entries, bots, now),
    withTestBot: {
      dau: activeAccounts(entries, withBot).size,
      day: activity(entries, withBot),
      conversationStats: conversationStats(entries, withBot),
      slots: slots(date, entries, withBot, now),
    },
  };
}
