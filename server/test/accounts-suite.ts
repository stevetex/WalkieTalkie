// Account rules, run against MemoryDocs (accounts.test.ts) and the Firestore emulator
// (firestore.test.ts), so both stores behave the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AccountError, Accounts, identityDocPath, tokenPointers, type DeviceRegistration } from "../src/accounts.ts";
import { DEFAULT_CAPABILITIES } from "../src/contract.ts";
import type { Docs } from "../src/docs.ts";

// Docs that run `between` inside the next transaction, after its reads and before it commits.
export function interleaved(docs: Docs): Docs & { between: (() => Promise<void>) | null } {
  const wrapped = {
    between: null as (() => Promise<void>) | null,
    getAll: (paths: string[]) => docs.getAll(paths),
    list: (collection: string) => docs.list(collection),
    query: (collection: string, query: Parameters<Docs["query"]>[1]) => docs.query(collection, query),
    commit: (writes: Parameters<Docs["commit"]>[0]) => docs.commit(writes),
    transaction: <T>(fn: Parameters<Docs["transaction"]>[0]) =>
      docs.transaction(async (get) => {
        const outcome = await fn(get);
        const between = wrapped.between;
        wrapped.between = null;
        await between?.();
        return outcome as { writes: Parameters<Docs["commit"]>[0]; result: T };
      }),
  };
  return wrapped;
}

