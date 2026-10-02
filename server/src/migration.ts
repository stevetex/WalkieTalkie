// The Phase 0 cutover (ANDROID_WEAR_OS_PLAN.md, section 7; deploy/gcp/PHASE0_ROLLOUT.md): the
// tester records the v1 server wrote become v2 records, keeping their IDs. tools/migrate-v2.ts
// runs it in two passes around the deploy of the v2-only server:
//
// migrateToV2, before the deploy (and again after it, for anything the v1 server wrote in
// between). Additive, so the v1 server still running reads everything as before:
//   users/{uid}            identity {provider: "apple", subject: appleSub}, preferredFormFactor
//                          (from ringOn), schemaVersion 2
//   identities/apple_{h}   {userId, provider, createdAt}, created only if absent
//   devices                v2's clientKind, formFactor, delivery, availability, capabilities and
//                          lastActiveAt, from the v1 platform, token and push type
//   pushTokens             v2's scoped pointer beside v1's, for each device's token
//   sessions               clientKind, from the v1 platform. A session still keyed by its sid
//                          (before 2026-09-27) moves to its device's key, as the v1 server
//                          itself does on a refresh
//
// cleanupV1, after the deploy, once verifyV2 finds nothing to fix: the v1 fields and documents
// the v2 server never reads go. users' appleSub and ringOn; devices' platform, pushToken,
// pushType and apnsEnvironment; sessions' platform and deviceId; appleSubs/*; and every
// pushTokens pointer that isn't its device's v2 pointer (v1's, keyed by the token alone).
//
// Each user is migrated in transactions that skip anything already at schemaVersion 2, so a run
// can stop and start again (a checkpoint names the last user done), and a sign-in or
// registration written meanwhile is never overwritten. Ambiguous ownership (an identity or Apple
// mapping naming another account) stops the run: it's reported, not guessed. A v1 registration
// whose token the v2 server has since registered elsewhere is removed, not converted.
//
// retireLegacyWatchSessions ends watch sessions that no phone made (they predate Phase 0's
// parent records), once the testers' updated iPhones can make new ones. A bot's session (its
// device rung by the test delivery) stays: it has no phone to ask.

import { createHash } from "node:crypto";
import { PreconditionFailed, type FirestoreData, type Write } from "./firestore.ts";
import type { Docs } from "./docs.ts";
import { SCHEMA_VERSION, deviceData, identityDocPath, identityOf, isUserId, storedDelivery, toDevice, tokenPointers, type DeviceRegistration } from "./accounts.ts";
import { DEFAULT_CAPABILITIES, tokenScope, type ClientKind, type Delivery, type FormFactor, type SignInProvider } from "./contract.ts";

export interface MigrationCounts {
  users: number;
  usersMigrated: number;
  identitiesCreated: number;
  devices: number;
  devicesMigrated: number;
  pointersCreated: number;
  sessions: number;
  sessionsMigrated: number;
  sessionsMoved: number;
  skippedDevices: number;
  // v1 registrations whose token the v2 server has since registered elsewhere: removed, as a
  // registration elsewhere removes them, rather than revived as a second owner of the token.
  devicesDropped: number;
}

export interface CleanupCounts {
  users: number;
  devices: number;
  sessions: number;
  appleSubs: number;
  pointers: number;
}

export interface MigrationProblem {
  userId: string;
  what: string;
}

export interface MigrationOptions {
  // Report what would change, write nothing.
  dryRun: boolean;
  // Users per batch; after each, onCheckpoint is called with the last user done.
  batchSize?: number;
  // Resume after this user (a checkpoint from an earlier run).
  after?: string;
  onCheckpoint?: (lastUserId: string, counts: MigrationCounts) => void;
  log?: (line: string) => void;
}

export class MigrationStopped extends Error {
  problems: MigrationProblem[];
  constructor(problems: MigrationProblem[]) {
    super(`stopped: ${problems.map((p) => `${p.userId}: ${p.what}`).join("; ")}`);
    this.problems = problems;
  }
}

// ---- The v1 records, as the v1 server wrote them ----

const V1_USER_FIELDS = ["appleSub", "ringOn"];
const V1_DEVICE_FIELDS = ["platform", "pushToken", "pushType", "apnsEnvironment"];
const V1_SESSION_FIELDS = ["platform", "deviceId"];

function v1Kind(platform: unknown): ClientKind | null {
  return platform === "iphone" ? "ios" : platform === "watch" ? "watchos" : null;
}

