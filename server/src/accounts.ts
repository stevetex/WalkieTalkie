// Accounts, friends, invites, blocks, reports and devices (design decision 2026-09-27).
//
//   users/{uid}                     name, appleSub, createdAt
//   users/{uid}/friends/{friendId}  since. Written on both sides in one commit
//   users/{uid}/blocks/{otherId}    since. Blocking also deletes the friendship both ways
//   users/{uid}/devices/{deviceId}  platform, pushToken, apnsEnvironment, updatedAt
//   users/{uid}/sessions/{deviceId} sid, platform, createdAt, refreshedAt. One per device, so
//                                   concurrent sign-ins on a device can't leave extras
//   appleSubs/{sub}                 userId. Created only if absent: one account per Apple ID
//   invites/{code}                  from, createdAt, expireAt (Firestore TTL deletes it)
//   reports/{id}                    reporter, reported, reason, note, conversationId, createdAt, status
//
// A ring is allowed only if users/{from}/friends/{to} exists, so deleting an account or
// blocking someone takes effect on the next ring, whatever tokens are still out there.

import { randomBytes } from "node:crypto";
import { PreconditionFailed, type FirestoreData, type Write } from "./firestore.ts";
import type { ApnsEnvironment } from "./apns.ts";
import type { Docs } from "./docs.ts";

