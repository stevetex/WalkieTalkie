// The account API and the relay together, as the apps use them: sign in, invite, accept,
// ring a friend with a session token, and what blocks, sign-out and deletion do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { createApi } from "../src/api.ts";
import { MemoryDocs } from "../src/docs.ts";
import { SessionSigner, SessionVerifier, generateSigningKey } from "../src/session.ts";
import { SpikeClient } from "../tools/client.ts";

interface Harness {
  server: RunningServer;
  url: string;
  revoked: string[];
  now: { t: number };
  signer: SessionSigner;
  pusher: DryRunPusher;
}

// Apple is faked: the identity token is the Apple user ID, and an authorization code
// "code:<sub>" revokes that user's token.
async function withApi(fn: (h: Harness) => Promise<void>, relayOptions: { ringTimeoutMs?: number } = {}): Promise<void> {
  const now = { t: Date.now() };
  const { signingKey, publicKeys } = generateSigningKey("test");
  const signer = new SessionSigner(signingKey, () => now.t);
  const verifier = new SessionVerifier(publicKeys, () => now.t);
  const accounts = new Accounts(new MemoryDocs());
  const revoked: string[] = [];
  const api = createApi({
    accounts,
    signer,
    verifier,
    apple: {
      verify: async (identityToken, nonce) => {
        if (nonce !== "nonce") throw new Error("bad nonce");
        return { sub: identityToken };
      },
    },
    revoker: {
      revokeWithCode: async (code) => {
        if (!code.startsWith("code:")) throw new Error("invalid_grant");
        revoked.push(code.slice(5));
        return { sub: code.slice(5) };
      },
    },
    inviteBaseUrl: "https://overandout.app/i/",
    log: () => {},
  });
  const pusher = new DryRunPusher();
  const server = await startServer({
    port: 0,
    dataDir: null,
    token: "shared",
    sessions: verifier,
    accounts,
    api,
    pusher,
    ...relayOptions,
  });
  try {
    await fn({ server, url: `http://localhost:${server.port}`, revoked, now, signer, pusher });
  } finally {
    await server.close();
  }
}