// The account's identity: v2's, or a v1 account's appleSub.
function identityOrAppleSub(data: FirestoreData): { provider: SignInProvider; subject: string } | undefined {
  return identityOf(data) ?? (typeof data.appleSub === "string" && data.appleSub ? { provider: "apple", subject: data.appleSub } : undefined);
}

function preferredFormFactor(data: FirestoreData): FormFactor | undefined {
  if (data.preferredFormFactor === "phone" || data.preferredFormFactor === "watch") return data.preferredFormFactor;
  return data.ringOn === "iphone" ? "phone" : data.ringOn === "watch" ? "watch" : undefined;
}

// v1's pseudo-tokens ("app:" rang only in the app; "local:" and "poll:" were test bots).
function v1Delivery(pushToken: string, pushType: unknown, apnsEnvironment: unknown): Delivery {
  if (pushToken.startsWith("app:")) return { provider: "relay", mode: "foreground" };
  if (pushToken.startsWith("local:") || pushToken.startsWith("poll:")) return { provider: "test", mode: "connection" };
  return {
    provider: "apns",
    mode: pushType === "pushtotalk" ? "pushtotalk" : "alert",
    token: pushToken,
    environment: apnsEnvironment === "production" ? "production" : "sandbox",
  };
}

// A v1 registration as v2 registers it: no capabilities or permission said, so the defaults.
function v1Registration(data: FirestoreData): DeviceRegistration | null {
  const clientKind = v1Kind(data.platform);
  if (!clientKind || typeof data.pushToken !== "string" || !data.pushToken) return null;
  return {
    clientKind,
    delivery: v1Delivery(data.pushToken, data.pushType, data.apnsEnvironment),
    availability: { enabled: true, notifications: "unknown" },
    capabilities: structuredClone(DEFAULT_CAPABILITIES),
  };
}

function isV2(data: FirestoreData): boolean {
  return (data.schemaVersion as number | undefined ?? 0) >= SCHEMA_VERSION;
}

function emptyCounts(): MigrationCounts {
  return { users: 0, usersMigrated: 0, identitiesCreated: 0, devices: 0, devicesMigrated: 0, pointersCreated: 0, sessions: 0, sessionsMigrated: 0, sessionsMoved: 0, skippedDevices: 0, devicesDropped: 0 };
}

// ---- The additive pass ----

export async function migrateToV2(docs: Docs, options: MigrationOptions): Promise<MigrationCounts> {
  const log = options.log ?? (() => {});
  const counts = emptyCounts();
  const users = (await docs.list("users")).filter((u) => isUserId(u.id) && (!options.after || u.id > options.after));
  const batchSize = options.batchSize ?? 50;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    for (const user of batch) await migrateUser(docs, user.id, options.dryRun, counts, log);
    options.onCheckpoint?.(batch.at(-1)!.id, { ...counts });
  }
  return counts;
}

