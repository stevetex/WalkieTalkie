// Usage analytics (the Beta telemetry spec's "Usage analytics", approved 2026-09-29): totals
// only, never names or lists of accounts.
//
//   usageSnapshot  what the accounts look like now, from Firestore: pictures, friends,
//                  favorites, devices, Ring Me On
//   activity       what people did in a window, from telemetry entries: active accounts,
//                  conversations, talk time, sign-ups, invites, onboarding
//   dailyStats     one day's activity, plus 7- and 30-day active counts and the snapshot: the
//                  stats/{YYYY-MM-DD} document rollup-main.ts writes

import type { Docs } from "./docs.ts";
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
}

function friendBucket(n: number): string {
  return n === 0 ? "0" : n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+";
}

export async function usageSnapshot(docs: Docs, now = Date.now()): Promise<UsageSnapshot> {
  const users = await docs.list("users");
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
  };
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
    const kinds = new Set(devices.filter((d) => d.data.pushToken).map((d) => String(d.data.platform)));
    bump(snapshot.devices, kinds.has("iphone") && kinds.has("watch") ? "both" : kinds.has("iphone") ? "iphone" : kinds.has("watch") ? "watch" : "none");
    for (const d of devices) {
      if (d.data.platform !== "iphone") continue;
      if (d.data.pushType === "pushtotalk") snapshot.iphones.walkieTalkie++;
      else if (d.data.pushToken === "app:") snapshot.iphones.appOnly++;
    }
    bump(snapshot.ringOn, u.data.ringOn === "watch" || u.data.ringOn === "iphone" ? String(u.data.ringOn) : "default");
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

// Accounts that did anything: opened the app, rang or were rung, or acted in the API.
export function activeAccounts(entries: LogEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.kind === "oao.conversation") {
      if (e.from) ids.add(e.from);
      if (e.to && (e.rings?.length || e.outcome === "live")) ids.add(e.to);
    } else if (typeof e.userId === "string" && e.userId.startsWith("u_")) {
      ids.add(e.userId);
    }
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

export function activity(entries: LogEntry[]): Activity {
  const a: Activity = {
    activeAccounts: activeAccounts(entries).size,
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
        if (!e.to) break;
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
  day: Activity;
  usage: UsageSnapshot;
}

// `entries` covers the 30 days up to the end of `date` (UTC).
export function dailyStats(date: string, entries: LogEntry[], usage: UsageSnapshot): DailyStats {
  const end = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
  const within = (days: number) => entries.filter((e) => {
    const t = Date.parse(e.timestamp);
    return t >= end - days * DAY_MS && t < end;
  });
  const today = within(1);
  return {
    date,
    dau: activeAccounts(today).size,
    wau: activeAccounts(within(7)).size,
    mau: activeAccounts(within(30)).size,
    day: activity(today),
    usage,
  };
}