async function call(url: string, method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function signIn(url: string, sub: string, name: string, deviceId: string) {
  const res = await call(url, "POST", "/v1/auth/apple", null, { identityToken: sub, nonce: "nonce", name, deviceId, platform: "iphone" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { token: string; expiresAt: number; user: { id: string; name: string }; created: boolean };
}

async function befriend(url: string, inviterToken: string, inviteeToken: string) {
  const invite = await call(url, "POST", "/v1/invites", inviterToken);
  assert.equal(invite.status, 200);
  const accepted = await call(url, "POST", `/v1/invites/${invite.body.code}/accept`, inviteeToken);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

function pcm(frames: number): Buffer {
  return Buffer.alloc(frames * 640, 1);
}

test("sign in, invite a friend, and ring them with session tokens", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal(alice.created, true);
    assert.deepEqual((await call(url, "GET", "/v1/me", alice.token)).body, alice.user);
    // The iPhone gets the watch its own session.
    const watch = await call(url, "POST", "/v1/auth/device", alice.token, { deviceId: "alice-watch", platform: "watch" });
    assert.equal(watch.status, 200);
    const watchToken = watch.body.token as string;
    assert.equal((await call(url, "PUT", "/v1/me/device", watchToken, { platform: "watch", pushToken: "poll:alice", apnsEnvironment: "sandbox" })).status, 200);

    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    const invite = await call(url, "POST", "/v1/invites", alice.token);
    assert.match(invite.body.url, /^https:\/\/overandout\.app\/i\/[\w-]{22}$/);
    const preview = await call(url, "GET", `/v1/invites/${invite.body.code}`, bob.token);
    assert.deepEqual(preview.body.from, { id: alice.user.id, name: "Alice" });
    assert.equal((await call(url, "POST", `/v1/invites/${invite.body.code}/accept`, bob.token)).body.friend.name, "Alice");
    assert.deepEqual((await call(url, "GET", "/v1/friends", alice.token)).body.friends.map((f: { name: string }) => f.name), ["Bob"]);

    // Bob rings Alice's watch. His user ID comes from his token, not the URL.
    const bobClient = new SpikeClient({ server: url, userId: "ignored", token: bob.token });
    await bobClient.connect();
    const { conversationId, pushed } = await bobClient.talk(alice.user.id, pcm(10), { realtime: false });
    assert.equal(pushed, true);
    const aliceWatch = new SpikeClient({ server: url, userId: "ignored", token: watchToken, transport: "http" });
    const rings = await aliceWatch.api("GET", "/v1/rings/poll");
    assert.deepEqual(rings.map((r: { from: string; fromName: string }) => [r.from, r.fromName]), [[bob.user.id, "Bob"]]);
    await aliceWatch.connect(conversationId);
    assert.equal((await aliceWatch.waitFor("joined")).peer, bob.user.id);
    await aliceWatch.waitFor("burst-end");
    assert.equal(aliceWatch.frames.length, 10);
    bobClient.close();
    aliceWatch.close();
  });
});

test("an account can only ring its friends, and a block stops the rings", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    const carol = await signIn(url, "apple.carol", "Carol", "carol-phone");
    await call(url, "PUT", "/v1/me/device", alice.token, { platform: "watch", pushToken: "poll:alice" });
    await befriend(url, alice.token, bob.token);

    const carolClient = new SpikeClient({ server: url, userId: "carol", token: carol.token });
    await carolClient.connect();
    carolClient.send({ type: "talk-start", to: alice.user.id, burstId: "b1" });
    assert.equal((await carolClient.waitFor("talk-refused")).reason, "not-friends");
    carolClient.close();

    // Friends: Bob rings, Alice's watch answers, and both leave.
    const bobClient = new SpikeClient({ server: url, userId: "bob", token: bob.token });
    await bobClient.connect();
    const first = await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    assert.equal(first.pushed, true);
    const aliceWatch = new SpikeClient({ server: url, userId: "alice", token: alice.token, transport: "http" });
    await aliceWatch.connect(first.conversationId);
    await aliceWatch.waitFor("burst-end");
    aliceWatch.close();
    bobClient.close();
    await new Promise((r) => setTimeout(r, 50));

    // Alice blocks and reports Bob in one step: the friendship goes, so his next ring is refused.
    const report = await call(url, "POST", "/v1/reports", alice.token, { userId: bob.user.id, reason: "harassment", block: true });
    assert.equal(report.status, 200);
    assert.deepEqual((await call(url, "GET", "/v1/friends", bob.token)).body.friends, []);
    assert.deepEqual((await call(url, "GET", "/v1/blocks", alice.token)).body.blocks.map((b: { name: string }) => b.name), ["Bob"]);
    const again = new SpikeClient({ server: url, userId: "bob", token: bob.token });
    await again.connect();
    again.send({ type: "talk-start", to: alice.user.id, burstId: "b2" });
    assert.equal((await again.waitFor("talk-refused")).burstId, "b2");
    again.close();
  });
});

test("tokens: shared-token clients can't pose as accounts, and accounts can't use the diagnostics", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal((await call(url, "GET", `/v1/rings/poll?userId=${alice.user.id}`, "shared")).status, 401);
    assert.equal((await call(url, "POST", "/v1/devices", "shared", { userId: alice.user.id, pushToken: "poll:x" })).status, 403);
    assert.equal((await call(url, "GET", "/v1/users", alice.token)).status, 403);
    assert.equal((await call(url, "GET", "/v1/status", alice.token)).status, 403);
    assert.equal((await call(url, "GET", "/v1/users", "shared")).status, 200);
    assert.equal((await call(url, "GET", "/v1/friends", "shared")).status, 401);
    assert.equal((await call(url, "GET", "/v1/friends", null)).status, 401);
    assert.equal((await call(url, "GET", "/v1/rings/poll", `${alice.token}x`)).status, 401);
    const badNonce = await call(url, "POST", "/v1/auth/apple", null, { identityToken: "apple.x", nonce: "other", deviceId: "d", platform: "iphone" });
    assert.deepEqual([badNonce.status, badNonce.body.error], [401, "apple-token-rejected"]);
    const missing = await call(url, "POST", "/v1/auth/apple", null, { identityToken: "apple.x" });
    assert.deepEqual([missing.status, missing.body.error], [400, "bad-request"]);
  });
});