async function migrateUser(docs: Docs, userId: string, dryRun: boolean, counts: MigrationCounts, log: (line: string) => void): Promise<void> {
  counts.users++;
  const [user] = await docs.getAll([`users/${userId}`]);
  if (!user) return;
  const identity = identityOrAppleSub(user);
  if (!identity) throw new MigrationStopped([{ userId, what: "no sign-in identity (no appleSub or identity)" }]);
  const indexPath = identityDocPath(identity.provider, identity.subject);
  const [index, legacy] = await docs.getAll([indexPath, ...(identity.provider === "apple" ? [`appleSubs/${identity.subject}`] : [])]);
  // The mappings must name this account, or ownership is ambiguous.
  if (index && index.userId !== userId) throw new MigrationStopped([{ userId, what: `identity index names ${String(index.userId)}` }]);
  if (identity.provider === "apple" && legacy && legacy.userId !== userId) {
    throw new MigrationStopped([{ userId, what: `appleSubs mapping names ${String(legacy.userId)}` }]);
  }

  // The user document and the identity index.
  const userNeeds = !isV2(user) || !user.identity;
  if (userNeeds || !index) {
    if (dryRun) {
      if (userNeeds) counts.usersMigrated++;
      if (!index) counts.identitiesCreated++;
    } else {
      // Counted from the transaction's result, so a retried attempt isn't counted twice.
      const done = await docs.transaction(async (get) => {
        const [current, currentIndex] = await get([`users/${userId}`, indexPath]);
        const writes: Write[] = [];
        const result = { user: false, identity: false };
        // Deleted since the list was read: nothing to index.
        if (!current) return { writes, result };
        if (current && (!isV2(current) || !current.identity)) {
          const preferred = preferredFormFactor(current);
          writes.push({
            set: `users/${userId}`,
            data: { identity: { ...identity }, schemaVersion: SCHEMA_VERSION, ...(preferred ? { preferredFormFactor: preferred } : {}) },
            fields: ["identity", "schemaVersion", ...(preferred ? ["preferredFormFactor"] : [])],
            exists: true,
          });
          result.user = true;
        }
        if (!currentIndex) {
          writes.push({ set: indexPath, data: { userId, provider: identity.provider, createdAt: current?.createdAt ?? new Date() }, exists: false });
          result.identity = true;
        } else if (currentIndex.userId !== userId) {
          throw new MigrationStopped([{ userId, what: `identity index names ${String(currentIndex.userId)}` }]);
        }
        return { writes, result };
      });
      if (done.user) counts.usersMigrated++;
      if (done.identity) counts.identitiesCreated++;
    }
  }

  // Devices: the v2 fields beside the v1 ones (a field mask, so the v1 ones stay).
  for (const device of await docs.list(`users/${userId}/devices`)) {
    counts.devices++;
    if (isV2(device.data)) continue;
    if (!v1Registration(device.data)) {
      counts.skippedDevices++;
      log(`  ${userId}/${device.id}: not a v1 registration I can read; left as it is`);
      continue;
    }
    if (dryRun) {
      counts.devicesMigrated++;
      continue;
    }
    const done = await docs.transaction(async (get) => {
      const path = `users/${userId}/devices/${device.id}`;
      const [current] = await get([path]);
      const none = { writes: [], result: { device: false, pointer: false, dropped: false } };
      const reg = current && !isV2(current) ? v1Registration(current) : null;
      if (!current || !reg) return none;
      const [pointer] = tokenPointers(reg.delivery);
      const scope = tokenScope(reg.delivery);
      const [owner] = pointer ? await get([pointer]) : [undefined];
      // The v2 server registered this token somewhere else since (a reinstall, another account):
      // that registration owns it, so this one goes, with its v1 pointer if it still names it.
      if (owner && (owner.userId !== userId || owner.deviceId !== device.id)) {
        const v1Pointer = `pushTokens/${createHash("sha256").update(String(current.pushToken)).digest("base64url")}`;
        const [v1Owner] = await get([v1Pointer]);
        const writes: Write[] = [
          { delete: path, exists: true },
          ...(v1Owner?.userId === userId && v1Owner?.deviceId === device.id ? [{ delete: v1Pointer }] : []),
        ];
        return { writes, result: { device: false, pointer: false, dropped: true } };
      }
      const updatedAt = millis(current.updatedAt);
      const data = deviceData(reg, updatedAt, updatedAt);
      const writes: Write[] = [{ set: path, data, fields: Object.keys(data), exists: true }];
      let pointerCreated = false;
      if (pointer && scope && !owner) {
        writes.push({ set: pointer, data: { userId, deviceId: device.id, scope, updatedAt }, exists: false });
        pointerCreated = true;
      }
      return { writes, result: { device: true, pointer: pointerCreated, dropped: false } };
    });
    if (done.device) counts.devicesMigrated++;
    if (done.pointer) counts.pointersCreated++;
    if (done.dropped) {
      counts.devicesDropped++;
      log(`  ${userId}/${device.id}: its token is registered elsewhere now; removed`);
    }
  }

  // Sessions: the client kind, from v1's platform; and the device's key.
  const sessions = await docs.list(`users/${userId}/sessions`);
  const keyed = new Set(sessions.filter((s) => typeof s.data.deviceId !== "string").map((s) => s.id));
  for (const session of sessions) {
    counts.sessions++;
    const kind = typeof session.data.clientKind === "string" ? session.data.clientKind : v1Kind(session.data.platform) ?? "ios";
    const deviceId = session.data.deviceId;
    if (typeof deviceId === "string" && deviceId !== session.id) {
      counts.sessionsMoved++;
      if (dryRun) continue;
      // A sid-keyed session: its device's key, unless the device has a newer session there.
      await docs.commit([
        ...(keyed.has(deviceId)
          ? []
          : [{ set: `users/${userId}/sessions/${deviceId}`, data: { sid: session.id, clientKind: kind, createdAt: session.data.createdAt ?? new Date(), refreshedAt: session.data.refreshedAt ?? new Date(), schemaVersion: SCHEMA_VERSION }, exists: false }]),
        { delete: `users/${userId}/sessions/${session.id}` },
      ]).catch((err: unknown) => {
        if (!(err instanceof PreconditionFailed)) throw err;
      });
      keyed.add(deviceId);
      continue;
    }
    if (typeof session.data.clientKind === "string") continue;
    if (dryRun) {
      counts.sessionsMigrated++;
      continue;
    }
    try {
      await docs.commit([{ set: `users/${userId}/sessions/${session.id}`, data: { clientKind: kind }, fields: ["clientKind"], exists: true }]);
      counts.sessionsMigrated++;
    } catch (err) {
      // Ended meanwhile.
      if (!(err instanceof PreconditionFailed)) throw err;
    }
  }
}