export function accountsSuite(label: string, makeDocs: () => Docs, skip: string | false = false): void {
  const DAY = 24 * 60 * 60 * 1000;

  async function setup(now = { t: Date.UTC(2026, 8, 27) }) {
    const docs = makeDocs();
    const accounts = new Accounts(docs, { now: () => now.t, invitesPerDay: 3 });
    const alice = (await accounts.signInWithApple("001.alice.1", "Alice Appleseed")).user;
    const bob = (await accounts.signInWithApple("001.bob.1", "Bob")).user;
    return { docs, accounts, alice, bob, now };
  }

  async function befriend(accounts: Accounts, a: string, b: string): Promise<void> {
    const { code } = await accounts.createInvite(a);
    await accounts.acceptInvite(code, b);
  }

  const code = (p: Promise<unknown>) =>
    p.then(
      () => "ok",
      (err) => (err instanceof AccountError ? err.code : Promise.reject(err)),
    );

  // Registrations as the apps send them: notifications allowed, the default capabilities.
  const v2 = (overrides: Partial<DeviceRegistration> & Pick<DeviceRegistration, "clientKind" | "delivery">): DeviceRegistration => ({
    availability: { enabled: true, notifications: "authorized" },
    capabilities: structuredClone(DEFAULT_CAPABILITIES),
    ...overrides,
  });
  // A watch rung by an alert, an iPhone in its PushToTalk channel, and an iPhone rung only while
  // the app is open.
  const watchReg = (token: string) => v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "sandbox" } });
  const phoneReg = (token: string) => v2({ clientKind: "ios", delivery: { provider: "apns", mode: "pushtotalk", token, environment: "sandbox" } });
  const inAppPhone = () => v2({ clientKind: "ios", delivery: { provider: "relay", mode: "foreground" } });

  test(`${label}: signing in again finds the same account, and only the first name counts`, { skip }, async () => {
    const { accounts, alice } = await setup();
    assert.match(alice.id, /^u_[\w-]{16}$/);
    const again = await accounts.signInWithApple("001.alice.1", "Someone Else");
    assert.equal(again.created, false);
    assert.equal(again.user.id, alice.id);
    assert.equal(again.user.name, "Alice Appleseed");
    assert.equal((await accounts.signInWithApple("001.nameless.1")).user.name, "Friend");
    assert.equal((await accounts.rename(alice.id, "  Al\u0000  ice\n ")).name, "Al ice");
    assert.equal(await code(accounts.rename(alice.id, " ")), "bad-name");
  });

  test(`${label}: concurrent first sign-ins make one account`, { skip }, async () => {
    const { accounts } = await setup();
    const results = await Promise.all([1, 2, 3].map(() => accounts.signInWithApple("001.carol.1", "Carol")));
    assert.equal(new Set(results.map((r) => r.user.id)).size, 1);
  });

  test(`${label}: an invite makes two people friends, once`, { skip }, async () => {
    const { accounts, alice, bob, now } = await setup();
    const { code: inviteCode, expiresAt } = await accounts.createInvite(alice.id);
    assert.match(inviteCode, /^[\w-]{22}$/);
    assert.equal(expiresAt, now.t + 7 * DAY);
    assert.equal(await code(accounts.invite(inviteCode, alice.id)), "own-invite");
    const info = await accounts.invite(inviteCode, bob.id);
    assert.deepEqual(info.from, { id: alice.id, name: "Alice Appleseed" });
    assert.equal(info.alreadyFriends, false);

    const friend = await accounts.acceptInvite(inviteCode, bob.id);
    assert.equal(friend.id, alice.id);
    assert.deepEqual((await accounts.friends(alice.id)).map((f) => f.name), ["Bob"]);
    assert.deepEqual((await accounts.friends(bob.id)).map((f) => f.name), ["Alice Appleseed"]);
    // Used up.
    assert.equal(await code(accounts.acceptInvite(inviteCode, bob.id)), "invite-not-found");
    const dave = (await accounts.signInWithApple("001.dave.1", "Dave")).user;
    assert.equal(await code(accounts.acceptInvite(inviteCode, dave.id)), "invite-not-found");
  });

  test(`${label}: two people racing for one invite: only one gets it`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    const carol = (await accounts.signInWithApple("001.carol.1", "Carol")).user;
    const { code: inviteCode } = await accounts.createInvite(alice.id);
    const results = await Promise.all([bob.id, carol.id].map((id) => code(accounts.acceptInvite(inviteCode, id))));
    assert.deepEqual(results.sort(), ["invite-not-found", "ok"]);
    assert.equal((await accounts.friends(alice.id)).length, 1);
  });

  test(`${label}: invites expire, can be cancelled, and are limited per day`, { skip }, async () => {
    const { accounts, alice, bob, now } = await setup();
    const expiring = await accounts.createInvite(alice.id);
    const cancelled = await accounts.createInvite(alice.id);
    await accounts.createInvite(alice.id);
    assert.equal(await code(accounts.createInvite(alice.id)), "too-many-invites");
    assert.equal(await code(accounts.cancelInvite(cancelled.code, bob.id)), "invite-not-found");
    await accounts.cancelInvite(cancelled.code, alice.id);
    assert.equal(await code(accounts.invite(cancelled.code, bob.id)), "invite-not-found");
    now.t += DAY + 1;
    assert.equal(await code(accounts.createInvite(alice.id)), "ok");
    now.t += 6 * DAY;
    assert.equal(await code(accounts.acceptInvite(expiring.code, bob.id)), "invite-not-found");
    assert.equal(await code(accounts.invite("nope", bob.id)), "invite-not-found");
  });

  test(`${label}: rings are allowed between friends only, and a block ends the friendship both ways`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    assert.deepEqual(await accounts.ringLookup(alice.id, bob.id), { allowed: false });
    await befriend(accounts, alice.id, bob.id);
    await accounts.registerDevice(bob.id, "watch-1", watchReg("ab".repeat(32)));
    const lookup = await accounts.ringLookup(alice.id, bob.id);
    assert.equal(lookup.allowed, true);
    assert.ok(lookup.allowed);
    assert.equal(lookup.fromName, "Alice Appleseed");
    assert.deepEqual(lookup.devices.map((d) => [d.id, d.clientKind, d.formFactor]), [["watch-1", "watchos", "watch"]]);
    assert.equal((await accounts.ringLookup(bob.id, alice.id)).allowed, true);

    // Bob's iPhone in its PushToTalk channel, and his choice of which device rings.
    await accounts.registerDevice(bob.id, "phone-1", phoneReg("cd".repeat(32)));
    assert.equal((await accounts.setPreferredFormFactor(bob.id, "phone")).preferredFormFactor, "phone");
    const chosen = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(chosen.allowed);
    assert.equal(chosen.preferredFormFactor, "phone");
    assert.deepEqual(chosen.devices.map((d) => [d.id, d.clientKind, d.delivery.mode, d.receiveMode]).sort(), [["phone-1", "ios", "pushtotalk", "automatic"], ["watch-1", "watchos", "alert", "tap"]]);
    assert.equal((await accounts.setPreferredFormFactor(bob.id, null)).preferredFormFactor, undefined);
    const byDefault = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(byDefault.allowed);
    assert.equal(byDefault.preferredFormFactor, undefined);
    assert.equal(byDefault.rollOver, undefined);

    // His rollover: an unanswered watch rings the iPhone. Off removes it.
    assert.equal((await accounts.setRollOver(bob.id, true)).rollOver, true);
    const rolling = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(rolling.allowed);
    assert.equal(rolling.rollOver, true);
    assert.equal((await accounts.setRollOver(bob.id, false)).rollOver, undefined);

    await accounts.block(bob.id, alice.id);
    assert.equal((await accounts.ringLookup(alice.id, bob.id)).allowed, false);
    assert.equal((await accounts.ringLookup(bob.id, alice.id)).allowed, false);
    assert.deepEqual(await accounts.friends(alice.id), []);
    assert.deepEqual((await accounts.blocks(bob.id)).map((b) => [b.id, b.name]), [[alice.id, "Alice Appleseed"]]);

    // Blocked either way: the other's invites look like they don't exist.
    const fromAlice = await accounts.createInvite(alice.id);
    assert.equal(await code(accounts.acceptInvite(fromAlice.code, bob.id)), "invite-not-found");
    const fromBob = await accounts.createInvite(bob.id);
    assert.equal(await code(accounts.invite(fromBob.code, alice.id)), "invite-not-found");

    await accounts.unblock(bob.id, alice.id);
    await accounts.acceptInvite(fromBob.code, alice.id);
    assert.equal((await accounts.ringLookup(alice.id, bob.id)).allowed, true);
    assert.equal(await code(accounts.block(bob.id, bob.id)), "cannot-block-self");
    assert.equal(await code(accounts.block(bob.id, "u_nobodyatall1234")), "no-account");
  });

  test(`${label}: removing a friend removes both sides`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    await befriend(accounts, alice.id, bob.id);
    await accounts.removeFriend(bob.id, alice.id);
    assert.deepEqual(await accounts.friends(alice.id), []);
    assert.deepEqual(await accounts.friends(bob.id), []);
  });

  test(`${label}: sessions are one per device and end on sign-out`, { skip }, async () => {
    const { docs, accounts, alice } = await setup();
    const first = await accounts.createSession(alice.id, "phone-1", "ios");
    const second = await accounts.createSession(alice.id, "phone-1", "ios");
    const watch = await accounts.createSession(alice.id, "watch-1", "watchos");
    assert.equal(await accounts.touchSession(alice.id, first, "phone-1"), false);
    assert.equal(await accounts.touchSession(alice.id, second, "phone-1"), true);
    // A sid only works with its own device.
    assert.equal(await accounts.touchSession(alice.id, second, "watch-1"), false);
    await accounts.registerDevice(alice.id, "watch-1", watchReg("t"));
    // Signing out with a replaced token ends nothing.
    const newer = await accounts.createSession(alice.id, "watch-1", "watchos");
    await accounts.endSession(alice.id, watch, "watch-1");
    assert.equal(await accounts.touchSession(alice.id, newer, "watch-1"), true);
    assert.equal((await accounts.devices(alice.id)).length, 1);
    await accounts.endSession(alice.id, newer, "watch-1");
    assert.equal(await accounts.touchSession(alice.id, newer, "watch-1"), false);
    assert.deepEqual(await accounts.devices(alice.id), []);
    assert.equal(await accounts.touchSession("u_nobodyatall1234", second, "phone-1"), false);
    assert.deepEqual((await docs.list(`users/${alice.id}/sessions`)).map((s) => s.id), ["phone-1"]);
  });

  test(`${label}: concurrent sessions for one device leave one`, { skip }, async () => {
    const { docs, accounts, alice } = await setup();
    const sids = await Promise.all([1, 2, 3, 4].map(() => accounts.createSession(alice.id, "watch-1", "watchos")));
    assert.equal((await docs.list(`users/${alice.id}/sessions`)).length, 1);
    const valid = await Promise.all(sids.map((sid) => accounts.touchSession(alice.id, sid, "watch-1")));
    assert.equal(valid.filter(Boolean).length, 1);
  });

  test(`${label}: a session without a client kind this server knows, or keyed by its sid, has ended`, { skip }, async () => {
    const { docs, accounts, alice } = await setup();
    const created = new Date(Date.UTC(2026, 8, 27));
    await docs.commit([
      // As v1 wrote them (migrate-v2.ts converts these): a platform and no client kind, and one
      // still keyed by its sid.
      { set: `users/${alice.id}/sessions/watch-1`, data: { sid: "oldSid123", platform: "watch", createdAt: created, refreshedAt: created } },
      { set: `users/${alice.id}/sessions/oldSid456`, data: { deviceId: "phone-2", platform: "iphone", createdAt: created, refreshedAt: created } },
      // A kind from a later service.
      { set: `users/${alice.id}/sessions/glasses-1`, data: { sid: "newSid789", clientKind: "visionos", createdAt: created, refreshedAt: created, schemaVersion: 3 } },
    ]);
    assert.equal(await accounts.sessionActive(alice.id, "oldSid123", "watch-1"), false);
    assert.equal(await accounts.touchSession(alice.id, "oldSid123", "watch-1"), false);
    assert.equal(await accounts.sessionActive(alice.id, "oldSid456", "phone-2"), false);
    assert.equal(await accounts.touchSession(alice.id, "oldSid456", "phone-2"), false);
    assert.equal(await accounts.activeSession(alice.id, "newSid789", "glasses-1"), null);
    // Signing in again on the device replaces it.
    const sid = await accounts.createSession(alice.id, "watch-1", "watchos");
    assert.deepEqual(await accounts.activeSession(alice.id, sid, "watch-1"), { sid, clientKind: "watchos" });
    // A phone session without a kind can't make a watch's.
    assert.equal(await code(accounts.createCompanionSession(alice.id, { deviceId: "phone-2", sid: "oldSid456" }, "watch-2", "watchos", "r")), "session-ended");
  });

  test(`${label}: reports are kept with IDs only`, { skip }, async () => {
    const { docs, accounts, alice, bob } = await setup();
    const id = await accounts.report(alice.id, { userId: bob.id, reason: "harassment", note: "x".repeat(2000), conversationId: "c-1" });
    const [report] = await docs.getAll([`reports/${id}`]);
    assert.equal(report?.reporter, alice.id);
    assert.equal(report?.reported, bob.id);
    assert.equal(report?.status, "open");
    assert.equal(String(report?.note).length, 1000);
    assert.equal(await code(accounts.report(alice.id, { userId: bob.id, reason: "because" })), "bad-reason");
  });

  test(`${label}: a profile photo is seen by its owner and friends only, and can be removed`, { skip }, async () => {
    const { accounts, alice, bob, now } = await setup();
    const carol = (await accounts.signInWithApple("001.carol.1", "Carol")).user;
    await befriend(accounts, alice.id, bob.id);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

    assert.equal(await code(accounts.photo(bob.id, alice.id)), "no-photo");
    const version = await accounts.setPhoto(alice.id, jpeg);
    assert.equal(version, now.t);
    assert.equal((await accounts.user(alice.id))?.photoVersion, version);
    assert.deepEqual((await accounts.friends(bob.id)).map((f) => f.photoVersion), [version]);
    assert.deepEqual((await accounts.photo(alice.id, alice.id)).jpeg, jpeg);
    assert.deepEqual((await accounts.photo(bob.id, alice.id)).jpeg, jpeg);
    assert.equal(await code(accounts.photo(carol.id, alice.id)), "no-photo");

    assert.equal(await code(accounts.setPhoto(alice.id, Buffer.from("not a jpeg"))), "not-a-jpeg");
    assert.equal(await code(accounts.setPhoto(alice.id, Buffer.alloc(100 * 1024 + 1, 0xff))), "photo-too-large");

    // A block ends the friendship, and with it the photo.
    await accounts.block(bob.id, alice.id);
    assert.equal(await code(accounts.photo(bob.id, alice.id)), "no-photo");

    await accounts.removePhoto(alice.id);
    assert.equal((await accounts.user(alice.id))?.photoVersion, undefined);
    assert.equal(await code(accounts.photo(alice.id, alice.id)), "no-photo");
  });

  test(`${label}: a mascot replaces the photo, and a new photo replaces the mascot`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    await befriend(accounts, alice.id, bob.id);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]);
    await accounts.setPhoto(alice.id, jpeg);

    const withMascot = await accounts.setAvatar(alice.id, "bow-lashes-honey");
    assert.equal(withMascot.avatar, "bow-lashes-honey");
    assert.equal(withMascot.photoVersion, undefined);
    assert.equal(await code(accounts.photo(bob.id, alice.id)), "no-photo");
    assert.deepEqual((await accounts.friends(bob.id)).map((f) => [f.avatar, f.photoVersion]), [["bow-lashes-honey", undefined]]);

    const version = await accounts.setPhoto(alice.id, jpeg);
    assert.deepEqual((await accounts.friends(bob.id)).map((f) => [f.avatar, f.photoVersion]), [[undefined, version]]);

    await accounts.setAvatar(alice.id, "honey");
    assert.equal((await accounts.setAvatar(alice.id, null)).avatar, undefined);
    assert.equal(await code(accounts.setAvatar(alice.id, "../photos")), "bad-avatar");
    assert.equal(await code(accounts.setAvatar(alice.id, "Honey")), "bad-avatar");
  });

  test(`${label}: favorites and the last message are one-sided`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    await accounts.recordMessage(bob.id, alice.id, 1_000); // not friends yet: nothing
    await befriend(accounts, alice.id, bob.id);
    await accounts.recordMessage(bob.id, alice.id, 2_000);
    await accounts.setFavorite(alice.id, bob.id, true);
    assert.deepEqual((await accounts.friends(alice.id)).map((f) => [f.favorite, f.lastMessageAt]), [[true, 2_000]]);
    assert.deepEqual((await accounts.friends(bob.id)).map((f) => [f.favorite, f.lastMessageAt]), [[undefined, undefined]]);
    await accounts.setFavorite(alice.id, bob.id, false);
    assert.equal((await accounts.friends(alice.id))[0].favorite, undefined);
    await accounts.removeFriend(alice.id, bob.id);
    assert.equal(await code(accounts.setFavorite(alice.id, bob.id, true)), "not-friends");
    await accounts.recordMessage(bob.id, alice.id, 3_000);
    assert.deepEqual(await accounts.friends(alice.id), []);
  });

  test(`${label}: with no choice made a watch takes the rings, and a choice stays`, { skip }, async () => {
    const { accounts, alice } = await setup();
    // One device, or more of one kind: nothing to choose.
    await accounts.registerDevice(alice.id, "phone-1", inAppPhone());
    await accounts.registerDevice(alice.id, "phone-1", phoneReg("ptt"));
    assert.equal((await accounts.user(alice.id))?.preferredFormFactor, undefined);
    assert.deepEqual(await accounts.formFactors(alice.id), ["phone"]);

    // A watch arrives: nothing is pinned, so the watch rings.
    await accounts.registerDevice(alice.id, "watch-1", watchReg("t"));
    assert.equal((await accounts.user(alice.id))?.preferredFormFactor, undefined);
    assert.deepEqual(await accounts.formFactors(alice.id), ["phone", "watch"]);

    // A choice the user made stays, whatever registers later.
    await accounts.setPreferredFormFactor(alice.id, "phone");
    await accounts.registerDevice(alice.id, "watch-2", watchReg("t2"));
    assert.equal((await accounts.user(alice.id))?.preferredFormFactor, "phone");
    await accounts.setPreferredFormFactor(alice.id, "watch");
    await accounts.registerDevice(alice.id, "phone-2", inAppPhone());
    assert.equal((await accounts.user(alice.id))?.preferredFormFactor, "watch");
  });

  test(`${label}: deleting an account removes it everywhere but reports`, { skip }, async () => {
    const { docs, accounts, alice, bob } = await setup();
    await befriend(accounts, alice.id, bob.id);
    await accounts.setPhoto(alice.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]));
    const carol = (await accounts.signInWithApple("001.carol.1", "Carol")).user;
    await accounts.block(alice.id, carol.id);
    await accounts.block(carol.id, alice.id);
    await accounts.createSession(alice.id, "phone-1", "ios");
    await accounts.registerDevice(alice.id, "watch-1", watchReg("t"));
    const pending = await accounts.createInvite(alice.id);
    const reportId = await accounts.report(bob.id, { userId: alice.id, reason: "spam" });

    assert.deepEqual(await accounts.deleteAccount(alice.id), { identity: { provider: "apple", subject: "001.alice.1" } });
    assert.equal(await accounts.user(alice.id), undefined);
    assert.deepEqual(await accounts.friends(bob.id), []);
    assert.equal(await code(accounts.invite(pending.code, bob.id)), "invite-not-found");
    // Carol's block of Alice stays, but no longer names her.
    assert.deepEqual((await accounts.blocks(carol.id)).map((b) => b.name), [null]);
    for (const sub of ["friends", "blocks", "devices", "sessions"]) assert.deepEqual(await docs.list(`users/${alice.id}/${sub}`), []);
    assert.deepEqual(await docs.getAll([identityDocPath("apple", "001.alice.1"), `photos/${alice.id}`]), [undefined, undefined]);
    assert.deepEqual(await docs.list("pushTokens"), []);
    assert.notEqual((await docs.getAll([`reports/${reportId}`]))[0], undefined);
    // The same Apple ID starts over with a new account.
    const again = await accounts.signInWithApple("001.alice.1", "Alice");
    assert.equal(again.created, true);
    assert.notEqual(again.user.id, alice.id);
    assert.equal(await code(accounts.deleteAccount(alice.id)), "no-account");
  });

  test(`${label}: a session ends when it's signed out, replaced or its account deleted`, { skip }, async () => {
    const { accounts, alice } = await setup();
    const sid = await accounts.createSession(alice.id, "phone", "ios");
    assert.equal(await accounts.sessionActive(alice.id, sid, "phone"), true);
    assert.equal(await accounts.sessionActive(alice.id, sid, "watch"), false);
    assert.equal(await accounts.sessionActive(alice.id, "other", "phone"), false);
    await accounts.endSession(alice.id, sid, "phone");
    assert.equal(await accounts.sessionActive(alice.id, sid, "phone"), false);

    const first = await accounts.createSession(alice.id, "phone", "ios");
    const second = await accounts.createSession(alice.id, "phone", "ios");
    assert.equal(await accounts.sessionActive(alice.id, first, "phone"), false);
    assert.equal(await accounts.sessionActive(alice.id, second, "phone"), true);
    await accounts.deleteAccount(alice.id);
    assert.equal(await accounts.sessionActive(alice.id, second, "phone"), false);
  });

  test(`${label}: two can talk while friends, and not after a block, an unfriending or a deletion`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    const carol = (await accounts.signInWithApple("001.carol.1", "Carol")).user;
    assert.equal(await accounts.canTalk(alice.id, bob.id), false);
    await befriend(accounts, alice.id, bob.id);
    await befriend(accounts, alice.id, carol.id);
    assert.equal(await accounts.canTalk(alice.id, bob.id), true);
    assert.equal(await accounts.canTalk(bob.id, alice.id), true);
    await accounts.block(bob.id, alice.id);
    assert.equal(await accounts.canTalk(alice.id, bob.id), false);
    assert.equal(await accounts.canTalk(bob.id, alice.id), false);
    assert.equal(await accounts.canTalk(carol.id, alice.id), true);
    await accounts.removeFriend(carol.id, alice.id);
    assert.equal(await accounts.canTalk(alice.id, carol.id), false);
    await befriend(accounts, alice.id, carol.id);
    await accounts.deleteAccount(carol.id);
    assert.equal(await accounts.canTalk(alice.id, carol.id), false);
  });

  test(`${label}: an unregistered push token is removed, unless the device has a new one`, { skip }, async () => {
    const { accounts, alice } = await setup();
    await accounts.registerDevice(alice.id, "watch", watchReg("old"));
    assert.equal(await accounts.removeDevice(alice.id, "watch", "stale"), false);
    assert.equal((await accounts.devices(alice.id)).length, 1);
    assert.equal(await accounts.removeDevice(alice.id, "watch", "old"), true);
    assert.deepEqual(await accounts.devices(alice.id), []);
    assert.equal(await accounts.removeDevice(alice.id, "watch", "old"), false);
  });

  test(`${label}: a push token rings only the account and device that registered it last`, { skip }, async () => {
    const { docs, accounts, alice, bob } = await setup();
    const watchToken = "ab".repeat(32);
    const tokens = async (userId: string) => (await accounts.devices(userId)).map((d) => `${d.id}=${"token" in d.delivery ? d.delivery.token : `${d.delivery.provider}:`}`);
    // Alice's watch signs in as Bob without signing out: it no longer rings for Alice.
    await accounts.registerDevice(alice.id, "watch-1", watchReg(watchToken));
    await accounts.registerDevice(bob.id, "watch-1", watchReg(watchToken));
    assert.deepEqual(await tokens(alice.id), []);
    assert.deepEqual(await tokens(bob.id), [`watch-1=${watchToken}`]);
    // A reinstall gives Bob's watch a new device ID with the same token: the old ID goes.
    await accounts.registerDevice(bob.id, "watch-2", watchReg(watchToken));
    assert.deepEqual(await tokens(bob.id), [`watch-2=${watchToken}`]);
    // A new token frees the old one, so registering the old token elsewhere removes nothing.
    await accounts.registerDevice(bob.id, "watch-2", watchReg("cd".repeat(32)));
    await accounts.registerDevice(alice.id, "watch-9", watchReg(watchToken));
    assert.deepEqual(await tokens(bob.id), [`watch-2=${"cd".repeat(32)}`]);
    // One pointer per token, keyed by its scope and token: none keyed by the token alone.
    assert.deepEqual((await docs.list("pushTokens")).map((p) => `pushTokens/${p.id}`).sort(), [
      ...tokenPointers(watchReg(watchToken).delivery),
      ...tokenPointers(watchReg("cd".repeat(32)).delivery),
    ].sort());
    assert.deepEqual(await docs.getAll([`pushTokens/${createHash("sha256").update(watchToken).digest("base64url")}`]), [undefined]);
    // iPhones rung only in the app carry no token, so one is never taken over.
    await accounts.registerDevice(alice.id, "phone-1", inAppPhone());
    await accounts.registerDevice(bob.id, "phone-2", inAppPhone());
    assert.ok((await tokens(alice.id)).includes("phone-1=relay:"));
    // Signing out, a token APNs rejects, and deleting the account leave no pointers behind.
    await accounts.removeDevice(bob.id, "watch-2", "cd".repeat(32));
    const sid = await accounts.createSession(alice.id, "watch-9", "watchos");
    await accounts.endSession(alice.id, sid, "watch-9");
    await accounts.registerDevice(bob.id, "watch-3", watchReg("ef".repeat(32)));
    await accounts.deleteAccount(bob.id);
    assert.deepEqual(await docs.list("pushTokens"), []);
  });

  test(`${label}: an invite accepted while a block lands never leaves them friends`, { skip }, async () => {
    const docs = interleaved(makeDocs());
    const accounts = new Accounts(docs, { invitesPerDay: 3 });
    const alice = (await accounts.signInWithApple("001.alice.1", "Alice")).user;
    const bob = (await accounts.signInWithApple("001.bob.1", "Bob")).user;
    const { code: inviteCode } = await accounts.createInvite(alice.id);
    // Started between the acceptance's checks and its commit. (Not awaited there: on
    // Firestore the block waits for the transaction's locks.)
    let blocking: Promise<void> = Promise.resolve();
    docs.between = async () => {
      blocking = accounts.block(alice.id, bob.id);
    };
    await code(accounts.acceptInvite(inviteCode, bob.id));
    await blocking;
    assert.deepEqual((await accounts.blocks(alice.id)).map((b) => b.id), [bob.id]);
    assert.deepEqual(await accounts.friends(alice.id), []);
    assert.deepEqual(await accounts.friends(bob.id), []);
    assert.deepEqual(await accounts.ringLookup(bob.id, alice.id), { allowed: false });
  });

  // ---- Phase 0: the v2 contract (contracts/README.md) ----

  test(`${label}: Apple and Google identities are separate accounts, even with the same subject`, { skip }, async () => {
    const { accounts, alice } = await setup();
    assert.equal(alice.signInProvider, "apple");
    const google = await accounts.signIn("google", "001.alice.1", "Alice on Android");
    assert.equal(google.created, true);
    assert.notEqual(google.user.id, alice.id);
    assert.equal(google.user.signInProvider, "google");
    assert.equal((await accounts.signIn("google", "001.alice.1")).user.id, google.user.id);
    assert.equal((await accounts.signIn("apple", "001.alice.1")).user.id, alice.id);
    assert.deepEqual(await accounts.identity(google.user.id), { provider: "google", subject: "001.alice.1" });
    // Concurrent first sign-ins make one account.
    const results = await Promise.all([1, 2, 3].map(() => accounts.signIn("google", "g.dana", "Dana")));
    assert.equal(new Set(results.map((r) => r.user.id)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
  });

  test(`${label}: sign-in finds an account through its identity index only, and writes nothing else`, { skip }, async () => {
    const { docs, accounts } = await setup();
    // An account the migration converted: the same ID, found through its identity index.
    await docs.commit([
      { set: identityDocPath("apple", "001.olde.1"), data: { userId: "u_oldAccount12345", provider: "apple", createdAt: new Date(1) } },
      { set: "users/u_oldAccount12345", data: { name: "Olde", identity: { provider: "apple", subject: "001.olde.1" }, preferredFormFactor: "phone", createdAt: new Date(1), schemaVersion: 2 } },
    ]);
    const signedIn = await accounts.signIn("apple", "001.olde.1", "New Name");
    assert.equal(signedIn.created, false);
    assert.equal(signedIn.user.id, "u_oldAccount12345");
    assert.equal(signedIn.user.name, "Olde");
    assert.equal(signedIn.user.preferredFormFactor, "phone");
    // A v1 Apple mapping alone finds nothing: that Apple ID gets a new account.
    await docs.commit([{ set: "appleSubs/001.stray.1", data: { userId: "u_oldAccount12345" } }]);
    const stray = await accounts.signIn("apple", "001.stray.1");
    assert.equal(stray.created, true);
    assert.notEqual(stray.user.id, "u_oldAccount12345");
    // A new account has its identity index, and no v1 mapping or fields.
    const fresh = (await accounts.signIn("apple", "001.fresh.1")).user;
    const [index, legacy, user] = await docs.getAll([identityDocPath("apple", "001.fresh.1"), "appleSubs/001.fresh.1", `users/${fresh.id}`]);
    assert.equal(index?.userId, fresh.id);
    assert.equal(legacy, undefined);
    assert.deepEqual([user?.appleSub, user?.ringOn, user?.schemaVersion], [undefined, undefined, 2]);
  });

  test(`${label}: a phone makes its watch's session, idempotently, and only for its own kind of watch`, { skip }, async () => {
    const { accounts, alice } = await setup();
    const phoneSid = await accounts.createSession(alice.id, "phone-1", "ios");
    const parent = { deviceId: "phone-1", sid: phoneSid };
    const first = await accounts.createCompanionSession(alice.id, parent, "watch-1", "watchos", "req-1");
    assert.equal(first.clientKind, "watchos");
    assert.equal((await accounts.createCompanionSession(alice.id, parent, "watch-1", "watchos", "req-1")).sid, first.sid);
    const second = await accounts.createCompanionSession(alice.id, parent, "watch-1", "watchos", "req-2");
    assert.notEqual(second.sid, first.sid);
    assert.equal(await accounts.sessionActive(alice.id, first.sid, "watch-1"), false);
    assert.deepEqual(await accounts.activeSession(alice.id, second.sid, "watch-1"), { sid: second.sid, clientKind: "watchos", parentDeviceId: "phone-1" });
    assert.equal(await code(accounts.createCompanionSession(alice.id, parent, "wear-1", "wearos", "r")), "unsupported-client-kind");
    assert.equal(await code(accounts.createCompanionSession(alice.id, parent, "phone-9", "ios", "r")), "unsupported-client-kind");
    // A watch can't make sessions.
    assert.equal(await code(accounts.createCompanionSession(alice.id, { deviceId: "watch-1", sid: second.sid }, "watch-2", "watchos", "r")), "unsupported-client-kind");
    // Nor can a phone take over another phone's device ID.
    await accounts.createSession(alice.id, "phone-2", "ios");
    assert.equal(await code(accounts.createCompanionSession(alice.id, parent, "phone-2", "watchos", "r")), "device-conflict");
    // A replaced phone session can't make one.
    assert.equal(await code(accounts.createCompanionSession(alice.id, { deviceId: "phone-1", sid: "old" }, "watch-3", "watchos", "r")), "session-ended");
  });

  test(`${label}: signing out on the phone, or signing in there again, ends its watch's session and registration`, { skip }, async () => {
    const { docs, accounts, alice } = await setup();
    const phoneSid = await accounts.createSession(alice.id, "phone-1", "ios");
    const watch = await accounts.createCompanionSession(alice.id, { deviceId: "phone-1", sid: phoneSid }, "watch-1", "watchos", "a");
    await accounts.registerDevice(alice.id, "watch-1", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token: "ab".repeat(32), environment: "sandbox" } }));
    // Another phone's watch is untouched.
    const otherSid = await accounts.createSession(alice.id, "phone-2", "ios");
    const otherWatch = await accounts.createCompanionSession(alice.id, { deviceId: "phone-2", sid: otherSid }, "watch-2", "watchos", "b");
    await accounts.endSession(alice.id, phoneSid, "phone-1");
    assert.equal(await accounts.sessionActive(alice.id, watch.sid, "watch-1"), false);
    assert.deepEqual((await accounts.devices(alice.id)).map((d) => d.id), []);
    assert.equal(await accounts.sessionActive(alice.id, otherWatch.sid, "watch-2"), true);
    // The watch's push token pointers went with it.
    assert.deepEqual(await docs.list("pushTokens"), []);
    // A new sign-in on phone-2 is a new generation: its old watch session ends too.
    await accounts.createSession(alice.id, "phone-2", "ios");
    assert.equal(await accounts.sessionActive(alice.id, otherWatch.sid, "watch-2"), false);
  });

  test(`${label}: a watch session being made while its phone signs out doesn't survive`, { skip }, async () => {
    const docs = interleaved(makeDocs());
    const accounts = new Accounts(docs);
    const alice = (await accounts.signIn("apple", "001.alice.1", "Alice")).user;
    const phoneSid = await accounts.createSession(alice.id, "phone-1", "ios");
    // The phone signs out between the companion's read of its session and the companion's
    // commit. (Not awaited there: on Firestore the sign-out waits for the transaction's locks.)
    let ending: Promise<void> = Promise.resolve();
    docs.between = async () => {
      ending = accounts.endSession(alice.id, phoneSid, "phone-1");
    };
    const made = await accounts.createCompanionSession(alice.id, { deviceId: "phone-1", sid: phoneSid }, "watch-1", "watchos", "a").catch(() => null);
    await ending;
    if (made) assert.equal(await accounts.sessionActive(alice.id, made.sid, "watch-1"), false);
    assert.deepEqual(await docs.list(`users/${alice.id}/sessions`), []);
  });

  test(`${label}: v2 registrations keep their kind, delivery, capabilities and use order`, { skip }, async () => {
    const { accounts, alice, bob, now } = await setup();
    await befriend(accounts, alice.id, bob.id);
    await accounts.createSession(bob.id, "watch-1", "watchos");
    await accounts.createSession(bob.id, "phone-1", "ios");
    const registered = await accounts.registerDevice(bob.id, "watch-1", v2({
      clientKind: "watchos",
      delivery: { provider: "apns", mode: "alert", token: "aa".repeat(32), environment: "production" },
      availability: { enabled: true, notifications: "denied" },
      capabilities: { relayProtocols: [2], audioFormats: [1], decode: ["opus16k", "pcm16le16k"], encode: ["pcm16le16k"], features: ["x"] },
      build: "170",
    }));
    assert.equal(registered.formFactor, "watch");
    assert.equal(registered.receiveMode, "tap");
    assert.equal(registered.lastActiveAt, now.t);
    // A token refresh later doesn't move it in the use order; using it does.
    now.t += 60_000;
    await accounts.registerDevice(bob.id, "watch-1", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token: "bb".repeat(32), environment: "production" } }));
    let [watch] = await accounts.devices(bob.id);
    assert.equal(watch.lastActiveAt, now.t - 60_000);
    assert.equal(watch.availability.notifications, "authorized");
    await accounts.markActive(bob.id, "watch-1", now.t);
    [watch] = await accounts.devices(bob.id);
    assert.equal(watch.lastActiveAt, now.t);
    // A phone in PushToTalk plays at once; one without a session never rings.
    await accounts.registerDevice(bob.id, "phone-1", v2({ clientKind: "ios", delivery: { provider: "apns", mode: "pushtotalk", token: "cc".repeat(32), environment: "production" } }));
    await accounts.registerDevice(bob.id, "phone-9", v2({ clientKind: "ios", delivery: { provider: "relay", mode: "foreground" } }));
    const lookup = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(lookup.allowed);
    assert.deepEqual(lookup.devices.map((d) => [d.id, d.receiveMode, d.hasSession]), [["phone-1", "automatic", true], ["phone-9", "tap", false], ["watch-1", "tap", true]]);
  });

  test(`${label}: a push token is unique within its provider and scope, not by its text alone`, { skip }, async () => {
    const { accounts, alice, bob } = await setup();
    const token = "dd".repeat(32);
    await accounts.registerDevice(alice.id, "watch-1", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "sandbox" } }));
    // The same text as another environment's token is a different registration.
    await accounts.registerDevice(bob.id, "watch-1", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "production" } }));
    assert.equal((await accounts.devices(alice.id)).length, 1);
    // The same scope takes it over.
    await accounts.registerDevice(bob.id, "watch-2", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "sandbox" } }));
    assert.equal((await accounts.devices(alice.id)).length, 0);
    // A provider's late rejection of an old token doesn't remove a newer one.
    await accounts.registerDevice(bob.id, "watch-2", v2({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token: "ee".repeat(32), environment: "sandbox" } }));
    assert.equal(await accounts.removeDevice(bob.id, "watch-2", token), false);
    assert.equal(await accounts.removeDevice(bob.id, "watch-2", "ee".repeat(32)), true);
  });

  test(`${label}: registrations without a client kind and delivery this server knows aren't read`, { skip }, async () => {
    const { docs, accounts, alice, bob } = await setup();
    await befriend(accounts, alice.id, bob.id);
    await accounts.registerDevice(alice.id, "phone-3", inAppPhone());
    await docs.commit([
      // v1's iPhone in its PushToTalk channel, and its in-app registration (migrate-v2.ts
      // converts these).
      { set: `users/${alice.id}/devices/phone-1`, data: { platform: "iphone", pushToken: "ff".repeat(32), pushType: "pushtotalk", apnsEnvironment: "production", updatedAt: 5 } },
      { set: `users/${alice.id}/devices/phone-2`, data: { platform: "iphone", pushToken: "app:", pushType: "alert", apnsEnvironment: "sandbox", updatedAt: 6 } },
      // A later service's device kind and delivery: this server can't ring them.
      { set: `users/${alice.id}/devices/glasses-1`, data: { clientKind: "visionos", formFactor: "glasses", delivery: { provider: "apns", mode: "alert", token: "x" }, schemaVersion: 3 } },
      { set: `users/${alice.id}/devices/watch-1`, data: { clientKind: "watchos", delivery: { provider: "carrier-pigeon", mode: "coo" }, schemaVersion: 3 } },
    ]);
    assert.deepEqual((await accounts.devices(alice.id)).map((d) => [d.id, d.clientKind, d.delivery.provider, d.delivery.mode]), [["phone-3", "ios", "relay", "foreground"]]);
    assert.deepEqual(await accounts.formFactors(alice.id), ["phone"]);
    const lookup = await accounts.ringLookup(bob.id, alice.id);
    assert.ok(lookup.allowed);
    assert.deepEqual(lookup.devices.map((d) => d.id), ["phone-3"]);
  });
}