export const USER_ID_PREFIX = "u_";
export const PLATFORMS = ["watch", "iphone"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const REPORT_REASONS = ["harassment", "spam", "inappropriate", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME = 40;
const MAX_NOTE = 1000;
// Firestore's limit on writes per commit.
const MAX_WRITES = 500;

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

export interface Friend {
  id: string;
  name: string;
  since: number;
}

export interface BlockedUser {
  id: string;
  // Null once the blocked account has been deleted.
  name: string | null;
  since: number;
}

export interface InviteInfo {
  code: string;
  from: { id: string; name: string };
  expiresAt: number;
  alreadyFriends: boolean;
}

export interface AccountDevice {
  id: string;
  platform: Platform;
  // An APNs device token, or a "local:" / "poll:" pseudo-token (see relay.ts).
  pushToken: string;
  apnsEnvironment: ApnsEnvironment;
  updatedAt: number;
}

export type RingLookup =
  | { allowed: false }
  | { allowed: true; fromName: string; devices: AccountDevice[] };

// An error the API returns as-is: an HTTP status and a stable code the apps can switch on.
export class AccountError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AccountsOptions {
  now?: () => number;
  inviteTtlMs?: number;
  invitesPerDay?: number;
}

export class Accounts {
  private docs: Docs;
  private opts: Required<AccountsOptions>;

  constructor(docs: Docs, options: AccountsOptions = {}) {
    this.docs = docs;
    this.opts = { now: Date.now, inviteTtlMs: 7 * DAY_MS, invitesPerDay: 50, ...options };
  }

  // The account for this Apple ID, created on its first sign-in. Apple only shares the
  // user's name on that first sign-in, so `name` is used only when creating.
  async signInWithApple(appleSub: string, name?: string): Promise<{ user: User; created: boolean }> {
    checkId(appleSub, "Apple user");
    for (let attempt = 0; attempt < 3; attempt++) {
      const [mapping] = await this.docs.getAll([`appleSubs/${appleSub}`]);
      if (mapping) {
        const user = await this.user(String(mapping.userId));
        if (user) return { user, created: false };
      }
      const id = newUserId();
      const createdAt = this.opts.now();
      const user = { id, name: cleanName(name) ?? "Friend", createdAt };
      try {
        await this.docs.commit([
          // A mapping left behind with no user (shouldn't happen) is replaced.
          mapping
            ? { set: `appleSubs/${appleSub}`, data: { userId: id }, exists: true }
            : { set: `appleSubs/${appleSub}`, data: { userId: id }, exists: false },
          { set: `users/${id}`, data: { name: user.name, appleSub, createdAt: new Date(createdAt) }, exists: false },
        ]);
        return { user, created: true };
      } catch (err) {
        // Another sign-in for the same Apple ID won the race: use its account.
        if (!(err instanceof PreconditionFailed)) throw err;
      }
    }
    throw new AccountError(409, "sign-in-conflict", "couldn't create the account");
  }

  async user(id: string): Promise<User | undefined> {
    if (!isUserId(id)) return undefined;
    const [data] = await this.docs.getAll([`users/${id}`]);
    return data ? toUser(id, data) : undefined;
  }

  async appleSub(id: string): Promise<string | undefined> {
    const [data] = await this.docs.getAll([`users/${requireUserId(id)}`]);
    return data ? String(data.appleSub) : undefined;
  }

  async rename(id: string, name: string): Promise<User> {
    const clean = cleanName(name);
    if (!clean) throw new AccountError(400, "bad-name", "the name is empty");
    try {
      await this.docs.commit([{ set: `users/${requireUserId(id)}`, data: { name: clean }, fields: ["name"], exists: true }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
    return (await this.user(id))!;
  }

  // Sessions: one per device, keyed by the device, so signing in again (even several times at
  // once) replaces its session. The newest sid wins; older tokens for the device stop refreshing.
  async createSession(userId: string, deviceId: string, platform: Platform): Promise<string> {
    checkId(deviceId, "device");
    const sessions = await this.docs.list(`users/${requireUserId(userId)}/sessions`);
    const sid = randomId(16);
    const now = new Date(this.opts.now());
    await this.docs.commit([
      // Sessions stored before 2026-09-27's change were keyed by their sid.
      ...sessions
        .filter((s) => s.id !== deviceId && s.data.deviceId === deviceId)
        .map((s): Write => ({ delete: `users/${userId}/sessions/${s.id}` })),
      { set: `users/${userId}/sessions/${deviceId}`, data: { sid, platform, createdAt: now, refreshedAt: now } },
    ]);
    return sid;
  }

  // Refreshing: true (and the session's refreshedAt updated) if this is still the device's
  // session.
  async touchSession(userId: string, sid: string, deviceId: string): Promise<boolean> {
    if (!isUserId(userId) || !isId(sid) || !isId(deviceId)) return false;
    const [current, legacy] = await this.docs.getAll([`users/${userId}/sessions/${deviceId}`, `users/${userId}/sessions/${sid}`]);
    const now = new Date(this.opts.now());
    try {
      if (current) {
        if (current.sid !== sid) return false;
        await this.docs.commit([
          { set: `users/${userId}/sessions/${deviceId}`, data: { refreshedAt: now }, fields: ["refreshedAt"], exists: true },
        ]);
        return true;
      }
      // A session from before the change: move it to the device's key.
      if (!legacy || legacy.deviceId !== deviceId) return false;
      await this.docs.commit([
        {
          set: `users/${userId}/sessions/${deviceId}`,
          data: { sid, platform: legacy.platform, createdAt: legacy.createdAt, refreshedAt: now },
          exists: false,
        },
        { delete: `users/${userId}/sessions/${sid}`, exists: true },
      ]);
      return true;
    } catch (err) {
      if (err instanceof PreconditionFailed) return false;
      throw err;
    }
  }

  // Signing out: the session and the device's push registration go, so it stops ringing.
  // A token the device has already replaced ends nothing.
  async endSession(userId: string, sid: string, deviceId: string): Promise<void> {
    requireUserId(userId);
    checkId(sid, "session");
    checkId(deviceId, "device");
    const [current, legacy] = await this.docs.getAll([`users/${userId}/sessions/${deviceId}`, `users/${userId}/sessions/${sid}`]);
    const isCurrent = current ? current.sid === sid : legacy?.deviceId === deviceId;
    if (!isCurrent) return;
    await this.docs.commit([
      { delete: `users/${userId}/sessions/${current ? deviceId : sid}` },
      { delete: `users/${userId}/devices/${deviceId}` },
    ]);
  }

  async registerDevice(
    userId: string,
    deviceId: string,
    device: { platform: Platform; pushToken: string; apnsEnvironment: ApnsEnvironment },
  ): Promise<void> {
    await this.docs.commit([
      {
        set: `users/${requireUserId(userId)}/devices/${checkId(deviceId, "device")}`,
        data: { ...device, updatedAt: this.opts.now() },
      },
    ]);
  }

  async devices(userId: string): Promise<AccountDevice[]> {
    return (await this.docs.list(`users/${requireUserId(userId)}/devices`)).map((d) => toDevice(d.id, d.data));
  }

  async friends(userId: string): Promise<Friend[]> {
    const rows = await this.docs.list(`users/${requireUserId(userId)}/friends`);
    const users = await this.docs.getAll(rows.map((r) => `users/${r.id}`));
    return rows
      .flatMap((r, i) => (users[i] ? [{ id: r.id, name: String(users[i]!.name), since: millis(r.data.since) }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async removeFriend(userId: string, friendId: string): Promise<void> {
    await this.docs.commit([
      { delete: `users/${requireUserId(userId)}/friends/${requireUserId(friendId)}` },
      { delete: `users/${friendId}/friends/${userId}` },
    ]);
  }

  async createInvite(userId: string): Promise<{ code: string; expiresAt: number }> {
    const now = this.opts.now();
    const recent = (await this.docs.query("invites", { where: { field: "from", op: "EQUAL", value: requireUserId(userId) } }))
      .filter((i) => millis(i.data.createdAt) > now - DAY_MS);
    if (recent.length >= this.opts.invitesPerDay) throw new AccountError(429, "too-many-invites");
    const code = randomId(16);
    const expiresAt = now + this.opts.inviteTtlMs;
    await this.docs.commit([
      { set: `invites/${code}`, data: { from: userId, createdAt: new Date(now), expireAt: new Date(expiresAt) }, exists: false },
    ]);
    return { code, expiresAt };
  }

  // What the app shows before accepting. Expired, used, blocked (either way) and unknown
  // invites all look the same: not found.
  async invite(code: string, viewerId: string): Promise<InviteInfo> {
    requireUserId(viewerId);
    const { from, expiresAt } = await this.liveInvite(code);
    if (from === viewerId) throw new AccountError(409, "own-invite");
    const [inviter, alreadyFriends, blocked, blockedBy] = await this.docs.getAll([
      `users/${from}`,
      `users/${viewerId}/friends/${from}`,
      `users/${viewerId}/blocks/${from}`,
      `users/${from}/blocks/${viewerId}`,
    ]);
    if (!inviter || blocked || blockedBy) throw new AccountError(404, "invite-not-found");
    return { code, from: { id: from, name: String(inviter.name) }, expiresAt, alreadyFriends: alreadyFriends !== undefined };
  }

  // Makes the viewer and the inviter friends, and uses up the invite.
  async acceptInvite(code: string, userId: string): Promise<Friend> {
    const info = await this.invite(code, requireUserId(userId));
    const since = new Date(this.opts.now());
    try {
      await this.docs.commit([
        { delete: `invites/${code}`, exists: true },
        ...(info.alreadyFriends
          ? []
          : [
              { set: `users/${userId}/friends/${info.from.id}`, data: { since } },
              { set: `users/${info.from.id}/friends/${userId}`, data: { since } },
            ]),
      ]);
    } catch (err) {
      // Someone else accepted it first.
      if (err instanceof PreconditionFailed) throw new AccountError(404, "invite-not-found");
      throw err;
    }
    return { id: info.from.id, name: info.from.name, since: since.getTime() };
  }

  async cancelInvite(code: string, userId: string): Promise<void> {
    const { from } = await this.liveInvite(code);
    if (from !== userId) throw new AccountError(404, "invite-not-found");
    await this.docs.commit([{ delete: `invites/${code}` }]);
  }

  async block(userId: string, otherId: string): Promise<void> {
    requireUserId(userId);
    requireUserId(otherId);
    if (userId === otherId) throw new AccountError(400, "cannot-block-self");
    const [other] = await this.docs.getAll([`users/${otherId}`]);
    if (!other) throw new AccountError(404, "no-account");
    await this.docs.commit([
      { set: `users/${userId}/blocks/${otherId}`, data: { since: new Date(this.opts.now()) } },
      { delete: `users/${userId}/friends/${otherId}` },
      { delete: `users/${otherId}/friends/${userId}` },
    ]);
  }

  async unblock(userId: string, otherId: string): Promise<void> {
    await this.docs.commit([{ delete: `users/${requireUserId(userId)}/blocks/${requireUserId(otherId)}` }]);
  }

  async blocks(userId: string): Promise<BlockedUser[]> {
    const rows = await this.docs.list(`users/${requireUserId(userId)}/blocks`);
    const users = await this.docs.getAll(rows.map((r) => `users/${r.id}`));
    return rows.map((r, i) => ({ id: r.id, name: users[i] ? String(users[i]!.name) : null, since: millis(r.data.since) }));
  }

  // Reports are kept for moderation, with IDs only (no names), even after either account
  // is deleted. The caller logs each one so an alert can email the operator.
  async report(
    reporterId: string,
    report: { userId: string; reason: string; note?: string; conversationId?: string },
  ): Promise<string> {
    requireUserId(reporterId);
    requireUserId(report.userId);
    if (!(REPORT_REASONS as readonly string[]).includes(report.reason)) throw new AccountError(400, "bad-reason");
    if (report.note !== undefined && typeof report.note !== "string") throw new AccountError(400, "bad-note");
    const id = randomId(12);
    const data: FirestoreData = {
      reporter: reporterId,
      reported: report.userId,
      reason: report.reason,
      note: report.note?.slice(0, MAX_NOTE) ?? null,
      conversationId: typeof report.conversationId === "string" ? report.conversationId.slice(0, 64) : null,
      createdAt: new Date(this.opts.now()),
      status: "open",
    };
    await this.docs.commit([{ set: `reports/${id}`, data, exists: false }]);
    return id;
  }

  // For the relay, once per ring: the two must be friends (a block removes the friendship).
  async ringLookup(from: string, to: string): Promise<RingLookup> {
    if (!isUserId(from) || !isUserId(to) || from === to) return { allowed: false };
    const [[sender, friendship], devices] = await Promise.all([
      this.docs.getAll([`users/${from}`, `users/${from}/friends/${to}`]),
      this.docs.list(`users/${to}/devices`),
    ]);
    if (!sender || !friendship) return { allowed: false };
    return { allowed: true, fromName: String(sender.name), devices: devices.map((d) => toDevice(d.id, d.data)) };
  }

  // Everything under the user, the friend entries on the other side, their open invites and
  // the Apple ID mapping. The user document goes last, so a failed deletion can be retried.
  // Reports stay (IDs only). Returns the Apple ID, whose tokens the caller revokes.
  async deleteAccount(userId: string): Promise<{ appleSub: string | null }> {
    requireUserId(userId);
    const [[user], friends, blocks, devices, sessions, invites] = await Promise.all([
      this.docs.getAll([`users/${userId}`]),
      this.docs.list(`users/${userId}/friends`),
      this.docs.list(`users/${userId}/blocks`),
      this.docs.list(`users/${userId}/devices`),
      this.docs.list(`users/${userId}/sessions`),
      this.docs.query("invites", { where: { field: "from", op: "EQUAL", value: userId } }),
    ]);
    if (!user) throw new AccountError(404, "no-account");
    const appleSub = typeof user.appleSub === "string" ? user.appleSub : null;
    const writes: Write[] = [
      ...friends.flatMap((f): Write[] => [{ delete: `users/${f.id}/friends/${userId}` }, { delete: `users/${userId}/friends/${f.id}` }]),
      ...blocks.map((b): Write => ({ delete: `users/${userId}/blocks/${b.id}` })),
      ...devices.map((d): Write => ({ delete: `users/${userId}/devices/${d.id}` })),
      ...sessions.map((s): Write => ({ delete: `users/${userId}/sessions/${s.id}` })),
      ...invites.map((i): Write => ({ delete: `invites/${i.id}` })),
      ...(appleSub ? [{ delete: `appleSubs/${appleSub}` }] : []),
    ];
    for (let i = 0; i < writes.length; i += MAX_WRITES) await this.docs.commit(writes.slice(i, i + MAX_WRITES));
    await this.docs.commit([{ delete: `users/${userId}` }]);
    return { appleSub };
  }

  private async liveInvite(code: string): Promise<{ from: string; expiresAt: number }> {
    if (!isId(code)) throw new AccountError(404, "invite-not-found");
    const [invite] = await this.docs.getAll([`invites/${code}`]);
    // Firestore's TTL deletes expired invites within a day or so; until then, check here.
    if (!invite || millis(invite.expireAt) <= this.opts.now()) throw new AccountError(404, "invite-not-found");
    return { from: String(invite.from), expiresAt: millis(invite.expireAt) };
  }
}

export function isUserId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(USER_ID_PREFIX) && isId(id);
}

export function isPlatform(value: unknown): value is Platform {
  return (PLATFORMS as readonly unknown[]).includes(value);
}

// IDs the server generates, and device IDs from the apps: letters, digits, "_", "-" and ".".
// (Apple's user identifiers look like 001234.abcdef….0123.)
function isId(id: unknown): id is string {
  return typeof id === "string" && /^[\w.-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

function checkId(id: unknown, what: string): string {
  if (!isId(id)) throw new AccountError(400, "bad-id", `invalid ${what} ID`);
  return id;
}

function requireUserId(id: unknown): string {
  if (!isUserId(id)) throw new AccountError(404, "no-account");
  return id;
}

function newUserId(): string {
  return USER_ID_PREFIX + randomId(12);
}

// base64url, so safe in document IDs and URLs. 16 bytes = 128 bits = 22 characters.
function randomId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

// Trimmed, single-spaced, no control characters, at most 40 characters. Undefined if empty.
export function cleanName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const clean = [...name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim()].slice(0, MAX_NAME).join("").trim();
  return clean || undefined;
}

function toUser(id: string, data: FirestoreData): User {
  return { id, name: String(data.name), createdAt: millis(data.createdAt) };
}

function toDevice(id: string, data: FirestoreData): AccountDevice {
  return {
    id,
    platform: isPlatform(data.platform) ? data.platform : "watch",
    pushToken: String(data.pushToken ?? ""),
    apnsEnvironment: data.apnsEnvironment === "production" ? "production" : "sandbox",
    updatedAt: millis(data.updatedAt),
  };
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}
