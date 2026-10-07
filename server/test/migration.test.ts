// The Phase 0 cutover (migration.ts) on records exactly as the v1 server wrote them: the additive
// pass makes everything readable by the v2-only server with the same IDs, friendships and
// settings, keeps v1's fields, is idempotent and resumable, stops on ambiguous ownership and
// never overwrites what the v2 server wrote meanwhile; the cleanup then removes exactly the v1
// data; and parentless watch sessions are retired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryDocs } from "../src/docs.ts";
import { Accounts, identityDocPath, tokenPointers, type DeviceRegistration } from "../src/accounts.ts";
import { DEFAULT_CAPABILITIES, type Delivery } from "../src/contract.ts";
import { MigrationStopped, cleanupV1, migrateToV2, retireLegacyWatchSessions, verifyV2 } from "../src/migration.ts";
import type { FirestoreData, Write } from "../src/firestore.ts";

const DAY = 86_400_000;
const T = new Date(Date.UTC(2026, 8, 28));
const STEVE = "u_lddgnN9Qtcspo663";
const HELEN = "u_helenHelenHelen";
const BOT = "u_testBotTestBot1";
// v1's pointer: keyed by the token alone.
const v1Pointer = (token: string) => `pushTokens/${createHash("sha256").update(token).digest("base64url")}`;
const apns = (mode: "alert" | "pushtotalk", token: string): Delivery => ({ provider: "apns", mode, token, environment: "production" });
// v2's pointer, keyed by the token's scope and the token.
const v2Pointer = (delivery: Delivery) => tokenPointers(delivery)[0];

// Three accounts as v1 left them: Steve with an iPhone in PushToTalk and a watch, Helen with an
// iPhone in the app only and a session from before 2026-09-27 (keyed by its sid), and a test
// bot rung over its connections ("local:" and "poll:"); friends, a favorite, an invite, a photo.
function v1Records(): Write[] {
  return [
    { set: `users/${STEVE}`, data: { name: "Steve", appleSub: "001.steve.1", ringOn: "watch", rollOver: true, avatar: "honey", createdAt: T } },
    { set: "appleSubs/001.steve.1", data: { userId: STEVE } },
    { set: `users/${STEVE}/devices/phone-1`, data: { platform: "iphone", pushToken: "aa".repeat(32), pushType: "pushtotalk", apnsEnvironment: "production", updatedAt: 1000 } },
    { set: `users/${STEVE}/devices/watch-1`, data: { platform: "watch", pushToken: "bb".repeat(32), pushType: "alert", apnsEnvironment: "production", updatedAt: 2000 } },
    { set: v1Pointer("aa".repeat(32)), data: { userId: STEVE, deviceId: "phone-1", updatedAt: 1000 } },
    { set: v1Pointer("bb".repeat(32)), data: { userId: STEVE, deviceId: "watch-1", updatedAt: 2000 } },
    { set: `users/${STEVE}/sessions/phone-1`, data: { sid: "s1", platform: "iphone", createdAt: T, refreshedAt: T } },
    { set: `users/${STEVE}/sessions/watch-1`, data: { sid: "s2", platform: "watch", createdAt: T, refreshedAt: T } },
    { set: `users/${STEVE}/friends/${HELEN}`, data: { since: T, favorite: true } },
    { set: `users/${HELEN}`, data: { name: "Helen", appleSub: "001.helen.1", photoVersion: 5, createdAt: T } },
    { set: "appleSubs/001.helen.1", data: { userId: HELEN } },
    // v1 wrote no pointer for the shared pseudo-tokens ("app:", "local:", "poll:").
    { set: `users/${HELEN}/devices/phone-2`, data: { platform: "iphone", pushToken: "app:", pushType: "alert", apnsEnvironment: "sandbox", updatedAt: 3000 } },
    { set: `users/${HELEN}/sessions/oldSid99`, data: { deviceId: "phone-2", platform: "iphone", createdAt: T, refreshedAt: T } },
    { set: `users/${HELEN}/friends/${STEVE}`, data: { since: T } },
    { set: "invites/code1234567890", data: { from: HELEN, createdAt: T, expireAt: new Date(T.getTime() + 7 * DAY) } },
    { set: `photos/${HELEN}`, data: { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), updatedAt: T } },
    { set: `users/${BOT}`, data: { name: "Test Bot", appleSub: "test-bot", createdAt: T } },
    { set: "appleSubs/test-bot", data: { userId: BOT } },
    { set: `users/${BOT}/devices/bot-1`, data: { platform: "watch", pushToken: "local:bot", pushType: "alert", apnsEnvironment: "sandbox", updatedAt: 4000 } },
    { set: `users/${BOT}/devices/bot-2`, data: { platform: "iphone", pushToken: "poll:bot", pushType: "alert", apnsEnvironment: "sandbox", updatedAt: 5000 } },
  ];
}