test("refresh works past expiry until the session ends", async () => {
  await withApi(async ({ url, now }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    now.t += 31 * 24 * 60 * 60 * 1000;
    const expired = await call(url, "GET", "/v1/me", alice.token);
    assert.deepEqual([expired.status, expired.body.error], [401, "token-expired"]);
    const refreshed = await call(url, "POST", "/v1/auth/refresh", alice.token);
    assert.equal(refreshed.status, 200);
    assert.equal((await call(url, "GET", "/v1/me", refreshed.body.token)).status, 200);

    assert.equal((await call(url, "POST", "/v1/auth/signout", refreshed.body.token)).status, 200);
    const ended = await call(url, "POST", "/v1/auth/refresh", refreshed.body.token);
    assert.deepEqual([ended.status, ended.body.error], [401, "session-ended"]);
    // Signing in on the same device again replaces the old session.
    const again = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal(again.created, false);
    assert.equal(again.user.id, alice.user.id);
  });
});

test("profile photos: upload, a friend downloads it, strangers can't", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "001.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "001.bob", "Bob", "bob-phone");
    const carol = await signIn(url, "001.carol", "Carol", "carol-phone");
    await befriend(url, alice.token, bob.token);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);

    const put = await fetch(new URL("/v1/me/photo", url), {
      method: "PUT",
      headers: { "content-type": "image/jpeg", authorization: `Bearer ${alice.token}` },
      body: jpeg,
    });
    assert.equal(put.status, 200);
    const { photoVersion } = await put.json();
    assert.equal((await call(url, "GET", "/v1/me", alice.token)).body.photoVersion, photoVersion);
    assert.equal((await call(url, "GET", "/v1/friends", bob.token)).body.friends[0].photoVersion, photoVersion);

    const get = (token: string) => fetch(new URL(`/v1/users/${alice.user.id}/photo`, url), { headers: { authorization: `Bearer ${token}` } });
    const seen = await get(bob.token);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/jpeg");
    assert.match(seen.headers.get("cache-control") ?? "", /private/);
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), jpeg);
    assert.equal((await get(carol.token)).status, 404);

    const tooBig = await fetch(new URL("/v1/me/photo", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(200 * 1024, 0xff),
    });
    assert.equal(tooBig.status, 413);

    assert.equal((await call(url, "DELETE", "/v1/me/photo", alice.token)).status, 200);
    assert.equal((await get(bob.token)).status, 404);
    assert.equal((await call(url, "GET", "/v1/friends", bob.token)).body.friends[0].photoVersion, undefined);
  });
});

test("deleting an account revokes the Apple token with a fresh code and removes the friendship", async () => {
  await withApi(async ({ url, revoked }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);

    const noCode = await call(url, "DELETE", "/v1/me", alice.token, {});
    assert.deepEqual([noCode.status, noCode.body.error], [400, "authorization-code-required"]);
    const badCode = await call(url, "DELETE", "/v1/me", alice.token, { authorizationCode: "stale" });
    assert.deepEqual([badCode.status, badCode.body.error], [502, "apple-revoke-failed"]);
    const wrongId = await call(url, "DELETE", "/v1/me", alice.token, { authorizationCode: "code:apple.bob" });
    assert.deepEqual([wrongId.status, wrongId.body.error], [403, "wrong-apple-id"]);
    assert.equal((await call(url, "GET", "/v1/me", alice.token)).status, 200);

    assert.equal((await call(url, "DELETE", "/v1/me", alice.token, { authorizationCode: "code:apple.alice" })).status, 200);
    assert.deepEqual(revoked, ["apple.bob", "apple.alice"]);
    assert.equal((await call(url, "GET", "/v1/me", alice.token)).status, 404);
    assert.deepEqual((await call(url, "GET", "/v1/friends", bob.token)).body.friends, []);
    assert.equal((await call(url, "POST", "/v1/auth/refresh", alice.token)).status, 401);
  });
});

