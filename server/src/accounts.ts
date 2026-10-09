// Accounts, friends, invites, blocks, reports and devices (design decision 2026-09-27; the v2
// contract, contracts/README.md, from Phase 0 of ANDROID_WEAR_OS_PLAN.md).
//
//   users/{uid}                     name, identity {provider, subject}, createdAt, photoVersion (when
//                                   there's a photo), avatar (a built-in mascot's ID, instead of a
//                                   photo), preferredFormFactor ("phone" or "watch"; absent =
//                                   automatic: the watch if one can be rung), rollOver (true: an
//                                   unanswered watch rings the phone; absent = off), schemaVersion 2
//   users/{uid}/friends/{friendId}  since, favorite (the user's star), lastMessageAt (when the
//                                   friend last talked to the user; written by the relay).
//                                   The friendship is written on both sides in one commit
//   users/{uid}/blocks/{otherId}    since. Blocking also deletes the friendship both ways
//   users/{uid}/devices/{deviceId}  clientKind, formFactor, delivery {provider, mode, token?,
//                                   environment?}, availability {enabled, notifications},
//                                   capabilities {relayProtocols, audioFormats, decode, encode,
//                                   features}, clientVersion, build, lastActiveAt (the person used
//                                   it; a token refresh doesn't change it), updatedAt, schemaVersion 2
//   users/{uid}/sessions/{deviceId} sid, clientKind, createdAt, refreshedAt; a watch's companion
//                                   session also parentDeviceId, parentSid (the phone session that
//                                   made it) and requestId. One per device, so concurrent sign-ins
//                                   on a device can't leave extras. Ending or replacing a phone's
//                                   session ends its companions'
//   identities/{provider}_{sha256 of subject}
//                                   userId, provider, createdAt. Created only if absent: one account
//                                   per sign-in identity. Apple and Google identities are separate
//                                   accounts; nothing links them
//   pushTokens/{sha256 of scope and token}
//                                   userId, deviceId, scope, updatedAt: the one registration a push
//                                   token belongs to within its provider, topic and environment.
//                                   Registering it elsewhere (another account, or a new device ID
//                                   after a reinstall) removes the old registration
//   invites/{code}                  from, createdAt, expireAt (Firestore TTL deletes it)
//
// Records from before Phase 0 (no schemaVersion) aren't read: tools/migrate-v2.ts converts them.
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
import type { Docs } from "./docs.ts";
import { nameAllowed } from "./name-filter.ts";
import { ENC_CERT_LIFETIME_MS, parseDeviceCertificate, parseEncryptionKeyCertificate, parsePhoneCertificate, type FriendKeysJSON } from "./e2ee.ts";
import {
  DEFAULT_CAPABILITIES,
  companionKindOf,
  deliveryToken,
  formFactorOf,
  isClientKind,
  isFormFactor,
  isSignInProvider,
  receiveModeOf,
  tokenScope,
  CODEC_NAMES,
  type Availability,
  type Capabilities,
  type ClientKind,
  type Delivery,
  type FormFactor,
  type ReceiveMode,
  type SignInProvider,
} from "./contract.ts";