async function seeded(): Promise<MemoryDocs> {
  const docs = new MemoryDocs();
  await docs.commit(v1Records());
  return docs;
}

// Every account document, by path.
async function dump(docs: MemoryDocs): Promise<Record<string, FirestoreData>> {
  const all: Record<string, FirestoreData> = {};
  for (const collection of ["users", "identities", "appleSubs", "pushTokens", "invites", "photos"]) {
    for (const doc of await docs.list(collection)) {
      all[`${collection}/${doc.id}`] = doc.data;
      if (collection !== "users") continue;
      for (const sub of ["friends", "blocks", "devices", "sessions"]) {
        for (const child of await docs.list(`users/${doc.id}/${sub}`)) all[`users/${doc.id}/${sub}/${child.id}`] = child.data;
      }
    }
  }
  return all;
}

async function one(docs: MemoryDocs, path: string): Promise<FirestoreData | undefined> {
  return (await docs.getAll([path]))[0];
}

const registration = (clientKind: DeviceRegistration["clientKind"], delivery: Delivery, notifications: "authorized" | "denied" = "authorized"): DeviceRegistration => ({
  clientKind,
  delivery,
  availability: { enabled: true, notifications },
  capabilities: structuredClone(DEFAULT_CAPABILITIES),
});

// What the v2 server reads of each account's devices.
async function devices(accounts: Accounts, userId: string) {
  return (await accounts.devices(userId)).map((d) => [d.id, d.clientKind, d.delivery.provider, d.delivery.mode, "token" in d.delivery ? d.delivery.token : null, d.lastActiveAt]);
}