// An account whose iPhone and watch both talk (design decisions 2026-09-27).
async function twoDevices(url: string) {
  const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
  const watch = await call(url, "POST", "/v1/auth/device", alice.token, { deviceId: "alice-watch", platform: "watch" });
  const watchToken = watch.body.token as string;
  assert.equal((await call(url, "PUT", "/v1/me/device", watchToken, { platform: "watch", pushToken: "poll:alice-watch" })).status, 200);
  const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
  await befriend(url, alice.token, bob.token);
  return { alice, watchToken, bob };
}

// Ends the conversation from Bob's side once its ring has timed out, so the next talk rings again.
async function hangUp(bob: SpikeClient, conversationId: string) {
  await bob.waitFor("ring-timeout");
  bob.send({ type: "leave", conversationId });
  await new Promise((r) => setTimeout(r, 50));
}

test("an iPhone and a watch on one account stay connected together, and a conversation moves between them", async () => {
  await withApi(async ({ url }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const alicePhone = new SpikeClient({ server: url, userId: "alice-phone", token: alice.token });
    await alicePhone.connect();
    const bobClient = new SpikeClient({ server: url, userId: "bob", token: bob.token });
    await bobClient.connect();

    // The watch rings (the default with a watch), and it joins while the iPhone stays connected.
    const first = await bobClient.talk(alice.user.id, pcm(3), { realtime: false });
    const aliceWatch = new SpikeClient({ server: url, userId: "alice-watch", token: watchToken, transport: "http" });
    assert.equal((await aliceWatch.api("GET", "/v1/rings/poll")).length, 1);
    await aliceWatch.connect(first.conversationId);
    await aliceWatch.waitFor("burst-end");
    assert.equal(aliceWatch.frames.length, 3);
    assert.equal(alicePhone.received.some((m) => m.type === "ring"), false);

    // Alice picks it up on the iPhone: the watch is told, and Bob's next message goes to the iPhone.
    alicePhone.send({ type: "join", conversationId: first.conversationId });
    await alicePhone.waitFor("joined");
    assert.equal((await aliceWatch.waitFor("moved")).conversationId, first.conversationId);
    const second = await bobClient.talk(alice.user.id, pcm(4), { realtime: false });
    assert.equal(second.pushed, false);
    await alicePhone.waitFor("burst-end");
    assert.equal(alicePhone.frames.length, 4);
    assert.equal(aliceWatch.frames.length, 3);

    // And back: Alice talks from the watch, so the iPhone is told and Bob's reply goes to the watch.
    await aliceWatch.talk(bob.user.id, pcm(1), { realtime: false });
    await alicePhone.waitFor("moved");
    // The watch's talk-end travels in its own HTTP request: wait until Bob has it.
    await bobClient.waitFor("burst-end");
    await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    await aliceWatch.waitForMatch((m) => m.type === "burst-end" && aliceWatch.frames.length === 5, "Bob's reply");
    assert.equal(alicePhone.frames.length, 4);
    for (const c of [alicePhone, aliceWatch, bobClient]) c.close();
  });
});