// ---- Checking ----

// What's still not v2, and anything inconsistent; and (as counts, not problems) the v1 data
// cleanupV1 would remove.
export async function verifyV2(docs: Docs): Promise<{ counts: Record<string, number>; problems: MigrationProblem[] }> {
  const problems: MigrationProblem[] = [];
  const counts: Record<string, number> = { users: 0, devices: 0, sessions: 0, watchSessionsWithoutParent: 0, identities: 0, v1Records: 0, appleSubs: 0, v1Pointers: 0 };
  const identities = await docs.list("identities");
  counts.identities = identities.length;
  const owners = new Map<string, string>();
  for (const i of identities) owners.set(i.id, String(i.data.userId));
  const hasV1 = (data: FirestoreData, fields: string[]) => fields.some((f) => data[f] !== undefined);
  for (const user of (await docs.list("users")).filter((u) => isUserId(u.id))) {
    counts.users++;
    if (hasV1(user.data, V1_USER_FIELDS)) counts.v1Records++;
    const identity = identityOf(user.data);
    if (!identity || !isV2(user.data)) {
      problems.push({ userId: user.id, what: "user not migrated" });
      continue;
    }
    const index = identityDocPath(identity.provider, identity.subject).split("/")[1];
    if (owners.get(index) !== user.id) problems.push({ userId: user.id, what: owners.has(index) ? `identity index names ${owners.get(index)}` : "no identity index" });
    owners.delete(index);
    for (const device of await docs.list(`users/${user.id}/devices`)) {
      counts.devices++;
      if (hasV1(device.data, V1_DEVICE_FIELDS)) counts.v1Records++;
      if (!isV2(device.data)) problems.push({ userId: user.id, what: `device ${device.id} not migrated` });
      else if (!toDevice(device.id, device.data)) problems.push({ userId: user.id, what: `device ${device.id} unreadable` });
    }
    for (const session of await docs.list(`users/${user.id}/sessions`)) {
      counts.sessions++;
      if (hasV1(session.data, V1_SESSION_FIELDS)) counts.v1Records++;
      if (typeof session.data.clientKind !== "string") problems.push({ userId: user.id, what: `session ${session.id} has no client kind` });
      if (typeof session.data.deviceId === "string" && session.data.deviceId !== session.id) problems.push({ userId: user.id, what: `session ${session.id} is keyed by its sid` });
      if (session.data.clientKind === "watchos" && typeof session.data.parentDeviceId !== "string") counts.watchSessionsWithoutParent++;
    }
  }
  for (const [index, userId] of owners) problems.push({ userId, what: `identity ${index} names no account` });
  counts.appleSubs = (await docs.list("appleSubs")).length;
  counts.v1Pointers = (await stalePointers(docs)).length;
  return { counts, problems };
}

// pushTokens documents that aren't the v2 pointer of the device they name: v1's (keyed by the
// token alone), and any naming a device that's gone.
async function stalePointers(docs: Docs): Promise<string[]> {
  const pointers = await docs.list("pushTokens");
  const devicePaths = pointers.map((p) => (isUserId(p.data.userId) && typeof p.data.deviceId === "string" ? `users/${p.data.userId}/devices/${p.data.deviceId}` : null));
  const devices = await docs.getAll(devicePaths.filter((p) => p !== null));
  const byPath = new Map(devicePaths.filter((p) => p !== null).map((p, i) => [p, devices[i]]));
  return pointers.flatMap((p, i) => {
    const device = devicePaths[i] ? byPath.get(devicePaths[i]) : undefined;
    const own = device ? tokenPointers(storedDelivery(device))[0] : undefined;
    return own === `pushTokens/${p.id}` ? [] : [`pushTokens/${p.id}`];
  });
}

// ---- Removing v1 ----

