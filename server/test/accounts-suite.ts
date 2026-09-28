// Account rules, run against MemoryDocs (accounts.test.ts) and the Firestore emulator
// (firestore.test.ts), so both stores behave the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountError, Accounts } from "../src/accounts.ts";
import type { Docs } from "../src/docs.ts";

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
    await accounts.registerDevice(bob.id, "watch-1", { platform: "watch", pushToken: "ab".repeat(32), apnsEnvironment: "sandbox" });
    const lookup = await accounts.ringLookup(alice.id, bob.id);
    assert.equal(lookup.allowed, true);
    assert.ok(lookup.allowed);
    assert.equal(lookup.fromName, "Alice Appleseed");
    assert.deepEqual(lookup.devices.map((d) => [d.id, d.platform]), [["watch-1", "watch"]]);
    assert.equal((await accounts.ringLookup(bob.id, alice.id)).allowed, true);

    // Bob's iPhone in its PushToTalk channel, and his choice of which device rings.
    await accounts.registerDevice(bob.id, "phone-1", { platform: "iphone", pushToken: "cd".repeat(32), pushType: "pushtotalk", apnsEnvironment: "sandbox" });
    assert.equal((await accounts.setRingOn(bob.id, "iphone")).ringOn, "iphone");
    const chosen = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(chosen.allowed);
    assert.equal(chosen.ringOn, "iphone");
    assert.deepEqual(chosen.devices.map((d) => [d.id, d.platform, d.pushType]).sort(), [["phone-1", "iphone", "pushtotalk"], ["watch-1", "watch", "alert"]]);
    assert.equal((await accounts.setRingOn(bob.id, null)).ringOn, undefined);
    const byDefault = await accounts.ringLookup(alice.id, bob.id);
    assert.ok(byDefault.allowed);
    assert.equal(byDefault.ringOn, undefined);

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
    const first = await accounts.createSession(alice.id, "phone-1", "iphone");
    const second = await accounts.createSession(alice.id, "phone-1", "iphone");
    const watch = await accounts.createSession(alice.id, "watch-1", "watch");
    assert.equal(await accounts.touchSession(alice.id, first, "phone-1"), false);
    assert.equal(await accounts.touchSession(alice.id, second, "phone-1"), true);
    // A sid only works with its own device.
    assert.equal(await accounts.touchSession(alice.id, second, "watch-1"), false);
    await accounts.registerDevice(alice.id, "watch-1", { platform: "watch", pushToken: "t", apnsEnvironment: "sandbox" });
    // Signing out with a replaced token ends nothing.
    const newer = await accounts.createSession(alice.id, "watch-1", "watch");
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
    const sids = await Promise.all([1, 2, 3, 4].map(() => accounts.createSession(alice.id, "watch-1", "watch")));
    assert.equal((await docs.list(`users/${alice.id}/sessions`)).length, 1);
    const valid = await Promise.all(sids.map((sid) => accounts.touchSession(alice.id, sid, "watch-1")));
    assert.equal(valid.filter(Boolean).length, 1);
  });

  test(`${label}: sessions stored by sid before the change still refresh, and move`, { skip }, async () => {
    const { docs, accounts, alice } = await setup();
    const created = new Date(Date.UTC(2026, 8, 27));
    await docs.commit([{ set: `users/${alice.id}/sessions/oldSid123`, data: { deviceId: "watch-1", platform: "watch", createdAt: created, refreshedAt: created } }]);
    assert.equal(await accounts.touchSession(alice.id, "oldSid123", "phone-9"), false);
    assert.equal(await accounts.touchSession(alice.id, "oldSid123", "watch-1"), true);
    assert.deepEqual((await docs.list(`users/${alice.id}/sessions`)).map((s) => [s.id, s.data.sid]), [["watch-1", "oldSid123"]]);
    assert.equal(await accounts.touchSession(alice.id, "oldSid123", "watch-1"), true);
    // A legacy session also signs out.
    await docs.commit([{ set: `users/${alice.id}/sessions/oldSid456`, data: { deviceId: "phone-2", platform: "iphone", createdAt: created, refreshedAt: created } }]);
    await accounts.endSession(alice.id, "oldSid456", "phone-2");
    assert.equal(await accounts.touchSession(alice.id, "oldSid456", "phone-2"), false);
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

  test(`${label}: deleting an account removes it everywhere but reports`, { skip }, async () => {
    const { docs, accounts, alice, bob } = await setup();
    await befriend(accounts, alice.id, bob.id);
    await accounts.setPhoto(alice.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]));
    const carol = (await accounts.signInWithApple("001.carol.1", "Carol")).user;
    await accounts.block(alice.id, carol.id);
    await accounts.block(carol.id, alice.id);
    await accounts.createSession(alice.id, "phone-1", "iphone");
    await accounts.registerDevice(alice.id, "watch-1", { platform: "watch", pushToken: "t", apnsEnvironment: "sandbox" });
    const pending = await accounts.createInvite(alice.id);
    const reportId = await accounts.report(bob.id, { userId: alice.id, reason: "spam" });

    assert.deepEqual(await accounts.deleteAccount(alice.id), { appleSub: "001.alice.1" });
    assert.equal(await accounts.user(alice.id), undefined);
    assert.deepEqual(await accounts.friends(bob.id), []);
    assert.equal(await code(accounts.invite(pending.code, bob.id)), "invite-not-found");
    // Carol's block of Alice stays, but no longer names her.
    assert.deepEqual((await accounts.blocks(carol.id)).map((b) => b.name), [null]);
    for (const sub of ["friends", "blocks", "devices", "sessions"]) assert.deepEqual(await docs.list(`users/${alice.id}/${sub}`), []);
    assert.deepEqual(await docs.getAll(["appleSubs/001.alice.1", `photos/${alice.id}`]), [undefined, undefined]);
    assert.notEqual((await docs.getAll([`reports/${reportId}`]))[0], undefined);
    // The same Apple ID starts over with a new account.
    const again = await accounts.signInWithApple("001.alice.1", "Alice");
    assert.equal(again.created, true);
    assert.notEqual(again.user.id, alice.id);
    assert.equal(await code(accounts.deleteAccount(alice.id)), "no-account");
  });
}
