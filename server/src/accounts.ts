// Accounts, friends, invites, blocks, reports and devices (design decision 2026-09-27).
//
//   users/{uid}                     name, appleSub, createdAt, photoVersion (when there's a photo),
//                                   avatar (a built-in mascot's ID, instead of a photo),
//                                   ringOn ("watch" or "iphone"; absent = the watch if there is one),
//                                   rollOver (true: an unanswered watch rings the iPhone; absent = off)
//   users/{uid}/friends/{friendId}  since, favorite (the user's star), lastMessageAt (when the
//                                   friend last talked to the user; written by the relay).
//                                   The friendship is written on both sides in one commit
//   users/{uid}/blocks/{otherId}    since. Blocking also deletes the friendship both ways
//   users/{uid}/devices/{deviceId}  platform, pushToken, pushType ("pushtotalk" for an iPhone in
//                                   its PushToTalk channel), apnsEnvironment, updatedAt
//   users/{uid}/sessions/{deviceId} sid, platform, createdAt, refreshedAt. One per device, so
//                                   concurrent sign-ins on a device can't leave extras
//   appleSubs/{sub}                 userId. Created only if absent: one account per Apple ID
//   pushTokens/{sha256 of token}    userId, deviceId, updatedAt: the one registration a push token
//                                   belongs to. Registering it elsewhere (another account, or a new
//                                   device ID after a reinstall) removes the old registration
//   invites/{code}                  from, createdAt, expireAt (Firestore TTL deletes it)
//
// The Test Bot's standing invite (TEST_BOT_INVITE, api-main.ts) isn't stored: it's a code in the
// API's settings that befriends the bot account, and no other, any number of times, so App
// Review and testers can add a friend who answers (test-bot.ts). Blocks apply as to any invite.
//   reports/{id}                    reporter, reported, reason, note, conversationId, createdAt, status
//   photos/{uid}                    jpeg (bytes, at most 100 KB), updatedAt. Apart from users/{uid}
//                                   so friend lists don't carry photos; photoVersion there
//                                   tells the apps when to download it again
//
// A ring is allowed only if users/{from}/friends/{to} exists, so deleting an account or
// blocking someone takes effect on the next ring, whatever tokens are still out there. The
// relay checks again while they talk (canTalk), so it also ends a conversation under way.

import { createHash, randomBytes } from "node:crypto";
import { PreconditionFailed, type FirestoreData, type TransactionGet, type Write } from "./firestore.ts";
import type { ApnsEnvironment } from "./apns.ts";
import type { Docs } from "./docs.ts";
import { nameAllowed } from "./name-filter.ts";