// After the v2 server is deployed and verifyV2 finds no problems: the v1 data goes. Refuses
// (writing nothing) if anything isn't v2 yet.
export async function cleanupV1(docs: Docs, dryRun: boolean, log: (line: string) => void = () => {}): Promise<CleanupCounts> {
  const { problems } = await verifyV2(docs);
  if (problems.length) throw new MigrationStopped(problems);
  const counts: CleanupCounts = { users: 0, devices: 0, sessions: 0, appleSubs: 0, pointers: 0 };
  const writes: Write[] = [];
  // A field mask naming the v1 fields, with none of them in the data, deletes them.
  const strip = (path: string, data: FirestoreData, fields: string[]): boolean => {
    const present = fields.filter((f) => data[f] !== undefined);
    if (!present.length) return false;
    writes.push({ set: path, data: {}, fields: present, exists: true });
    return true;
  };
  for (const user of (await docs.list("users")).filter((u) => isUserId(u.id))) {
    if (strip(`users/${user.id}`, user.data, V1_USER_FIELDS)) counts.users++;
    for (const device of await docs.list(`users/${user.id}/devices`)) {
      if (strip(`users/${user.id}/devices/${device.id}`, device.data, V1_DEVICE_FIELDS)) counts.devices++;
    }
    for (const session of await docs.list(`users/${user.id}/sessions`)) {
      if (strip(`users/${user.id}/sessions/${session.id}`, session.data, V1_SESSION_FIELDS)) counts.sessions++;
    }
  }
  for (const mapping of await docs.list("appleSubs")) {
    writes.push({ delete: `appleSubs/${mapping.id}` });
    counts.appleSubs++;
  }
  for (const pointer of await stalePointers(docs)) {
    writes.push({ delete: pointer });
    counts.pointers++;
  }
  log(`  ${writes.length} writes`);
  if (!dryRun) {
    for (let i = 0; i < writes.length; i += 400) {
      // A record that ended meanwhile (a sign-out) needs nothing more.
      await docs.commit(writes.slice(i, i + 400)).catch(async (err: unknown) => {
        if (!(err instanceof PreconditionFailed)) throw err;
        for (const write of writes.slice(i, i + 400)) {
          await docs.commit([write]).catch((e: unknown) => {
            if (!(e instanceof PreconditionFailed)) throw e;
          });
        }
      });
    }
  }
  return counts;
}

// Watch sessions no phone made (from before Phase 0; their phone is unknown, and isn't guessed)
// end, with their push registrations; the watch asks its phone for a new one. Only sessions
// created before `before`.
export async function retireLegacyWatchSessions(docs: Docs, before: number, dryRun: boolean, log: (line: string) => void = () => {}): Promise<number> {
  let retired = 0;
  for (const user of (await docs.list("users")).filter((u) => isUserId(u.id))) {
    for (const session of await docs.list(`users/${user.id}/sessions`)) {
      const watch = session.data.clientKind === "watchos" || (session.data.clientKind === undefined && session.data.platform === "watch");
      if (!watch || typeof session.data.parentDeviceId === "string" || millis(session.data.createdAt) >= before) continue;
      const deviceId = typeof session.data.deviceId === "string" ? session.data.deviceId : session.id;
      const [device] = await docs.getAll([`users/${user.id}/devices/${deviceId}`]);
      // A bot's "watch" (the Test Bot's account, rung over its relay connection) has no phone to
      // ask: retiring it would leave the bot unreachable.
      if (device && (storedDelivery(device)?.provider === "test" || /^(local|poll):/.test(String(device.pushToken ?? "")))) {
        log(`  ${user.id}: keeping ${deviceId} (a bot's test delivery)`);
        continue;
      }
      log(`  ${user.id}: retiring watch session ${deviceId}`);
      retired++;
      if (dryRun) continue;
      // The v2 pointer, and v1's if the cleanup hasn't run yet.
      const token = device && typeof device.pushToken === "string" ? device.pushToken : undefined;
      const pointers = [
        ...(device ? tokenPointers(storedDelivery(device)) : []),
        ...(token ? [`pushTokens/${createHash("sha256").update(token).digest("base64url")}`] : []),
      ];
      const owners = await docs.getAll(pointers);
      await docs.commit([
        { delete: `users/${user.id}/sessions/${session.id}` },
        { delete: `users/${user.id}/devices/${deviceId}` },
        ...pointers.flatMap((p, i): Write[] => (owners[i]?.userId === user.id && owners[i]?.deviceId === deviceId ? [{ delete: p }] : [])),
      ]);
    }
  }
  return retired;
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}