test("migration: plan writes nothing; apply makes every record readable by the v2 server and keeps v1's; again changes nothing", async () => {
  const docs = await seeded();
  const before = await dump(docs);
  const plan = await migrateToV2(docs, { dryRun: true });
  assert.deepEqual(
    [plan.users, plan.usersMigrated, plan.identitiesCreated, plan.devices, plan.devicesMigrated, plan.sessions, plan.sessionsMigrated, plan.sessionsMoved, plan.skippedDevices],
    [3, 3, 3, 5, 5, 3, 2, 1, 0],
  );
  assert.deepEqual(await dump(docs), before);
  // Nothing reads before the pass: the v2 server knows no v1 record.
  const unmigrated = new Accounts(docs);
  assert.deepEqual(await unmigrated.devices(STEVE), []);
  assert.equal(await unmigrated.sessionActive(STEVE, "s1", "phone-1"), false);
  assert.deepEqual((await verifyV2(docs)).problems.map((p) => [p.userId, p.what]), [[HELEN, "user not migrated"], [STEVE, "user not migrated"], [BOT, "user not migrated"]]);

  const applied = await migrateToV2(docs, { dryRun: false });
  assert.deepEqual(
    [applied.usersMigrated, applied.identitiesCreated, applied.devicesMigrated, applied.pointersCreated, applied.sessionsMigrated, applied.sessionsMoved, applied.skippedDevices],
    [3, 3, 5, 2, 2, 1, 0],
  );
  const { problems, counts } = await verifyV2(docs);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    [counts.users, counts.identities, counts.devices, counts.sessions, counts.watchSessionsWithoutParent, counts.appleSubs, counts.v1Pointers],
    [3, 3, 5, 3, 1, 3, 2],
  );
  // Every user, device and device-keyed session still has v1 fields (the moved session doesn't).
  assert.equal(counts.v1Records, 3 + 5 + 2);

  const accounts = new Accounts(docs, { now: () => T.getTime() + DAY });
  // The same accounts, found through their identity indexes; the same settings, friends,
  // invites and photos.
  const signedIn = await accounts.signInWithApple("001.steve.1");
  assert.deepEqual([signedIn.user.id, signedIn.created], [STEVE, false]);
  assert.equal((await accounts.signInWithApple("001.helen.1")).user.id, HELEN);
  assert.equal((await accounts.signInWithApple("test-bot")).user.id, BOT);
  const steve = (await accounts.user(STEVE))!;
  assert.deepEqual([steve.name, steve.avatar, steve.preferredFormFactor, steve.rollOver, steve.signInProvider], ["Steve", "honey", "watch", true, "apple"]);
  const helen = (await accounts.user(HELEN))!;
  assert.deepEqual([helen.name, helen.photoVersion, helen.preferredFormFactor, helen.rollOver], ["Helen", 5, undefined, undefined]);
  assert.deepEqual(await accounts.identity(STEVE), { provider: "apple", subject: "001.steve.1" });
  assert.deepEqual((await accounts.friends(STEVE)).map((f) => [f.id, f.favorite, f.photoVersion]), [[HELEN, true, 5]]);
  assert.deepEqual((await accounts.friends(HELEN)).map((f) => [f.id, f.favorite, f.avatar]), [[STEVE, undefined, "honey"]]);
  assert.equal((await accounts.invite("code1234567890", STEVE)).from.id, HELEN);
  assert.equal((await accounts.photo(STEVE, HELEN)).jpeg.length, 4);

  // Devices: the v1 platform, token and push type as a client kind and delivery; "app:" rang
  // only in the app, and the bot's "local:" and "poll:" over its connections.
  assert.deepEqual(await devices(accounts, STEVE), [
    ["phone-1", "ios", "apns", "pushtotalk", "aa".repeat(32), 1000],
    ["watch-1", "watchos", "apns", "alert", "bb".repeat(32), 2000],
  ]);
  assert.deepEqual(await devices(accounts, HELEN), [["phone-2", "ios", "relay", "foreground", null, 3000]]);
  assert.deepEqual(await devices(accounts, BOT), [
    ["bot-1", "watchos", "test", "connection", null, 4000],
    ["bot-2", "ios", "test", "connection", null, 5000],
  ]);
  assert.deepEqual(await accounts.formFactors(STEVE), ["phone", "watch"]);
  const lookup = await accounts.ringLookup(HELEN, STEVE);
  assert.ok(lookup.allowed);
  assert.deepEqual([lookup.preferredFormFactor, lookup.rollOver], ["watch", true]);
  assert.deepEqual(lookup.devices.map((d) => [d.id, d.receiveMode, d.hasSession]), [["phone-1", "automatic", true], ["watch-1", "tap", true]]);
  // Each token has its v2 pointer.
  assert.deepEqual(await docs.getAll([v2Pointer(apns("pushtotalk", "aa".repeat(32))), v2Pointer(apns("alert", "bb".repeat(32)))]).then((p) => p.map((d) => [d?.userId, d?.deviceId, d?.scope])), [
    [STEVE, "phone-1", "apns:pushtotalk:production"],
    [STEVE, "watch-1", "apns:alert:production"],
  ]);

  // Sessions still work, with their client kinds; the sid-keyed one moved to its device's key.
  assert.deepEqual(await accounts.activeSession(STEVE, "s1", "phone-1"), { sid: "s1", clientKind: "ios" });
  assert.deepEqual(await accounts.activeSession(STEVE, "s2", "watch-1"), { sid: "s2", clientKind: "watchos" });
  assert.deepEqual(await accounts.activeSession(HELEN, "oldSid99", "phone-2"), { sid: "oldSid99", clientKind: "ios" });
  assert.deepEqual((await docs.list(`users/${HELEN}/sessions`)).map((s) => [s.id, s.data.sid]), [["phone-2", "oldSid99"]]);
  assert.equal(await accounts.touchSession(HELEN, "oldSid99", "phone-2"), true);

  // v1's fields and documents are all still there, for a rollback.
  const [steveDoc, phone, session] = await docs.getAll([`users/${STEVE}`, `users/${STEVE}/devices/phone-1`, `users/${STEVE}/sessions/phone-1`]);
  assert.deepEqual([steveDoc?.appleSub, steveDoc?.ringOn], ["001.steve.1", "watch"]);
  assert.deepEqual([phone?.platform, phone?.pushToken, phone?.pushType, phone?.apnsEnvironment], ["iphone", "aa".repeat(32), "pushtotalk", "production"]);
  assert.equal(session?.platform, "iphone");
  assert.deepEqual((await docs.list("appleSubs")).map((m) => m.id), ["001.helen.1", "001.steve.1", "test-bot"]);
  assert.deepEqual(await docs.getAll([v1Pointer("aa".repeat(32)), v1Pointer("bb".repeat(32))]).then((p) => p.map((d) => d?.deviceId)), ["phone-1", "watch-1"]);

  const after = await dump(docs);
  const again = await migrateToV2(docs, { dryRun: false });
  assert.deepEqual(
    [again.usersMigrated, again.identitiesCreated, again.devicesMigrated, again.pointersCreated, again.sessionsMigrated, again.sessionsMoved],
    [0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(await dump(docs), after);
});

test("migration: an identity or Apple mapping that names another account stops the run, rather than guessing", async () => {
  const docs = await seeded();
  await docs.commit([{ set: identityDocPath("apple", "001.steve.1"), data: { userId: "u_someoneElse0000", provider: "apple" } }]);
  await assert.rejects(migrateToV2(docs, { dryRun: false }), (err: unknown) =>
    err instanceof MigrationStopped && err.problems.length === 1 && err.problems[0].userId === STEVE && /identity index names u_someoneElse0000/.test(err.message));
  // Helen (before Steve in ID order) was done; Steve, and the bot after him, weren't touched.
  assert.equal((await one(docs, `users/${HELEN}`))?.schemaVersion, 2);
  assert.equal((await one(docs, `users/${STEVE}`))?.schemaVersion, undefined);
  assert.equal((await one(docs, `users/${STEVE}/devices/phone-1`))?.clientKind, undefined);
  assert.equal((await one(docs, `users/${BOT}`))?.schemaVersion, undefined);

  const mapped = await seeded();
  await mapped.commit([{ set: "appleSubs/001.steve.1", data: { userId: "u_someoneElse0000" } }]);
  await assert.rejects(migrateToV2(mapped, { dryRun: true }), (err: unknown) => err instanceof MigrationStopped && /appleSubs mapping names u_someoneElse0000/.test(err.message));

  // An account with no sign-in identity at all isn't guessed at either.
  const anonymous = await seeded();
  await anonymous.commit([{ set: "users/u_aaNoIdentity000", data: { name: "Who", createdAt: T } }]);
  await assert.rejects(migrateToV2(anonymous, { dryRun: false }), (err: unknown) => err instanceof MigrationStopped && /u_aaNoIdentity000: no sign-in identity/.test(err.message));
});

test("migration: resumes after its checkpoint", async () => {
  const docs = await seeded();
  const done: string[] = [];
  await assert.rejects(migrateToV2(docs, {
    dryRun: false,
    batchSize: 1,
    onCheckpoint: (last) => {
      done.push(last);
      throw new Error("interrupted");
    },
  }), /interrupted/);
  assert.deepEqual(done, [HELEN]);
  const rest = await migrateToV2(docs, { dryRun: false, after: done[0], batchSize: 1, onCheckpoint: (last) => done.push(last) });
  assert.deepEqual([rest.users, rest.usersMigrated, rest.devicesMigrated], [2, 2, 4]);
  assert.deepEqual(done, [HELEN, STEVE, BOT]);
  assert.deepEqual((await verifyV2(docs)).problems, []);
});

test("migration: what the v2 server wrote before the pass is never overwritten", async () => {
  const docs = await seeded();
  const accounts = new Accounts(docs);
  // After the deploy, before the second pass: Steve's watch registers a new token, he picks
  // the iPhone for rings, his iPhone signs in again, and Helen's does too.
  await accounts.registerDevice(STEVE, "watch-1", registration("watchos", apns("alert", "cc".repeat(32)), "denied"));
  await accounts.setPreferredFormFactor(STEVE, "phone");
  const steveSid = await accounts.createSession(STEVE, "phone-1", "ios");
  const helenSid = await accounts.createSession(HELEN, "phone-2", "ios");
  const counts = await migrateToV2(docs, { dryRun: false });
  assert.deepEqual([counts.devicesMigrated, counts.sessionsMigrated, counts.sessionsMoved], [4, 1, 1]);

  const watch = (await accounts.devices(STEVE)).find((d) => d.id === "watch-1")!;
  assert.equal("token" in watch.delivery && watch.delivery.token, "cc".repeat(32));
  assert.equal(watch.availability.notifications, "denied");
  assert.equal((await accounts.user(STEVE))?.preferredFormFactor, "phone");
  assert.deepEqual(await accounts.activeSession(STEVE, steveSid, "phone-1"), { sid: steveSid, clientKind: "ios" });
  assert.equal(await accounts.sessionActive(STEVE, "s1", "phone-1"), false);
  // Helen's old sid-keyed session goes, rather than replacing her new one.
  assert.deepEqual((await docs.list(`users/${HELEN}/sessions`)).map((s) => [s.id, s.data.sid]), [["phone-2", helenSid]]);
  assert.equal(await accounts.sessionActive(HELEN, "oldSid99", "phone-2"), false);
  assert.deepEqual((await verifyV2(docs)).problems, []);
});

test("migration: a v1 registration whose token the v2 server has since registered elsewhere isn't revived", async () => {
  const docs = await seeded();
  const accounts = new Accounts(docs);
  // After the deploy, before the second pass: Steve's watch (still a v1 record) is signed in to
  // Helen's account, and registers the same token there.
  await accounts.registerDevice(HELEN, "watch-1", registration("watchos", apns("alert", "bb".repeat(32))));
  await migrateToV2(docs, { dryRun: false });
  // The token belongs to the registration that registered it last, as everywhere else.
  assert.deepEqual((await accounts.devices(STEVE)).map((d) => d.id), ["phone-1"]);
  assert.deepEqual((await accounts.devices(HELEN)).map((d) => d.id), ["phone-2", "watch-1"]);
  assert.deepEqual((await verifyV2(docs)).problems, []);
});

test("migration: the cleanup refuses until everything is v2, then removes exactly the v1 data", async () => {
  const docs = await seeded();
  // Before the pass, verifyV2 has problems: the cleanup writes nothing.
  const untouched = await dump(docs);
  await assert.rejects(cleanupV1(docs, false), (err: unknown) => err instanceof MigrationStopped && err.problems.length === 3);
  assert.deepEqual(await dump(docs), untouched);

  await migrateToV2(docs, { dryRun: false });
  const migrated = await dump(docs);
  const plan = await cleanupV1(docs, true);
  assert.deepEqual(plan, { users: 3, devices: 5, sessions: 2, appleSubs: 3, pointers: 2 });
  assert.deepEqual(await dump(docs), migrated);

  assert.deepEqual(await cleanupV1(docs, false), plan);
  // The v1 fields are gone, and everything else is as the pass left it.
  const cleaned = await dump(docs);
  const v1Fields: Record<string, string[]> = { users: ["appleSub", "ringOn"], devices: ["platform", "pushToken", "pushType", "apnsEnvironment"], sessions: ["platform", "deviceId"] };
  for (const [path, data] of Object.entries(migrated)) {
    if (path.startsWith("appleSubs/") || path === v1Pointer("aa".repeat(32)) || path === v1Pointer("bb".repeat(32))) {
      assert.equal(cleaned[path], undefined, path);
      continue;
    }
    const kind = path.split("/").length === 2 ? path.split("/")[0] : path.split("/")[2];
    const strip = path.startsWith("users/") ? v1Fields[kind] ?? [] : [];
    const expected = Object.fromEntries(Object.entries(data).filter(([k]) => !strip.includes(k)));
    assert.deepEqual(cleaned[path], expected, path);
  }
  assert.deepEqual(Object.keys(cleaned).filter((p) => !(p in migrated)), []);
  // Only the v2 pointers are left.
  assert.deepEqual((await docs.list("pushTokens")).map((p) => `pushTokens/${p.id}`).sort(), [v2Pointer(apns("pushtotalk", "aa".repeat(32))), v2Pointer(apns("alert", "bb".repeat(32)))].sort());
  const { problems, counts } = await verifyV2(docs);
  assert.deepEqual(problems, []);
  assert.deepEqual([counts.v1Records, counts.appleSubs, counts.v1Pointers], [0, 0, 0]);

  // Everything still reads.
  const accounts = new Accounts(docs);
  assert.equal((await accounts.signInWithApple("001.steve.1")).user.id, STEVE);
  assert.equal((await accounts.user(STEVE))?.preferredFormFactor, "watch");
  assert.deepEqual(await devices(accounts, STEVE), [
    ["phone-1", "ios", "apns", "pushtotalk", "aa".repeat(32), 1000],
    ["watch-1", "watchos", "apns", "alert", "bb".repeat(32), 2000],
  ]);
  assert.deepEqual(await devices(accounts, BOT), [
    ["bot-1", "watchos", "test", "connection", null, 4000],
    ["bot-2", "ios", "test", "connection", null, 5000],
  ]);
  assert.deepEqual(await accounts.activeSession(STEVE, "s2", "watch-1"), { sid: "s2", clientKind: "watchos" });
  assert.equal(await accounts.sessionActive(HELEN, "oldSid99", "phone-2"), true);

  // Again: nothing left to remove.
  assert.deepEqual(await cleanupV1(docs, false), { users: 0, devices: 0, sessions: 0, appleSubs: 0, pointers: 0 });
  assert.deepEqual(await dump(docs), cleaned);

  // The pointers the pass made own their tokens: a reinstall's new device ID takes the token.
  await accounts.registerDevice(STEVE, "watch-2", registration("watchos", apns("alert", "bb".repeat(32))));
  assert.deepEqual((await accounts.devices(STEVE)).map((d) => d.id), ["phone-1", "watch-2"]);
});

test("migration: after the cutoff, watch sessions no phone made are retired with their registrations", async () => {
  const docs = await seeded();
  // The Test Bot's session, as tools/test-account.ts made it: a "watch" with no phone.
  await docs.commit([{ set: `users/${BOT}/sessions/bot-1`, data: { sid: "sb", platform: "watch", createdAt: T, refreshedAt: T } }]);
  await migrateToV2(docs, { dryRun: false });
  const cutoff = T.getTime() + DAY;
  const accounts = new Accounts(docs, { now: () => T.getTime() + 2 * DAY });
  // Steve's updated iPhone signs in again and makes a watch's session; a watch simulator signs
  // itself in, but after the cutoff.
  const phoneSid = await accounts.createSession(STEVE, "phone-1", "ios");
  const companion = await accounts.createCompanionSession(STEVE, { deviceId: "phone-1", sid: phoneSid }, "watch-2", "watchos", "r1");
  const late = await accounts.createSession(HELEN, "watch-3", "watchos");

  assert.equal(await retireLegacyWatchSessions(docs, cutoff, true), 1);
  assert.equal(await accounts.sessionActive(STEVE, "s2", "watch-1"), true);
  assert.equal(await retireLegacyWatchSessions(docs, cutoff, false), 1);
  assert.equal(await accounts.sessionActive(STEVE, "s2", "watch-1"), false);
  // Its registration and both its pointers (v2's, and v1's before the cleanup) went with it.
  assert.deepEqual((await accounts.devices(STEVE)).map((d) => d.id), ["phone-1"]);
  assert.deepEqual(await docs.getAll([v2Pointer(apns("alert", "bb".repeat(32))), v1Pointer("bb".repeat(32))]), [undefined, undefined]);
  // The phone's pointers stay; so do the companion session and the session after the cutoff.
  assert.equal((await one(docs, v2Pointer(apns("pushtotalk", "aa".repeat(32)))))?.deviceId, "phone-1");
  assert.equal(await accounts.sessionActive(STEVE, companion.sid, "watch-2"), true);
  assert.equal(await accounts.sessionActive(HELEN, late, "watch-3"), true);
  // The bot keeps its session and its test delivery: it has no phone to ask for another.
  assert.equal(await accounts.sessionActive(BOT, "sb", "bot-1"), true);
  assert.equal((await accounts.devices(BOT)).some((d) => d.id === "bot-1"), true);
  assert.equal(await retireLegacyWatchSessions(docs, cutoff, false), 0);
  assert.equal((await verifyV2(docs)).counts.watchSessionsWithoutParent, 2);
});