export const USER_ID_PREFIX = "u_";
export const PLATFORMS = ["watch", "iphone"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const REPORT_REASONS = ["harassment", "spam", "inappropriate", "photo", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAME = 40;
const MAX_NOTE = 1000;
export const MAX_PHOTO_BYTES = 100 * 1024;
// A device's gzipped diagnostics log (the Beta telemetry spec); a Firestore document holds 1 MiB.
export const MAX_DIAGNOSTICS_BYTES = 900 * 1024;
const DIAGNOSTICS_TTL_MS = 30 * DAY_MS;
const FEEDBACK_TTL_MS = 90 * DAY_MS;
// A pull stays open this long, so a device opened later still answers it.
const DIAGNOSTICS_REQUEST_MS = 7 * DAY_MS;
const MAX_FEEDBACK = 2000;
// Firestore's limit on writes per commit.
const MAX_WRITES = 500;

export interface User {
  id: string;
  name: string;
  createdAt: number;
  // When the profile photo last changed (ms); absent without one.
  photoVersion?: number;
  // A built-in mascot picture (the apps bundle the art), used instead of a photo.
  avatar?: string;
  // Which device rings (design decision 2026-09-27); absent = the watch if there is one.
  ringOn?: Platform;
  // An unanswered ring on the watch rolls over to the iPhone (design decision 2026-10-01).
  rollOver?: boolean;
  // When Steve asked for this account's device logs (tools/beta.ts pull, or a problem report),
  // while the request is open; the devices upload theirs once.
  diagnosticsRequestedAt?: number;
}

export interface Friend {
  id: string;
  name: string;
  since: number;
  photoVersion?: number;
  avatar?: string;
  // The user starred this friend (their Friends list shows favorites first).
  favorite?: boolean;
  // When this friend last talked to the user (ms).
  lastMessageAt?: number;
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
  // An APNs device token, or a "local:" / "poll:" / "app:" pseudo-token (see relay.ts).
  pushToken: string;
  // "pushtotalk": the token is an iPhone's PushToTalk channel token.
  pushType: PushType;
  apnsEnvironment: ApnsEnvironment;
  updatedAt: number;
}

export const PUSH_TYPES = ["alert", "pushtotalk"] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export type RingLookup =
  | { allowed: false }
  | { allowed: true; fromName: string; devices: AccountDevice[]; ringOn?: Platform; rollOver?: boolean };

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
  // The Test Bot's standing invite: this code befriends this account, and is never used up.
  botInvite?: { code: string; userId: string } | null;
}

export class Accounts {
  private docs: Docs;
  private opts: Required<AccountsOptions>;

  constructor(docs: Docs, options: AccountsOptions = {}) {
    this.docs = docs;
    this.opts = { now: Date.now, inviteTtlMs: 7 * DAY_MS, invitesPerDay: 50, botInvite: null, ...options };
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
      // Apple's name is only offered once, so a disallowed one becomes "Friend" rather than
      // failing the sign-in; onboarding asks for a screen name next anyway.
      const clean = cleanName(name);
      const user = { id, name: clean && nameAllowed(clean) ? clean : "Friend", createdAt };
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

  // How long an invite lasts, so its age can be worked out from when it expires.
  get inviteTtlMs(): number {
    return this.opts.inviteTtlMs;
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
    if (!nameAllowed(clean)) throw new AccountError(400, "name-not-allowed", "That name isn't allowed. Choose another one.");
    try {
      await this.docs.commit([{ set: `users/${requireUserId(id)}`, data: { name: clean }, fields: ["name"], exists: true }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
    return (await this.user(id))!;
  }

  // Null goes back to the default: the watch if the account has one.
  async setRingOn(id: string, ringOn: Platform | null): Promise<User> {
    try {
      await this.docs.commit([{ set: `users/${requireUserId(id)}`, data: ringOn ? { ringOn } : {}, fields: ["ringOn"], exists: true }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
    return (await this.user(id))!;
  }

  // A built-in mascot as the profile picture, which replaces any photo; null removes it.
  // IDs aren't listed here, so new mascots need no deploy; apps show unknown ones as the default.
  async setAvatar(id: string, avatar: string | null): Promise<User> {
    if (avatar !== null && !isAvatar(avatar)) throw new AccountError(400, "bad-avatar");
    try {
      await this.docs.commit([
        {
          set: `users/${requireUserId(id)}`,
          data: avatar ? { avatar } : {},
          fields: avatar ? ["avatar", "photoVersion"] : ["avatar"],
          exists: true,
        },
        ...(avatar ? [{ delete: `photos/${id}` }] : []),
      ]);
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

  // Every API call: the token's session is still its device's current one, on an account that
  // still exists. Signing out, signing in again on the device and deleting the account end it,
  // whatever the token's expiry says.
  async sessionActive(userId: string, sid: string, deviceId: string): Promise<boolean> {
    if (!isUserId(userId) || !isId(sid) || !isId(deviceId)) return false;
    const [user, current, legacy] = await this.docs.getAll([
      `users/${userId}`,
      `users/${userId}/sessions/${deviceId}`,
      `users/${userId}/sessions/${sid}`,
    ]);
    if (!user) return false;
    return current ? current.sid === sid : legacy?.deviceId === deviceId;
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
    const [current, legacy, device] = await this.docs.getAll([
      `users/${userId}/sessions/${deviceId}`,
      `users/${userId}/sessions/${sid}`,
      `users/${userId}/devices/${deviceId}`,
    ]);
    const isCurrent = current ? current.sid === sid : legacy?.deviceId === deviceId;
    if (!isCurrent) return;
    await this.docs.commit([
      { delete: `users/${userId}/sessions/${current ? deviceId : sid}` },
      { delete: `users/${userId}/devices/${deviceId}` },
      ...(await this.pointerDeletes(userId, device ? [{ id: deviceId, data: device }] : [])),
    ]);
  }

  async registerDevice(
    userId: string,
    deviceId: string,
    device: { platform: Platform; pushToken: string; pushType?: PushType; apnsEnvironment: ApnsEnvironment },
  ): Promise<void> {
    requireUserId(userId);
    checkId(deviceId, "device");
    const path = `users/${userId}/devices/${deviceId}`;
    const pointer = ownsToken(device.pushToken) ? pushTokenPath(device.pushToken) : null;
    const now = this.opts.now();
    await this.docs.transaction(async (get) => {
      const [user, previous, owner] = await get([`users/${userId}`, path, ...(pointer ? [pointer] : [])]);
      const writes: Write[] = [];
      // The token was registered somewhere else: under another account (the device signed in
      // with another Apple ID without signing out) or this account's earlier device ID (a
      // reinstall). That registration goes, so it can't take rings meant for this one.
      if (owner && (owner.userId !== userId || owner.deviceId !== deviceId) && isUserId(owner.userId) && isId(owner.deviceId)) {
        const stalePath = `users/${owner.userId}/devices/${owner.deviceId}`;
        const [stale] = await get([stalePath]);
        if (stale?.pushToken === device.pushToken) writes.push({ delete: stalePath });
      }
      // The device's previous token no longer points here.
      if (typeof previous?.pushToken === "string" && ownsToken(previous.pushToken) && previous.pushToken !== device.pushToken) {
        const oldPointer = pushTokenPath(previous.pushToken);
        const [old] = await get([oldPointer]);
        if (old?.userId === userId && old.deviceId === deviceId) writes.push({ delete: oldPointer });
      }
      // No choice made means the watch rings when there is one (design decision 2026-09-29: the
      // watch comes first), so a watch joining an iPhone's account takes the rings; the iPhone
      // asks once, with the watch as the default.
      writes.push(
        { set: path, data: { ...device, pushType: device.pushType ?? "alert", updatedAt: now } },
        ...(pointer ? [{ set: pointer, data: { userId, deviceId, updatedAt: now } }] : []),
      );
      return { writes, result: undefined };
    });
  }

  // The relay, when APNs says a device's push token is no longer valid. Only that token goes:
  // if the device has registered a new one since, it stays. True if it was removed.
  async removeDevice(userId: string, deviceId: string, pushToken: string): Promise<boolean> {
    if (!isUserId(userId) || !isId(deviceId)) return false;
    const path = `users/${userId}/devices/${deviceId}`;
    const pointer = ownsToken(pushToken) ? pushTokenPath(pushToken) : null;
    return this.docs.transaction(async (get) => {
      const [device, owner] = await get([path, ...(pointer ? [pointer] : [])]);
      const stale = device !== undefined && device.pushToken === pushToken;
      const ownsPointer = owner?.userId === userId && owner.deviceId === deviceId;
      return {
        writes: stale ? [{ delete: path, exists: true }, ...(pointer && ownsPointer ? [{ delete: pointer }] : [])] : [],
        result: stale,
      };
    });
  }

  // Deletes for the pushTokens pointers that still name these devices of the user's.
  private async pointerDeletes(userId: string, devices: Array<{ id: string; data: FirestoreData }>): Promise<Write[]> {
    const tokens = devices.filter((d) => typeof d.data.pushToken === "string" && ownsToken(d.data.pushToken));
    const paths = tokens.map((d) => pushTokenPath(String(d.data.pushToken)));
    if (!paths.length) return [];
    const owners = await this.docs.getAll(paths);
    return paths.flatMap((p, i): Write[] =>
      owners[i]?.userId === userId && owners[i]?.deviceId === tokens[i].id ? [{ delete: p }] : [],
    );
  }

  // The kinds of device registered for rings, for the iPhone's Ring Me On.
  async platforms(userId: string): Promise<Platform[]> {
    const platforms = new Set((await this.devices(userId)).map((d) => d.platform));
    return PLATFORMS.filter((p) => platforms.has(p));
  }

  async devices(userId: string): Promise<AccountDevice[]> {
    return (await this.docs.list(`users/${requireUserId(userId)}/devices`)).map((d) => toDevice(d.id, d.data));
  }

  async friends(userId: string): Promise<Friend[]> {
    const rows = await this.docs.list(`users/${requireUserId(userId)}/friends`);
    const users = await this.docs.getAll(rows.map((r) => `users/${r.id}`));
    return rows
      .flatMap((r, i) => {
        const user = users[i];
        if (!user) return [];
        const friend: Friend = { id: r.id, name: String(user.name), since: millis(r.data.since) };
        if (typeof user.photoVersion === "number") friend.photoVersion = user.photoVersion;
        if (isAvatar(user.avatar)) friend.avatar = user.avatar;
        if (r.data.favorite === true) friend.favorite = true;
        if (r.data.lastMessageAt !== undefined) friend.lastMessageAt = millis(r.data.lastMessageAt);
        return [friend];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Starring is one-sided: it's the user's entry for the friend.
  async setFavorite(userId: string, friendId: string, favorite: boolean): Promise<void> {
    try {
      await this.docs.commit([{
        set: `users/${requireUserId(userId)}/friends/${requireUserId(friendId)}`,
        data: favorite ? { favorite: true } : {},
        fields: ["favorite"],
        exists: true,
      }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "not-friends");
      throw err;
    }
  }

  // The relay, when `from` talks to `to`: shown as "Last messaged you" on `to`'s friend page.
  // Nothing happens if they aren't friends (any more).
  async recordMessage(from: string, to: string, at: number): Promise<void> {
    if (!isUserId(from) || !isUserId(to)) return;
    try {
      await this.docs.commit([{ set: `users/${to}/friends/${from}`, data: { lastMessageAt: new Date(at) }, fields: ["lastMessageAt"], exists: true }]);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
    }
  }

  async removeFriend(userId: string, friendId: string): Promise<void> {
    await this.docs.commit([
      { delete: `users/${requireUserId(userId)}/friends/${requireUserId(friendId)}` },
      { delete: `users/${friendId}/friends/${userId}` },
    ]);
  }

  // A square JPEG the app has already sized (256 px). Returns the new photoVersion.
  async setPhoto(userId: string, jpeg: Uint8Array): Promise<number> {
    requireUserId(userId);
    if (jpeg.length > MAX_PHOTO_BYTES) throw new AccountError(413, "photo-too-large");
    // SOI marker, and EOI at the end.
    const isJpeg = jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg[2] === 0xff &&
      jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9;
    if (!isJpeg) throw new AccountError(400, "not-a-jpeg");
    const version = this.opts.now();
    try {
      await this.docs.commit([
        { set: `users/${userId}`, data: { photoVersion: version }, fields: ["photoVersion", "avatar"], exists: true },
        { set: `photos/${userId}`, data: { jpeg: Buffer.from(jpeg), updatedAt: new Date(version) } },
      ]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
    return version;
  }

  async removePhoto(userId: string): Promise<void> {
    requireUserId(userId);
    try {
      await this.docs.commit([
        { set: `users/${userId}`, data: {}, fields: ["photoVersion"], exists: true },
        { delete: `photos/${userId}` },
      ]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
  }

  // Your own photo, or a friend's. Anyone else's (including after a block) is not found.
  async photo(viewerId: string, userId: string): Promise<{ jpeg: Buffer; version: number }> {
    requireUserId(viewerId);
    requireUserId(userId);
    const [photo, friendship] = await this.docs.getAll([
      `photos/${userId}`,
      ...(viewerId === userId ? [] : [`users/${viewerId}/friends/${userId}`]),
    ]);
    const allowed = viewerId === userId || friendship !== undefined;
    if (!photo || !allowed || !(photo.jpeg instanceof Uint8Array)) throw new AccountError(404, "no-photo");
    return { jpeg: Buffer.from(photo.jpeg), version: millis(photo.updatedAt) };
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
    return this.readInvite((paths) => this.docs.getAll(paths), code, requireUserId(viewerId));
  }

  // Makes the viewer and the inviter friends, and uses up the invite (not the Test Bot's). The
  // checks and the friendship are one transaction, so a block or an account deletion that lands
  // in between makes it run again and fail, rather than being undone by the new friendship.
  async acceptInvite(code: string, userId: string): Promise<Friend> {
    requireUserId(userId);
    const since = new Date(this.opts.now());
    try {
      return await this.docs.transaction(async (get) => {
        const info = await this.readInvite(get, code, userId);
        const writes: Write[] = [
          ...(this.isBotInvite(code) ? [] : [{ delete: `invites/${code}`, exists: true }]),
          ...(info.alreadyFriends
            ? []
            : [
                { set: `users/${userId}/friends/${info.from.id}`, data: { since } },
                { set: `users/${info.from.id}/friends/${userId}`, data: { since } },
              ]),
        ];
        return { writes, result: { id: info.from.id, name: info.from.name, since: since.getTime() } };
      });
    } catch (err) {
      // Someone else accepted it first.
      if (err instanceof PreconditionFailed) throw new AccountError(404, "invite-not-found");
      throw err;
    }
  }

  private isBotInvite(code: string): boolean {
    return this.opts.botInvite !== null && code === this.opts.botInvite.code;
  }

  private async readInvite(get: TransactionGet, code: string, viewerId: string): Promise<InviteInfo> {
    if (!isId(code)) throw new AccountError(404, "invite-not-found");
    let from: string;
    let expiresAt: number;
    if (this.isBotInvite(code)) {
      // Never expires; the apps are shown the usual week.
      from = this.opts.botInvite!.userId;
      expiresAt = this.opts.now() + this.opts.inviteTtlMs;
    } else {
      const [invite] = await get([`invites/${code}`]);
      // Firestore's TTL deletes expired invites within a day or so; until then, check here.
      if (!invite || millis(invite.expireAt) <= this.opts.now() || !isUserId(invite.from)) {
        throw new AccountError(404, "invite-not-found");
      }
      from = invite.from;
      expiresAt = millis(invite.expireAt);
    }
    if (from === viewerId) throw new AccountError(409, "own-invite");
    const [inviter, viewer, alreadyFriends, blocked, blockedBy] = await get([
      `users/${from}`,
      `users/${viewerId}`,
      `users/${viewerId}/friends/${from}`,
      `users/${viewerId}/blocks/${from}`,
      `users/${from}/blocks/${viewerId}`,
    ]);
    if (!inviter || !viewer || blocked || blockedBy) throw new AccountError(404, "invite-not-found");
    return { code, from: { id: from, name: String(inviter.name) }, expiresAt, alreadyFriends: alreadyFriends !== undefined };
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

  async setRollOver(id: string, rollOver: boolean): Promise<User> {
    try {
      await this.docs.commit([{ set: `users/${requireUserId(id)}`, data: rollOver ? { rollOver } : {}, fields: ["rollOver"], exists: true }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
    return (await this.user(id))!;
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
    const [[sender, friendship, recipient], devices] = await Promise.all([
      this.docs.getAll([`users/${from}`, `users/${from}/friends/${to}`, `users/${to}`]),
      this.docs.list(`users/${to}/devices`),
    ]);
    if (!sender || !friendship) return { allowed: false };
    return {
      allowed: true,
      fromName: String(sender.name),
      devices: devices.map((d) => toDevice(d.id, d.data)),
      ...(isPlatform(recipient?.ringOn) ? { ringOn: recipient.ringOn } : {}),
      ...(recipient?.rollOver === true ? { rollOver: true } : {}),
    };
  }

  // For the relay, while two talk: still friends (a block or an unfriending removes both
  // sides), and both accounts still there.
  async canTalk(from: string, to: string): Promise<boolean> {
    if (!isUserId(from) || !isUserId(to) || from === to) return false;
    const [sender, friendship, recipient] = await this.docs.getAll([`users/${from}`, `users/${from}/friends/${to}`, `users/${to}`]);
    return sender !== undefined && friendship !== undefined && recipient !== undefined;
  }

  // Diagnostics (the Beta telemetry spec): the devices see the request in GET /v1/me and
  // upload their own logs. During the TestFlight Beta they don't ask the person first.
  async requestDiagnostics(userId: string): Promise<void> {
    try {
      await this.docs.commit([{ set: `users/${requireUserId(userId)}`, data: { diagnosticsRequestedAt: new Date(this.opts.now()) }, fields: ["diagnosticsRequestedAt"], exists: true }]);
    } catch (err) {
      if (err instanceof PreconditionFailed) throw new AccountError(404, "no-account");
      throw err;
    }
  }

  // One device's compressed log, kept 30 days (a TTL policy on expireAt): gzip, or raw DEFLATE
  // as Apple's NSData .zlib compression makes it.
  async saveDiagnostics(userId: string, deviceId: string, meta: { platform?: string; build?: string }, gzip: Buffer): Promise<string> {
    requireUserId(userId);
    checkId(deviceId, "device");
    if (!gzip.length) throw new AccountError(400, "empty-diagnostics");
    const now = this.opts.now();
    const id = `${userId}_${deviceId}_${now}`;
    await this.docs.commit([{
      set: `diagnostics/${id}`,
      data: {
        userId,
        deviceId,
        platform: meta.platform ?? null,
        build: meta.build ?? null,
        size: gzip.length,
        encoding: gzip[0] === 0x1f && gzip[1] === 0x8b ? "gzip" : "deflate-raw",
        log: new Uint8Array(gzip),
        createdAt: new Date(now),
        expireAt: new Date(now + DIAGNOSTICS_TTL_MS),
      },
    }]);
    return id;
  }

  // A problem report from the app, kept 90 days. With diagnostics, the account's devices are
  // asked for their logs too.
  async saveFeedback(
    userId: string,
    feedback: { note: string; platform?: string; build?: string; conversationId?: string; diagnostics: boolean },
  ): Promise<string> {
    requireUserId(userId);
    const note = feedback.note.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim().slice(0, MAX_FEEDBACK);
    const id = randomId(12);
    const now = this.opts.now();
    await this.docs.commit([{
      set: `feedback/${id}`,
      data: {
        userId,
        note,
        platform: feedback.platform ?? null,
        build: feedback.build ?? null,
        conversationId: feedback.conversationId?.slice(0, 64) ?? null,
        diagnostics: feedback.diagnostics,
        status: "open",
        createdAt: new Date(now),
        expireAt: new Date(now + FEEDBACK_TTL_MS),
      },
      exists: false,
    }]);
    if (feedback.diagnostics) await this.requestDiagnostics(userId);
    return id;
  }

  // Everything under the user, the friend entries on the other side, their open invites and
  // the Apple ID mapping. The user document goes last, so a failed deletion can be retried.
  // Reports stay (IDs only). Returns the Apple ID, whose tokens the caller revokes.
  async deleteAccount(userId: string): Promise<{ appleSub: string | null }> {
    requireUserId(userId);
    const [[user], friends, blocks, devices, sessions, invites, diagnostics, feedback] = await Promise.all([
      this.docs.getAll([`users/${userId}`]),
      this.docs.list(`users/${userId}/friends`),
      this.docs.list(`users/${userId}/blocks`),
      this.docs.list(`users/${userId}/devices`),
      this.docs.list(`users/${userId}/sessions`),
      this.docs.query("invites", { where: { field: "from", op: "EQUAL", value: userId } }),
      this.docs.query("diagnostics", { where: { field: "userId", op: "EQUAL", value: userId } }),
      this.docs.query("feedback", { where: { field: "userId", op: "EQUAL", value: userId } }),
    ]);
    if (!user) throw new AccountError(404, "no-account");
    const appleSub = typeof user.appleSub === "string" ? user.appleSub : null;
    const writes: Write[] = [
      ...friends.flatMap((f): Write[] => [{ delete: `users/${f.id}/friends/${userId}` }, { delete: `users/${userId}/friends/${f.id}` }]),
      ...blocks.map((b): Write => ({ delete: `users/${userId}/blocks/${b.id}` })),
      ...devices.map((d): Write => ({ delete: `users/${userId}/devices/${d.id}` })),
      ...(await this.pointerDeletes(userId, devices)),
      ...sessions.map((s): Write => ({ delete: `users/${userId}/sessions/${s.id}` })),
      ...invites.map((i): Write => ({ delete: `invites/${i.id}` })),
      ...diagnostics.map((d): Write => ({ delete: `diagnostics/${d.id}` })),
      ...feedback.map((f): Write => ({ delete: `feedback/${f.id}` })),
      ...(appleSub ? [{ delete: `appleSubs/${appleSub}` }] : []),
      { delete: `photos/${userId}` },
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

export function isPushType(value: unknown): value is PushType {
  return (PUSH_TYPES as readonly unknown[]).includes(value);
}

// A mascot ID such as "honey" or "bow-lashes-cocoa".
export function isAvatar(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
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

// Every iPhone out of its PushToTalk channel registers the same "app:" token, and the spike's
// "local:" and "poll:" pseudo-tokens aren't Apple's either (see relay.ts). Every other token
// (APNs, or "simulator:<udid>:<bundle>") belongs to one device.
const SHARED_PSEUDO_TOKENS = ["app:", "local:", "poll:"];

function ownsToken(pushToken: string): boolean {
  return pushToken !== "" && !SHARED_PSEUDO_TOKENS.some((prefix) => pushToken.startsWith(prefix));
}

// A push token's pointer document: hashed, so the token isn't stored twice and fits an ID.
function pushTokenPath(pushToken: string): string {
  return `pushTokens/${createHash("sha256").update(pushToken).digest("base64url")}`;
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
  const user: User = { id, name: String(data.name), createdAt: millis(data.createdAt) };
  if (typeof data.photoVersion === "number") user.photoVersion = data.photoVersion;
  if (isAvatar(data.avatar)) user.avatar = data.avatar;
  if (isPlatform(data.ringOn)) user.ringOn = data.ringOn;
  if (data.rollOver === true) user.rollOver = true;
  const requested = millis(data.diagnosticsRequestedAt);
  if (requested && Date.now() - requested < DIAGNOSTICS_REQUEST_MS) user.diagnosticsRequestedAt = requested;
  return user;
}

function toDevice(id: string, data: FirestoreData): AccountDevice {
  return {
    id,
    platform: isPlatform(data.platform) ? data.platform : "watch",
    pushToken: String(data.pushToken ?? ""),
    pushType: data.pushType === "pushtotalk" ? "pushtotalk" : "alert",
    apnsEnvironment: data.apnsEnvironment === "production" ? "production" : "sandbox",
    updatedAt: millis(data.updatedAt),
  };
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}