export const USER_ID_PREFIX = "u_";
export const REPORT_REASONS = ["harassment", "spam", "inappropriate", "photo", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const SCHEMA_VERSION = 2;

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
// The relay records a device's use at most this often.
const ACTIVE_WRITE_MS = 60_000;

export interface User {
  id: string;
  name: string;
  createdAt: number;
  // When the profile photo last changed (ms); absent without one.
  photoVersion?: number;
  // A built-in mascot picture (the apps bundle the art), used instead of a photo.
  avatar?: string;
  // How the account signs in. Never shown to friends.
  signInProvider?: SignInProvider;
  // Which form factor rings first (design decision 2026-09-27); absent = the watch if there is one.
  preferredFormFactor?: FormFactor;
  // An unanswered ring on the watch rolls over to the phone (design decision 2026-10-01).
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
  keys?: FriendKeysJSON;
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

// A device registered to be rung.
export interface AccountDevice {
  id: string;
  clientKind: ClientKind;
  formFactor: FormFactor;
  delivery: Delivery;
  receiveMode: ReceiveMode;
  availability: Availability;
  capabilities: Capabilities;
  clientVersion?: string;
  build?: string;
  e2ee?: { phoneCert: string; deviceCert: string; encCert: string };
  previousEncCert?: { encCert: string; until: number };
  // When the person last used it (the relay records talks and joins); orders devices of a kind.
  lastActiveAt: number;
  updatedAt: number;
  // The device has a current session (ringLookup only).
  hasSession?: boolean;
}

// What a client registers (api.ts checks it with contract.ts first).
export interface DeviceRegistration {
  clientKind: ClientKind;
  delivery: Delivery;
  availability: Availability;
  capabilities: Capabilities;
  clientVersion?: string;
  build?: string;
  e2ee?: { phoneCert: string; deviceCert: string; encCert: string };
}

// A device's current session.
export interface SessionRecord {
  sid: string;
  clientKind: ClientKind;
  // Companion (watch) sessions: the phone that made it.
  parentDeviceId?: string;
}

export type RingLookup =
  | { allowed: false }
  | { allowed: true; fromName: string; devices: AccountDevice[]; preferredFormFactor?: FormFactor; rollOver?: boolean };

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
  // When the relay last recorded each device's use (markActive), so it writes once a minute.
  private activeWrites = new Map<string, number>();

  constructor(docs: Docs, options: AccountsOptions = {}) {
    this.docs = docs;
    this.opts = { now: Date.now, inviteTtlMs: 7 * DAY_MS, invitesPerDay: 50, botInvite: null, ...options };
  }

  // The account for this sign-in identity, created on its first sign-in. Apple only shares the
  // user's name on that first sign-in, so `name` is used only when creating.
  async signIn(provider: SignInProvider, subject: string, name?: string): Promise<{ user: User; created: boolean }> {
    if (!isSignInProvider(provider)) throw new AccountError(400, "bad-request", "unknown sign-in provider");
    checkId(subject, "sign-in subject");
    const identityPath = identityDocPath(provider, subject);
    for (let attempt = 0; attempt < 3; attempt++) {
      const [identity] = await this.docs.getAll([identityPath]);
      if (identity?.userId !== undefined) {
        const user = await this.user(String(identity.userId));
        if (user) return { user, created: false };
      }
      const id = newUserId();
      const createdAt = this.opts.now();
      // Apple's name is only offered once, so a disallowed one becomes "Friend" rather than
      // failing the sign-in; onboarding asks for a screen name next anyway.
      const clean = cleanName(name);
      const user: User = { id, name: clean && nameAllowed(clean) ? clean : "Friend", createdAt, signInProvider: provider };
      try {
        await this.docs.commit([
          // A mapping left behind with no user (shouldn't happen) is replaced.
          { set: identityPath, data: { userId: id, provider, createdAt: new Date(createdAt) }, exists: identity !== undefined },
          {
            set: `users/${id}`,
            data: {
              name: user.name,
              identity: { provider, subject },
              createdAt: new Date(createdAt),
              schemaVersion: SCHEMA_VERSION,
            },
            exists: false,
          },
        ]);
        return { user, created: true };
      } catch (err) {
        // Another sign-in for the same identity won the race: use its account.
        if (!(err instanceof PreconditionFailed)) throw err;
      }
    }
    throw new AccountError(409, "sign-in-conflict", "couldn't create the account");
  }

  async signInWithApple(appleSub: string, name?: string): Promise<{ user: User; created: boolean }> {
    return this.signIn("apple", appleSub, name);
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

  // The account's sign-in identity: the provider whose proof deletion needs, and the subject it
  // must name.
  async identity(id: string): Promise<{ provider: SignInProvider; subject: string } | undefined> {
    const [data] = await this.docs.getAll([`users/${requireUserId(id)}`]);
    return data ? identityOf(data) : undefined;
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

  // Null goes back to automatic: the watch if the account has one.
  async setPreferredFormFactor(id: string, formFactor: FormFactor | null): Promise<User> {
    try {
      await this.docs.commit([{
        set: `users/${requireUserId(id)}`,
        data: formFactor ? { preferredFormFactor: formFactor } : {},
        fields: ["preferredFormFactor"],
        exists: true,
      }]);
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
  // Replacing a phone's session also ends the companion (watch) sessions it made, with their
  // push registrations: a new sign-in is a new generation, and the watch asks again.
  async createSession(userId: string, deviceId: string, clientKind: ClientKind): Promise<string> {
    requireUserId(userId);
    checkId(deviceId, "device");
    requireClientKind(clientKind);
    const sid = randomId(16);
    const now = new Date(this.opts.now());
    await this.docs.commit([{
      set: `users/${userId}/sessions/${deviceId}`,
      data: { sid, clientKind, createdAt: now, refreshedAt: now, schemaVersion: SCHEMA_VERSION },
    }]);
    await this.revokeCompanions(userId, deviceId, sid);
    return sid;
  }

  // A companion session (the watch's), made by the phone signed in as `parent`. Only for the
  // phone's own ecosystem's watch kind, and only while the phone's session is current. The same
  // requestId from the same phone session gets the same session back, so the phone can retry.
  //
  // It's a transaction that reads the phone's session, so a sign-out or new sign-in on the phone
  // can't slip in before it commits: if the phone's session changes first, this runs again and
  // fails; if this commits first, the phone's change then finds it (revokeCompanions).
  async createCompanionSession(
    userId: string,
    parent: { deviceId: string; sid: string },
    deviceId: string,
    clientKind: ClientKind,
    requestId?: string,
  ): Promise<{ sid: string; clientKind: ClientKind }> {
    requireUserId(userId);
    checkId(deviceId, "device");
    if (requestId !== undefined) checkId(requestId, "request");
    requireClientKind(clientKind);
    if (deviceId === parent.deviceId) throw new AccountError(400, "same-device");
    const now = new Date(this.opts.now());
    const parentPath = `users/${userId}/sessions/${parent.deviceId}`;
    const path = `users/${userId}/sessions/${deviceId}`;
    return this.docs.transaction(async (get) => {
      const [parentSession, existing] = await get([parentPath, path]);
      const parentKind = parentSession ? sessionKind(parentSession) : null;
      if (!parentSession || parentSession.sid !== parent.sid || !parentKind) throw new AccountError(401, "session-ended");
      if (companionKindOf(parentKind) !== clientKind) {
        throw new AccountError(400, "unsupported-client-kind", `a ${parentKind} session can't make a ${clientKind} session`);
      }
      if (existing && requestId !== undefined && existing.requestId === requestId &&
          existing.parentDeviceId === parent.deviceId && existing.parentSid === parent.sid) {
        return { writes: [], result: { sid: String(existing.sid), clientKind } };
      }
      // A phone's own session isn't the companion's to replace.
      const existingKind = existing ? sessionKind(existing) : null;
      if (existing && existing.parentDeviceId === undefined && existingKind && formFactorOf(existingKind) === "phone") {
        throw new AccountError(409, "device-conflict", "that device is signed in as a phone");
      }
      const sid = randomId(16);
      const writes: Write[] = [
        {
          set: path,
          data: {
            sid,
            clientKind,
            parentDeviceId: parent.deviceId,
            parentSid: parent.sid,
            ...(requestId !== undefined ? { requestId } : {}),
            createdAt: now,
            refreshedAt: now,
            schemaVersion: SCHEMA_VERSION,
          },
        },
      ];
      return { writes, result: { sid, clientKind } };
    });
  }

  // Every API call and relay connection: the token's session is still its device's current one,
  // on an account that still exists. Signing out, signing in again on the device (or on the
  // phone that made a watch's session) and deleting the account end it, whatever the token's
  // expiry says.
  async activeSession(userId: string, sid: string, deviceId: string): Promise<SessionRecord | null> {
    if (!isUserId(userId) || !isId(sid) || !isId(deviceId)) return null;
    const [user, session] = await this.docs.getAll([`users/${userId}`, `users/${userId}/sessions/${deviceId}`]);
    const clientKind = session ? sessionKind(session) : null;
    if (!user || !session || session.sid !== sid || !clientKind) return null;
    return {
      sid,
      clientKind,
      ...(typeof session.parentDeviceId === "string" ? { parentDeviceId: session.parentDeviceId } : {}),
    };
  }

  async sessionActive(userId: string, sid: string, deviceId: string): Promise<boolean> {
    return (await this.activeSession(userId, sid, deviceId)) !== null;
  }

  // Refreshing: true (and the session's refreshedAt updated) if this is still the device's
  // session.
  async touchSession(userId: string, sid: string, deviceId: string): Promise<boolean> {
    if (!isUserId(userId) || !isId(sid) || !isId(deviceId)) return false;
    const [current] = await this.docs.getAll([`users/${userId}/sessions/${deviceId}`]);
    if (!current || current.sid !== sid || !sessionKind(current)) return false;
    try {
      await this.docs.commit([
        { set: `users/${userId}/sessions/${deviceId}`, data: { refreshedAt: new Date(this.opts.now()) }, fields: ["refreshedAt"], exists: true },
      ]);
      return true;
    } catch (err) {
      if (err instanceof PreconditionFailed) return false;
      throw err;
    }
  }

  // Signing out: the session and the device's push registration go, so it stops ringing; and
  // on a phone, its companions' sessions and registrations too. A token the device has already
  // replaced ends nothing.
  async endSession(userId: string, sid: string, deviceId: string): Promise<void> {
    requireUserId(userId);
    checkId(sid, "session");
    checkId(deviceId, "device");
    const [current, device] = await this.docs.getAll([`users/${userId}/sessions/${deviceId}`, `users/${userId}/devices/${deviceId}`]);
    if (current?.sid !== sid) return;
    await this.docs.commit([
      { delete: `users/${userId}/sessions/${deviceId}` },
      { delete: `users/${userId}/devices/${deviceId}` },
      ...(await this.pointerDeletes(userId, device ? [{ id: deviceId, data: device }] : [])),
    ]);
    await this.revokeCompanions(userId, deviceId, null);
  }

  // A phone's session changed (`sid`) or ended (null): its companions made by any other session
  // end, with their devices' registrations. Run after the change commits (see
  // createCompanionSession for why that's enough).
  private async revokeCompanions(userId: string, parentDeviceId: string, sid: string | null): Promise<void> {
    const companions = (await this.docs.list(`users/${userId}/sessions`))
      .filter((s) => s.id !== parentDeviceId && s.data.parentDeviceId === parentDeviceId && (sid === null || s.data.parentSid !== sid));
    if (!companions.length) return;
    const devices = await this.docs.getAll(companions.map((c) => `users/${userId}/devices/${c.id}`));
    await this.docs.commit([
      ...companions.flatMap((c): Write[] => [{ delete: `users/${userId}/sessions/${c.id}` }, { delete: `users/${userId}/devices/${c.id}` }]),
      ...(await this.pointerDeletes(userId, companions.flatMap((c, i) => (devices[i] ? [{ id: c.id, data: devices[i]! }] : [])))),
    ]);
  }

  // Registers this device to be rung. A push token belongs to one registration: one registered
  // elsewhere (another account, or this account's earlier device ID after a reinstall) loses it.
  // lastActiveAt survives a token refresh.
  async registerDevice(userId: string, deviceId: string, reg: DeviceRegistration): Promise<AccountDevice> {
    requireUserId(userId);
    checkId(deviceId, "device");
    const path = `users/${userId}/devices/${deviceId}`;
    const pointers = tokenPointers(reg.delivery);
    const now = this.opts.now();
    if (reg.capabilities.audioFormats.includes(2) !== (reg.e2ee !== undefined)) {
      throw new AccountError(400, "bad-certificate", "format 2 capability and device certificates must be registered together");
    }
    if (reg.e2ee) {
      try {
        const phone = parsePhoneCertificate(Buffer.from(reg.e2ee.phoneCert, "base64"));
        const device = parseDeviceCertificate(Buffer.from(reg.e2ee.deviceCert, "base64"), phone);
        const enc = parseEncryptionKeyCertificate(Buffer.from(reg.e2ee.encCert, "base64"), device);
        if (phone.userId !== userId || device.userId !== userId || device.deviceId !== deviceId ||
            device.clientKind !== reg.clientKind || enc.issuedAt > now + 60_000 ||
            enc.notAfter !== enc.issuedAt + ENC_CERT_LIFETIME_MS || enc.notAfter <= now) {
          throw new Error("certificate does not match this registration");
        }
      } catch {
        throw new AccountError(400, "bad-certificate", "invalid device encryption certificates");
      }
    }
    return this.docs.transaction(async (get) => {
      const [user, previous, ...owners] = await get([`users/${userId}`, path, ...pointers]);
      if (!user) throw new AccountError(404, "no-account");
      const token = deliveryToken(reg.delivery);
      const writes: Write[] = [];
      // The token was registered somewhere else: that registration goes, so it can't take rings
      // meant for this one.
      const stale = new Set<string>();
      for (const owner of owners) {
        if (owner && (owner.userId !== userId || owner.deviceId !== deviceId) && isUserId(owner.userId) && isId(owner.deviceId)) {
          stale.add(`users/${owner.userId}/devices/${owner.deviceId}`);
        }
      }
      for (const stalePath of stale) {
        const [old] = await get([stalePath]);
        // Only the same token in the same scope.
        const oldDelivery = old ? storedDelivery(old) : null;
        if (old && oldDelivery && token !== undefined && deliveryToken(oldDelivery) === token && tokenScope(oldDelivery) === tokenScope(reg.delivery)) {
          writes.push({ delete: stalePath });
          const [, ownerId, , ownerDevice] = stalePath.split("/");
          writes.push(...(await this.pointerDeletes(ownerId, [{ id: ownerDevice, data: old }], pointers)));
        }
      }
      // The device's previous token no longer points here.
      if (previous) writes.push(...(await this.pointerDeletes(userId, [{ id: deviceId, data: previous }], pointers)));
      const lastActiveAt = previous ? millis(previous.lastActiveAt ?? previous.updatedAt) || now : now;
      const data = deviceData(reg, now, lastActiveAt);
      const old = previous?.e2ee as AccountDevice["e2ee"] | undefined;
      if (reg.e2ee && old && old.encCert !== reg.e2ee.encCert && old.deviceCert === reg.e2ee.deviceCert) {
        data.previousEncCert = { encCert: old.encCert, until: now + 7 * DAY_MS };
      } else if (reg.e2ee && previous?.previousEncCert) {
        const previousKey = previous.previousEncCert as AccountDevice["previousEncCert"];
        if (previousKey && previousKey.until > now) data.previousEncCert = previousKey;
      }
      writes.push(
        { set: path, data },
        ...pointers.map((p): Write => ({ set: p, data: { userId, deviceId, scope: tokenScope(reg.delivery), updatedAt: now } })),
      );
      return { writes, result: toDevice(deviceId, data)! };
    });
  }

  // The relay, when a provider says a device's push token is no longer valid. Only that token
  // goes: if the device has registered a new one since, it stays. True if it was removed.
  async removeDevice(userId: string, deviceId: string, pushToken: string): Promise<boolean> {
    if (!isUserId(userId) || !isId(deviceId)) return false;
    const path = `users/${userId}/devices/${deviceId}`;
    return this.docs.transaction(async (get) => {
      const [device] = await get([path]);
      const stale = device !== undefined && storedToken(device) === pushToken;
      if (!stale) return { writes: [], result: false };
      return {
        writes: [{ delete: path, exists: true }, ...(await this.pointerDeletes(userId, [{ id: deviceId, data: device }]))],
        result: true,
      };
    });
  }

  // The relay, when the person talks or answers on a device: it orders their devices of one kind
  // for rings. At most once a minute per device, and never waited for.
  async markActive(userId: string, deviceId: string, at: number): Promise<void> {
    if (!isUserId(userId) || !isId(deviceId)) return;
    const key = `${userId}/${deviceId}`;
    const last = this.activeWrites.get(key);
    if (last !== undefined && at - last < ACTIVE_WRITE_MS) return;
    this.activeWrites.set(key, at);
    if (this.activeWrites.size > 10_000) this.activeWrites.clear();
    try {
      await this.docs.commit([{ set: `users/${userId}/devices/${deviceId}`, data: { lastActiveAt: new Date(at) }, fields: ["lastActiveAt"], exists: true }]);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
    }
  }

  // Deletes for the pushTokens pointers that still name these devices of the user's.
  // `skip`: pointers the caller is about to rewrite.
  private async pointerDeletes(userId: string, devices: Array<{ id: string; data: FirestoreData }>, skip: string[] = []): Promise<Write[]> {
    const owned = devices.flatMap((d) => tokenPointers(storedDelivery(d.data)).filter((p) => !skip.includes(p)).map((path) => ({ path, deviceId: d.id })));
    if (!owned.length) return [];
    const owners = await this.docs.getAll(owned.map((o) => o.path));
    return owned.flatMap((o, i): Write[] => (owners[i]?.userId === userId && owners[i]?.deviceId === o.deviceId ? [{ delete: o.path }] : []));
  }

  // The form factors registered for rings, for the phone's Ring Me On (unknown kinds left out).
  async formFactors(userId: string): Promise<FormFactor[]> {
    const present = new Set((await this.devices(userId)).map((d) => d.formFactor));
    return (["phone", "watch"] as const).filter((f) => present.has(f));
  }

  async devices(userId: string): Promise<AccountDevice[]> {
    return (await this.docs.list(`users/${requireUserId(userId)}/devices`)).flatMap((d) => toDevice(d.id, d.data) ?? []);
  }

  async device(userId: string, deviceId: string): Promise<AccountDevice | null> {
    const [row] = await this.docs.getAll([`users/${requireUserId(userId)}/devices/${deviceId}`]);
    return row ? toDevice(deviceId, row) : null;
  }

  // The key directory. Only format 2 is carried, so a device without keys (a registration left
  // by a build before E2EE) can't be rung or sealed to: it's left out rather than holding up its
  // account's friends. allDevicesHaveKeys, which builds before PR D wait for, is then true
  // whenever a device is listed.
  async friendKeys(userId: string): Promise<FriendKeysJSON> {
    const keyed = (await this.devices(userId)).flatMap((d) => d.e2ee ? [{ device: d, e2ee: d.e2ee }] : []);
    const phones = [...new Set(keyed.map((k) => k.e2ee.phoneCert))];
    return { phones, devices: keyed.map(({ device, e2ee }) => ({ deviceId: device.id, clientKind: device.clientKind, deviceCert: e2ee.deviceCert, encCert: e2ee.encCert })),
      allDevicesHaveKeys: keyed.length > 0 };
  }

  async friends(userId: string): Promise<Friend[]> {
    const rows = await this.docs.list(`users/${requireUserId(userId)}/friends`);
    const users = await this.docs.getAll(rows.map((r) => `users/${r.id}`));
    const keys = await Promise.all(rows.map((r) => this.friendKeys(r.id)));
    return rows
      .flatMap((r, i) => {
        const user = users[i];
        if (!user) return [];
        const friend: Friend = { id: r.id, name: String(user.name), since: millis(r.data.since) };
        if (typeof user.photoVersion === "number") friend.photoVersion = user.photoVersion;
        if (isAvatar(user.avatar)) friend.avatar = user.avatar;
        if (r.data.favorite === true) friend.favorite = true;
        if (r.data.lastMessageAt !== undefined) friend.lastMessageAt = millis(r.data.lastMessageAt);
        friend.keys = keys[i];
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
    const [[sender, friendship, recipient], devices, sessions] = await Promise.all([
      this.docs.getAll([`users/${from}`, `users/${from}/friends/${to}`, `users/${to}`]),
      this.docs.list(`users/${to}/devices`),
      this.docs.list(`users/${to}/sessions`),
    ]);
    if (!sender || !friendship) return { allowed: false };
    // A device rings only with a current session (signing out removes the registration anyway;
    // this catches one left behind).
    const withSessions = new Set(sessions.map((s) => s.id));
    const preferredFormFactor = recipient ? preferredFormFactorOf(recipient) : undefined;
    return {
      allowed: true,
      fromName: String(sender.name),
      devices: devices.flatMap((d) => {
        const device = toDevice(d.id, d.data);
        return device ? [{ ...device, hasSession: withSessions.has(d.id) }] : [];
      }),
      ...(preferredFormFactor ? { preferredFormFactor } : {}),
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

  // Diagnostics (the Beta telemetry spec): the devices see the request in GET /v2/me and
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
  // the sign-in identity's mappings. The user document goes last, so a failed deletion can be
  // retried. Reports stay (IDs only). The caller checks the provider's proof first.
  async deleteAccount(userId: string): Promise<{ identity: { provider: SignInProvider; subject: string } | null }> {
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
    const identity = identityOf(user) ?? null;
    const writes: Write[] = [
      ...friends.flatMap((f): Write[] => [{ delete: `users/${f.id}/friends/${userId}` }, { delete: `users/${userId}/friends/${f.id}` }]),
      ...blocks.map((b): Write => ({ delete: `users/${userId}/blocks/${b.id}` })),
      ...devices.map((d): Write => ({ delete: `users/${userId}/devices/${d.id}` })),
      ...(await this.pointerDeletes(userId, devices)),
      ...sessions.map((s): Write => ({ delete: `users/${userId}/sessions/${s.id}` })),
      ...invites.map((i): Write => ({ delete: `invites/${i.id}` })),
      ...diagnostics.map((d): Write => ({ delete: `diagnostics/${d.id}` })),
      ...feedback.map((f): Write => ({ delete: `feedback/${f.id}` })),
      ...(identity ? [{ delete: identityDocPath(identity.provider, identity.subject) }] : []),
      { delete: `photos/${userId}` },
    ];
    for (let i = 0; i < writes.length; i += MAX_WRITES) await this.docs.commit(writes.slice(i, i + MAX_WRITES));
    await this.docs.commit([{ delete: `users/${userId}` }]);
    return { identity };
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

// A mascot ID such as "honey" or "bow-lashes-cocoa".
export function isAvatar(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value);
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

// A sign-in identity's index document: the subject hashed, so it isn't stored twice in IDs.
export function identityDocPath(provider: SignInProvider, subject: string): string {
  return `identities/${provider}_${createHash("sha256").update(subject).digest("base64url")}`;
}

export function identityOf(data: FirestoreData): { provider: SignInProvider; subject: string } | undefined {
  const identity = data.identity as Record<string, unknown> | undefined;
  if (identity && isSignInProvider(identity.provider) && typeof identity.subject === "string") {
    return { provider: identity.provider, subject: identity.subject };
  }
  return undefined;
}

export function preferredFormFactorOf(data: FirestoreData): FormFactor | undefined {
  return isFormFactor(data.preferredFormFactor) ? data.preferredFormFactor : undefined;
}

// A session's client kind; null for one this server can't read (it ends the session).
function sessionKind(data: FirestoreData): ClientKind | null {
  return isClientKind(data.clientKind) ? data.clientKind : null;
}

function requireClientKind(kind: unknown): ClientKind {
  if (!isClientKind(kind)) throw new AccountError(400, "bad-request", "unknown client kind");
  return kind;
}

// The pushTokens document a delivery's token owns, scoped by provider, topic and environment
// (none for a delivery without a token).
export function tokenPointers(delivery: Delivery | null): string[] {
  const token = delivery ? deliveryToken(delivery) : undefined;
  const scope = delivery ? tokenScope(delivery) : null;
  if (!delivery || !token || !scope) return [];
  return [`pushTokens/${createHash("sha256").update(`${scope}\n${token}`).digest("base64url")}`];
}

// A stored registration's delivery. Null without one this server can ring.
export function storedDelivery(data: FirestoreData): Delivery | null {
  const d = data.delivery as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    switch (d.provider) {
      case "apns":
        if ((d.mode === "alert" || d.mode === "pushtotalk") && typeof d.token === "string" && d.token) {
          return { provider: "apns", mode: d.mode, token: d.token, environment: d.environment === "production" ? "production" : "sandbox" };
        }
        return null;
      case "fcm":
        return d.mode === "notification" && typeof d.token === "string" && d.token ? { provider: "fcm", mode: "notification", token: d.token } : null;
      case "relay":
        return d.mode === "foreground" ? { provider: "relay", mode: "foreground" } : null;
      case "test":
        return d.mode === "connection" ? { provider: "test", mode: "connection" } : null;
      default:
        // A delivery a later service added: not one this server can ring.
        return null;
    }
  }
  return null;
}

function storedToken(data: FirestoreData): string | undefined {
  const delivery = storedDelivery(data);
  return delivery ? deliveryToken(delivery) : undefined;
}

// A registration as stored.
export function deviceData(reg: DeviceRegistration, now: number, lastActiveAt: number): FirestoreData {
  return {
    clientKind: reg.clientKind,
    formFactor: formFactorOf(reg.clientKind),
    delivery: { ...reg.delivery },
    receiveMode: receiveModeOf(reg.delivery),
    availability: { ...reg.availability },
    capabilities: structuredClone(reg.capabilities),
    ...(reg.clientVersion ? { clientVersion: reg.clientVersion } : {}),
    ...(reg.build ? { build: reg.build } : {}),
    ...(reg.e2ee ? { e2ee: reg.e2ee } : {}),
    lastActiveAt: new Date(lastActiveAt),
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
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
  const identity = identityOf(data);
  if (identity) user.signInProvider = identity.provider;
  const preferred = preferredFormFactorOf(data);
  if (preferred) user.preferredFormFactor = preferred;
  if (data.rollOver === true) user.rollOver = true;
  const requested = millis(data.diagnosticsRequestedAt);
  if (requested && Date.now() - requested < DIAGNOSTICS_REQUEST_MS) user.diagnosticsRequestedAt = requested;
  return user;
}

// A stored registration. Null for one this server can't ring: a client kind or delivery a later
// service added, or no route at all.
export function toDevice(id: string, data: FirestoreData): AccountDevice | null {
  const clientKind = isClientKind(data.clientKind) ? data.clientKind : null;
  const delivery = storedDelivery(data);
  if (!clientKind || !delivery) return null;
  const a = data.availability as Record<string, unknown> | undefined;
  const c = data.capabilities as Record<string, unknown> | undefined;
  const ints = (v: unknown, fallback: number[]) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : fallback);
  const codecs = (v: unknown, fallback: Capabilities["decode"]) => (Array.isArray(v) ? CODEC_NAMES.filter((n) => v.includes(n)) : fallback);
  const device: AccountDevice = {
    id,
    clientKind,
    formFactor: formFactorOf(clientKind),
    delivery,
    receiveMode: receiveModeOf(delivery),
    availability: {
      enabled: a?.enabled !== false,
      notifications: a?.notifications === "authorized" || a?.notifications === "denied" ? a.notifications : "unknown",
    },
    capabilities: c
      ? {
          relayProtocols: ints(c.relayProtocols, DEFAULT_CAPABILITIES.relayProtocols),
          audioFormats: ints(c.audioFormats, DEFAULT_CAPABILITIES.audioFormats),
          decode: codecs(c.decode, DEFAULT_CAPABILITIES.decode),
          encode: codecs(c.encode, DEFAULT_CAPABILITIES.encode),
          features: Array.isArray(c.features) ? c.features.filter((f): f is string => typeof f === "string") : [],
        }
      : structuredClone(DEFAULT_CAPABILITIES),
    lastActiveAt: millis(data.lastActiveAt ?? data.updatedAt),
    updatedAt: millis(data.updatedAt),
  };
  if (typeof data.clientVersion === "string") device.clientVersion = data.clientVersion;
  if (typeof data.build === "string") device.build = data.build;
  if (data.e2ee && typeof data.e2ee === "object") device.e2ee = data.e2ee as AccountDevice["e2ee"];
  if (data.previousEncCert && typeof data.previousEncCert === "object") device.previousEncCert = data.previousEncCert as AccountDevice["previousEncCert"];
  return device;
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}