test("one device rings: the watch by default, the iPhone when chosen, the other when one can't be reached", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const aliceWatch = new SpikeClient({ server: url, userId: "alice-watch", token: watchToken });
    const bobClient = new SpikeClient({ server: url, userId: "bob", token: bob.token });
    await bobClient.connect();
    const pushToTalk = () => pusher.sent.filter((p) => p.pushType === "pushtotalk");

    // The iPhone is in its PushToTalk channel, but the watch is the default.
    assert.equal((await call(url, "PUT", "/v1/me/device", alice.token, { platform: "iphone", pushToken: "ptt-alice", pushType: "pushtotalk" })).status, 200);
    let ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal((await aliceWatch.api("GET", "/v1/rings/poll")).length, 1);
    assert.equal(pushToTalk().length, 0);
    await hangUp(bobClient, ring.conversationId);

    // Ring Me On: iPhone. A PushToTalk push, with Bob as the active speaker.
    const me = await call(url, "PATCH", "/v1/me", alice.token, { ringOn: "iphone" });
    assert.equal(me.body.ringOn, "iphone");
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pushToTalk().length, 1);
    assert.equal(pushToTalk()[0].token, "ptt-alice");
    assert.equal((pushToTalk()[0].payload as { activeSpeaker: string }).activeSpeaker, "Bob");
    assert.equal((await aliceWatch.api("GET", "/v1/rings/poll")).length, 0);
    await hangUp(bobClient, ring.conversationId);

    // Alice leaves the channel and the app isn't open: the watch rings instead.
    await call(url, "PUT", "/v1/me/device", alice.token, { platform: "iphone", pushToken: "app:" });
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal((await aliceWatch.api("GET", "/v1/rings/poll")).length, 1);
    await hangUp(bobClient, ring.conversationId);

    // With the app on screen, the iPhone rings in the app, over its stream.
    const alicePhone = new SpikeClient({ server: url, userId: "alice-phone", token: alice.token });
    await alicePhone.connect();
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal((await alicePhone.waitFor("ring")).conversationId, ring.conversationId);
    assert.equal((await aliceWatch.api("GET", "/v1/rings/poll")).length, 0);
    await hangUp(bobClient, ring.conversationId);
    alicePhone.close();
    await new Promise((r) => setTimeout(r, 50));

    // Neither can be rung (the watch signed out, the iPhone app closed): Bob hears so at once.
    assert.equal((await call(url, "POST", "/v1/auth/signout", watchToken)).status, 200);
    bobClient.send({ type: "talk-start", to: alice.user.id, burstId: "nobody" });
    assert.equal((await bobClient.waitFor("talk-refused")).reason, "unavailable");

    // Back to the default: with no watch, that's the iPhone.
    assert.equal((await call(url, "PATCH", "/v1/me", alice.token, { ringOn: null })).body.ringOn, undefined);
    assert.equal((await call(url, "PATCH", "/v1/me", alice.token, { ringOn: "tv" })).status, 400);
    assert.equal((await call(url, "PUT", "/v1/me/device", alice.token, { platform: "watch", pushToken: "x", pushType: "pushtotalk" })).status, 400);
    bobClient.close();
  }, { ringTimeoutMs: 200 });
});

test("the device in use keeps the conversation: a reply rings the iPhone Alice talked from", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, bob } = await twoDevices(url);
    await call(url, "PUT", "/v1/me/device", alice.token, { platform: "iphone", pushToken: "ptt-alice", pushType: "pushtotalk" });
    await call(url, "PUT", "/v1/me/device", bob.token, { platform: "iphone", pushToken: "local:bob" });
    const bobClient = new SpikeClient({ server: url, userId: "bob", token: bob.token });
    await bobClient.connect();

    // Alice talks from her iPhone; Bob is rung in his app and joins.
    const alicePhone = new SpikeClient({ server: url, userId: "alice-phone", token: alice.token });
    await alicePhone.connect();
    const { conversationId } = await alicePhone.talk(bob.user.id, pcm(2), { realtime: false });
    await bobClient.waitFor("ring");
    bobClient.send({ type: "join", conversationId });
    await bobClient.waitFor("burst-end");

    // Her iPhone app goes to the background and closes its stream. Bob's reply rings the
    // iPhone (PushToTalk), not the watch that would ring by default.
    alicePhone.close();
    await new Promise((r) => setTimeout(r, 50));
    await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(pusher.sent.map((p) => [p.pushType, p.token]), [["pushtotalk", "ptt-alice"]]);
    bobClient.close();
  });
});
