// The account API and the relay together, as the apps use them: sign in, invite, accept,
// ring a friend with a session token, and what blocks, sign-out and deletion do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer, type RunningServer } from "../src/main.ts";
import { DryRunPusher, type AlertPush, type ApnsEnvironment, type PushResult } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { createApi } from "../src/api.ts";
import { MemoryDocs } from "../src/docs.ts";
import { SessionSigner, SessionVerifier, generateSigningKey } from "../src/session.ts";
import { Codec, type RingPayload } from "../src/protocol.ts";
import { SpikeClient } from "../tools/client.ts";
import { call, clientHeaders, pcm } from "./harness.ts";

interface Harness {
  server: RunningServer;
  url: string;
  revoked: string[];
  now: { t: number };
  signer: SessionSigner;
  pusher: DryRunPusher;
}

// Apple is faked: the identity token is the Apple user ID, the nonce must be "nonce", and an
// authorization code "code:<sub>" revokes that user's token. The session clock is `now`, so a
// test can move past a token's expiry (harness.ts's withServer has no clock).
async function withApi(
  fn: (h: Harness) => Promise<void>,
  { pusher = new DryRunPusher(), ...relayOptions }: { ringTimeoutMs?: number; answerJoinTimeoutMs?: number; rollOverMs?: number; authTtlMs?: number; pusher?: DryRunPusher } = {},
): Promise<void> {
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
    telemetry: { write: () => {}, flush: async () => {} },
  });
  const server = await startServer({
    port: 0,
    dataDir: null,
    adminToken: "admin",
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

// An iPhone signs in with Apple.
async function signIn(url: string, sub: string, name: string, deviceId: string) {
  const res = await call(url, "POST", "/v2/auth/apple", null, { identityToken: sub, nonce: "nonce", name, deviceId, clientKind: "ios" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { token: string; expiresAt: number; user: { id: string; name: string }; created: boolean };
}

// The iPhone gets its watch a session of its own.
async function watchFor(url: string, phoneToken: string, deviceId: string): Promise<string> {
  const res = await call(url, "POST", "/v2/auth/device", phoneToken, { deviceId, clientKind: "watchos", requestId: `req-${deviceId}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.token as string;
}

async function befriend(url: string, inviterToken: string, inviteeToken: string) {
  const invite = await call(url, "POST", "/v2/invites", inviterToken);
  assert.equal(invite.status, 200);
  const accepted = await call(url, "POST", `/v2/invites/${invite.body.code}/accept`, inviteeToken);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

// APNs device tokens, and how each kind of device is rung.
const WATCH = "aa".repeat(32);
const PHONE = "bb".repeat(32);
const alertTo = (token: string) => ({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "sandbox" } });
const pushToTalk = (token: string) => ({ clientKind: "ios", delivery: { provider: "apns", mode: "pushtotalk", token, environment: "sandbox" } });
const inApp = { clientKind: "ios", delivery: { provider: "relay", mode: "foreground" } };

async function register(url: string, token: string, registration: Record<string, unknown>) {
  const res = await call(url, "PUT", "/v2/me/device", token, registration);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

// The ring in the newest push to this token.
function ringIn(pusher: DryRunPusher, token: string): RingPayload & { activeSpeaker?: string } {
  const push = pusher.sent.filter((p) => p.token === token).at(-1);
  assert.ok(push, `no push to ${token}`);
  return push.payload as RingPayload;
}

// A relay client on this session: an iPhone over the WebSocket, a watch over HTTP.
function relayClient(url: string, userId: string, token: string, kind: "ios" | "watchos"): SpikeClient {
  return new SpikeClient({ server: url, userId, token, clientKind: kind, ...(kind === "watchos" ? { transport: "http" as const } : {}) });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("sign in, invite a friend, and ring them with session tokens", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal(alice.created, true);
    assert.deepEqual((await call(url, "GET", "/v2/me", alice.token)).body, { ...alice.user, formFactors: [] });
    // The iPhone gets the watch its own session.
    const watchToken = await watchFor(url, alice.token, "alice-watch");
    await register(url, watchToken, alertTo(WATCH));

    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    const invite = await call(url, "POST", "/v2/invites", alice.token);
    assert.match(invite.body.url, /^https:\/\/overandout\.app\/i\/[\w-]{22}$/);
    const preview = await call(url, "GET", `/v2/invites/${invite.body.code}`, bob.token);
    assert.deepEqual(preview.body.from, { id: alice.user.id, name: "Alice" });
    assert.equal((await call(url, "POST", `/v2/invites/${invite.body.code}/accept`, bob.token)).body.friend.name, "Alice");
    assert.deepEqual((await call(url, "GET", "/v2/friends", alice.token)).body.friends.map((f: { name: string }) => f.name), ["Bob"]);

    // Bob rings Alice's watch. His account comes from his token, not anything the client says.
    const bobClient = relayClient(url, "ignored", bob.token, "ios");
    await bobClient.connect();
    const { conversationId, pushed } = await bobClient.talk(alice.user.id, pcm(10), { realtime: false });
    assert.equal(pushed, true);
    const rings = (await call(url, "GET", "/v2/rings/pending", watchToken, undefined, clientHeaders("watchos"))).body.rings as RingPayload[];
    assert.deepEqual(rings.map((r) => [r.from, r.fromName, r.conversationId]), [[bob.user.id, "Bob", conversationId]]);
    const aliceWatch = relayClient(url, "ignored", watchToken, "watchos");
    await aliceWatch.connect(conversationId, undefined, rings[0].ringId);
    assert.equal((await aliceWatch.waitFor("joined")).peer, bob.user.id);
    await aliceWatch.waitFor("burst-end");
    assert.equal(aliceWatch.frames.length, 10);
    bobClient.close();
    aliceWatch.close();

    // Alice's friend page: when Bob last talked to her (the relay records it), and her star.
    const [bobForAlice] = (await call(url, "GET", "/v2/friends", alice.token)).body.friends;
    assert.equal(typeof bobForAlice.lastMessageAt, "number");
    assert.equal(bobForAlice.favorite, undefined);
    assert.equal((await call(url, "GET", "/v2/friends", bob.token)).body.friends[0].lastMessageAt, undefined);
    assert.equal((await call(url, "PATCH", `/v2/friends/${bob.user.id}`, alice.token, { favorite: true })).status, 200);
    assert.equal((await call(url, "GET", "/v2/friends", alice.token)).body.friends[0].favorite, true);
    assert.equal((await call(url, "GET", "/v2/friends", bob.token)).body.friends[0].favorite, undefined);
    assert.equal((await call(url, "PATCH", `/v2/friends/${bob.user.id}`, alice.token, { favorite: "yes" })).status, 400);
    assert.equal((await call(url, "PATCH", "/v2/friends/u_nobody", alice.token, { favorite: true })).status, 404);
  });
});

test("an account can only ring its friends, and a block stops the rings", async () => {
  await withApi(async ({ url, pusher }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    const carol = await signIn(url, "apple.carol", "Carol", "carol-phone");
    await register(url, alice.token, pushToTalk(PHONE));
    await befriend(url, alice.token, bob.token);

    const carolClient = relayClient(url, "carol", carol.token, "ios");
    await carolClient.connect();
    carolClient.send({ type: "talk-start", to: alice.user.id, burstId: "b1", codec: "pcm16le16k" });
    assert.equal((await carolClient.waitFor("talk-refused")).reason, "not-friends");
    carolClient.close();
    assert.equal(pusher.sent.length, 0);

    // Friends: Bob rings, Alice's iPhone answers, and both leave.
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    const first = await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    assert.equal(first.pushed, true);
    const alicePhone = relayClient(url, "alice", alice.token, "ios");
    await alicePhone.connect();
    alicePhone.send({ type: "join", conversationId: first.conversationId, ringId: ringIn(pusher, PHONE).ringId });
    await alicePhone.waitFor("burst-end");
    alicePhone.close();
    bobClient.close();
    await sleep(50);

    // Alice blocks and reports Bob in one step: the friendship goes, so his next ring is refused.
    const report = await call(url, "POST", "/v2/reports", alice.token, { userId: bob.user.id, reason: "harassment", block: true });
    assert.equal(report.status, 200);
    assert.deepEqual((await call(url, "GET", "/v2/friends", bob.token)).body.friends, []);
    assert.deepEqual((await call(url, "GET", "/v2/blocks", alice.token)).body.blocks.map((b: { name: string }) => b.name), ["Bob"]);
    const again = relayClient(url, "bob", bob.token, "ios");
    await again.connect();
    again.send({ type: "talk-start", to: alice.user.id, burstId: "b2", codec: "pcm16le16k" });
    assert.equal((await again.waitFor("talk-refused")).burstId, "b2");
    again.close();
  });
});

test("tokens: sessions can't read the operator's diagnostics, the admin token isn't a session, and bad sign-ins are refused", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    for (const path of ["/admin/status", "/admin/metrics", "/admin/metrics/c1"]) {
      assert.equal((await call(url, "GET", path, alice.token)).status, 401, path);
      assert.equal((await call(url, "GET", path, "admin")).status, 200, path);
    }
    // The admin token opens nothing of an account's, at the relay or the API.
    assert.equal((await call(url, "GET", "/v2/rings/pending", "admin", undefined, clientHeaders("ios"))).status, 401);
    assert.equal((await call(url, "POST", "/v2/rings/answer", "admin", { conversationId: "c1", ringId: "r_c1" }, clientHeaders("ios"))).status, 401);
    assert.equal((await call(url, "POST", "/v2/metrics", "admin", { conversationId: "c1", events: [] })).status, 401);
    assert.equal((await call(url, "GET", "/v2/friends", "admin")).status, 401);
    const stream = await fetch(new URL("/v2/relay/stream", url), { headers: { authorization: "Bearer admin", ...clientHeaders("ios") } });
    assert.equal(stream.status, 401);
    await stream.body?.cancel();
    await assert.rejects(relayClient(url, "admin", "admin", "ios").connect());
    // No token, or one that's been tampered with.
    assert.equal((await call(url, "GET", "/v2/friends", null)).status, 401);
    assert.equal((await call(url, "GET", "/v2/rings/pending", `${alice.token}x`, undefined, clientHeaders("ios"))).status, 401);
    const badNonce = await call(url, "POST", "/v2/auth/apple", null, { identityToken: "apple.x", nonce: "other", deviceId: "d", clientKind: "ios" });
    assert.deepEqual([badNonce.status, badNonce.body.error], [401, "apple-token-rejected"]);
    const missing = await call(url, "POST", "/v2/auth/apple", null, { identityToken: "apple.x" });
    assert.deepEqual([missing.status, missing.body.error], [400, "bad-request"]);
  });
});

test("refresh works past expiry until the session ends", async () => {
  await withApi(async ({ url, now }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    now.t += 31 * 24 * 60 * 60 * 1000;
    const expired = await call(url, "GET", "/v2/me", alice.token);
    assert.deepEqual([expired.status, expired.body.error], [401, "token-expired"]);
    const refreshed = await call(url, "POST", "/v2/auth/refresh", alice.token);
    assert.equal(refreshed.status, 200);
    assert.equal((await call(url, "GET", "/v2/me", refreshed.body.token)).status, 200);

    assert.equal((await call(url, "POST", "/v2/auth/signout", refreshed.body.token)).status, 200);
    const ended = await call(url, "POST", "/v2/auth/refresh", refreshed.body.token);
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

    const put = await fetch(new URL("/v2/me/photo", url), {
      method: "PUT",
      headers: { "content-type": "image/jpeg", authorization: `Bearer ${alice.token}` },
      body: jpeg,
    });
    assert.equal(put.status, 200);
    const { photoVersion } = await put.json();
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.photoVersion, photoVersion);
    assert.equal((await call(url, "GET", "/v2/friends", bob.token)).body.friends[0].photoVersion, photoVersion);

    const get = (token: string) => fetch(new URL(`/v2/users/${alice.user.id}/photo`, url), { headers: { authorization: `Bearer ${token}` } });
    const seen = await get(bob.token);
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/jpeg");
    assert.match(seen.headers.get("cache-control") ?? "", /private/);
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), jpeg);
    assert.equal((await get(carol.token)).status, 404);

    const tooBig = await fetch(new URL("/v2/me/photo", url), {
      method: "PUT",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(200 * 1024, 0xff),
    });
    assert.equal(tooBig.status, 413);

    assert.equal((await call(url, "DELETE", "/v2/me/photo", alice.token)).status, 200);
    assert.equal((await get(bob.token)).status, 404);
    assert.equal((await call(url, "GET", "/v2/friends", bob.token)).body.friends[0].photoVersion, undefined);
  });
});

test("deleting an account revokes the Apple token with a fresh code and removes the friendship", async () => {
  await withApi(async ({ url, revoked }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);

    const badCode = await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "apple", authorizationCode: "stale" } });
    assert.deepEqual([badCode.status, badCode.body.error], [502, "apple-revoke-failed"]);
    const wrongId = await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "apple", authorizationCode: "code:apple.bob" } });
    assert.deepEqual([wrongId.status, wrongId.body.error], [403, "wrong-apple-id"]);
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).status, 200);

    assert.equal((await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "apple", authorizationCode: "code:apple.alice" } })).status, 200);
    assert.deepEqual(revoked, ["apple.bob", "apple.alice"]);
    const gone = await call(url, "GET", "/v2/me", alice.token);
    assert.deepEqual([gone.status, gone.body.error], [401, "session-ended"]);
    assert.deepEqual((await call(url, "GET", "/v2/friends", bob.token)).body.friends, []);
    assert.equal((await call(url, "POST", "/v2/auth/refresh", alice.token)).status, 401);
  });
});

// An account whose iPhone and watch both talk (design decisions 2026-09-27). The watch is rung
// by APNs alert.
async function twoDevices(url: string) {
  const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
  const watchToken = await watchFor(url, alice.token, "alice-watch");
  await register(url, watchToken, alertTo(WATCH));
  const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
  await befriend(url, alice.token, bob.token);
  return { alice, watchToken, bob };
}

// Ends the conversation from Bob's side once its ring has timed out, so the next talk rings again.
async function hangUp(bob: SpikeClient, conversationId: string) {
  await bob.waitFor("ring-timeout");
  bob.send({ type: "leave", conversationId });
  await sleep(50);
}

test("an iPhone and a watch on one account stay connected together, and a conversation moves between them", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();

    // The watch rings (the default with a watch), and it joins while the iPhone stays connected.
    const first = await bobClient.talk(alice.user.id, pcm(3), { realtime: false });
    const ring = ringIn(pusher, WATCH);
    assert.equal(ring.conversationId, first.conversationId);
    const aliceWatch = relayClient(url, "alice-watch", watchToken, "watchos");
    await aliceWatch.connect(first.conversationId, undefined, ring.ringId);
    await aliceWatch.waitFor("burst-end");
    assert.equal(aliceWatch.frames.length, 3);
    assert.equal(alicePhone.received.some((m) => m.type === "ring"), false);

    // Alice picks it up on the iPhone (a member moving needs no ring): the watch is told, and
    // Bob's next message goes to the iPhone.
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
    assert.equal(pusher.sent.length, 1);
    for (const c of [alicePhone, aliceWatch, bobClient]) c.close();
  });
});

test("one device rings: the watch by default, the iPhone when chosen, the other when one can't be reached", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    // Rings only: each unanswered ring here also ends with its "Missed message" notice.
    const rings = () => pusher.sent.filter((p) => !(p.payload as { missed?: number }).missed);
    const pushes = () => rings().map((p) => [p.token, p.pushType ?? "alert"]);

    // The iPhone is in its PushToTalk channel, but the watch is the default.
    await register(url, alice.token, pushToTalk(PHONE));
    let ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.deepEqual(pushes(), [[WATCH, "alert"]]);
    await hangUp(bobClient, ring.conversationId);

    // Ring Me On: iPhone. A PushToTalk push, with Bob as the active speaker.
    const me = await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: "phone" });
    assert.equal(me.body.preferredFormFactor, "phone");
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.deepEqual(pushes(), [[WATCH, "alert"], [PHONE, "pushtotalk"]]);
    assert.equal(ringIn(pusher, PHONE).activeSpeaker, "Bob");
    await hangUp(bobClient, ring.conversationId);

    // Alice leaves the channel and the app isn't open: the watch rings instead.
    await register(url, alice.token, inApp);
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.deepEqual(pushes().at(-1), [WATCH, "alert"]);
    assert.equal(rings().length, 3);
    await hangUp(bobClient, ring.conversationId);

    // With the app on screen, the iPhone rings in the app, over its stream.
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal((await alicePhone.waitFor("ring")).conversationId, ring.conversationId);
    assert.equal(rings().length, 3);
    await hangUp(bobClient, ring.conversationId);
    alicePhone.close();
    await sleep(50);

    // Neither can be rung (the watch signed out, the iPhone app closed): Bob hears so at once.
    assert.equal((await call(url, "POST", "/v2/auth/signout", watchToken)).status, 200);
    bobClient.send({ type: "talk-start", to: alice.user.id, burstId: "nobody", codec: "pcm16le16k" });
    assert.equal((await bobClient.waitFor("talk-refused")).reason, "unavailable");

    // Back to the default: with no watch, that's the iPhone.
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: null })).body.preferredFormFactor, undefined);
    const tv = await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: "tv" });
    assert.deepEqual([tv.status, tv.body.error], [400, "bad-preferred-form-factor"]);
    assert.deepEqual((await call(url, "GET", "/v2/me", alice.token)).body.formFactors, ["phone"]);

    // A mascot as the picture, which friends see in their lists.
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { avatar: "fox" })).body.avatar, "fox");
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.avatar, "fox");
    assert.equal((await call(url, "GET", "/v2/friends", bob.token)).body.friends[0].avatar, "fox");
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { avatar: "<fox>" })).status, 400);
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { avatar: null })).body.avatar, undefined);
    bobClient.close();
  }, { ringTimeoutMs: 200 });
});

test("rollover: an unanswered watch rings the iPhone, within the first ring's time", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, bob } = await twoDevices(url);
    await register(url, alice.token, pushToTalk(PHONE));
    const me = await call(url, "PATCH", "/v2/me", alice.token, { rollOver: true });
    assert.equal(me.body.rollOver, true);
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.rollOver, true);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    // Connected already (an open stream doesn't ring a PushToTalk iPhone), so its join after the
    // rollover is quick enough to beat the ring's deadline on a busy machine.
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    const pushToTalks = () => pusher.sent.filter((p) => p.pushType === "pushtotalk");

    // The watch rings first, and nothing else until the rollover.
    const startedAt = Date.now();
    const { conversationId } = await bobClient.talk(alice.user.id, pcm(3), { realtime: false });
    await sleep(100);
    assert.equal(pushToTalks().length, 0);

    // Unanswered: the iPhone's PushToTalk push, for the same ring and with the same deadline.
    await sleep(300);
    assert.equal(pushToTalks().length, 1);
    const watchRing = ringIn(pusher, WATCH);
    const phoneRing = ringIn(pusher, PHONE);
    assert.deepEqual([phoneRing.conversationId, phoneRing.ringId, phoneRing.expiresAt], [conversationId, watchRing.ringId, watchRing.expiresAt]);

    // The iPhone joins and plays the message.
    alicePhone.send({ type: "join", conversationId, ringId: phoneRing.ringId });
    await alicePhone.waitFor("burst-end");
    assert.equal(alicePhone.frames.length, 3);
    alicePhone.send({ type: "leave", conversationId });
    alicePhone.close();
    bobClient.send({ type: "leave", conversationId });
    await sleep(50);

    // Unanswered on the iPhone too: the ring runs out when the first ring would have (800 ms),
    // not a full ring time after the rollover (1100 ms).
    const second = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    const secondAt = Date.now();
    await bobClient.waitFor("ring-timeout", (m) => m.conversationId === second.conversationId);
    assert.ok(Date.now() - secondAt < 1_000, `ring ran ${Date.now() - secondAt} ms`);
    assert.ok(Date.now() - startedAt > 800);
    bobClient.close();
  }, { ringTimeoutMs: 800, rollOverMs: 300 });
});

test("rollover: an iPhone that only played a rolled-over message doesn't keep the conversation", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, bob } = await twoDevices(url);
    await register(url, alice.token, pushToTalk(PHONE));
    await call(url, "PATCH", "/v2/me", alice.token, { rollOver: true });
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    const alerts = () => pusher.sent.filter((p) => (p.pushType ?? "alert") === "alert" && p.token === WATCH).length;
    const pushToTalks = () => pusher.sent.filter((p) => p.pushType === "pushtotalk").length;

    // Rolled over: the iPhone plays it by itself, then iOS ends its call (a leave without "end").
    const { conversationId } = await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    await sleep(300);
    assert.equal(pushToTalks(), 1);
    alicePhone.send({ type: "join", conversationId, ringId: ringIn(pusher, PHONE).ringId });
    await alicePhone.waitFor("burst-end");
    alicePhone.send({ type: "leave", conversationId });
    const left = await bobClient.waitFor("peer-left");
    assert.equal(left.reason, "left");

    // Bob talks again in the same conversation: the watch rings first again, not the iPhone.
    const alertsBefore = alerts();
    await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    await sleep(100);
    assert.equal(alerts(), alertsBefore + 1);
    assert.equal(pushToTalks(), 1);
    alicePhone.close();
    bobClient.close();
  }, { ringTimeoutMs: 800, rollOverMs: 200 });
});

test("rollover: off by default, and an answer or a decline on the watch stops it", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    await register(url, alice.token, pushToTalk(PHONE));
    const aliceWatch = relayClient(url, "alice-watch", watchToken, "watchos");
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    const pushToTalks = () => pusher.sent.filter((p) => p.pushType === "pushtotalk");
    const ringCall = (action: "answer" | "decline", conversationId: string, ringId: string) =>
      call(url, "POST", `/v2/rings/${action}`, watchToken, { conversationId, ringId }, clientHeaders("watchos"));

    // Off: the watch rings until the ring runs out, as before.
    let ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    await hangUp(bobClient, ring.conversationId);
    assert.equal(pushToTalks().length, 0);

    // On, and Alice declines on the watch.
    await call(url, "PATCH", "/v2/me", alice.token, { rollOver: true });
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal((await ringCall("decline", ring.conversationId, ringIn(pusher, WATCH).ringId)).status, 200);
    await hangUp(bobClient, ring.conversationId);
    assert.equal(pushToTalks().length, 0);

    // On, and Alice answers on the watch (its join is still to come).
    ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    const ringId = ringIn(pusher, WATCH).ringId;
    assert.equal((await aliceWatch.api("POST", "/v2/rings/answer", { conversationId: ring.conversationId, ringId })).ring.ringId, ringId);
    await hangUp(bobClient, ring.conversationId);
    assert.equal(pushToTalks().length, 0);

    // Off again; declining a ring that's over is refused.
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { rollOver: false })).body.rollOver, undefined);
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { rollOver: "yes" })).status, 400);
    const late = await ringCall("decline", ring.conversationId, ringId);
    assert.deepEqual([late.status, late.body.error], [410, "ring-expired"]);
    bobClient.close();
  }, { ringTimeoutMs: 400, answerJoinTimeoutMs: 400, rollOverMs: 200 });
});

test("rollover: the watch answering just after it keeps the message, and the iPhone gives way", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    await register(url, alice.token, pushToTalk(PHONE));
    await call(url, "PATCH", "/v2/me", alice.token, { rollOver: true });
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();

    const { conversationId } = await bobClient.talk(alice.user.id, pcm(3), { realtime: false });
    await sleep(200);
    assert.equal(pusher.sent.filter((p) => p.pushType === "pushtotalk").length, 1);

    // Alice taps the watch's ring just as the iPhone is rung: the watch's answer arrives first.
    const ringId = ringIn(pusher, WATCH).ringId;
    assert.equal((await call(url, "POST", "/v2/rings/answer", watchToken, { conversationId, ringId }, clientHeaders("watchos"))).status, 200);
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    alicePhone.send({ type: "join", conversationId, ringId: ringIn(pusher, PHONE).ringId });
    assert.equal((await alicePhone.waitFor("moved")).conversationId, conversationId);
    assert.equal(alicePhone.received.some((m) => m.type === "joined"), false);

    // The watch connects and hears all of it.
    const aliceWatch = relayClient(url, "alice-watch", watchToken, "watchos");
    await aliceWatch.connect(conversationId, undefined, ringId);
    await aliceWatch.waitFor("burst-end");
    assert.equal(aliceWatch.frames.length, 3);
    assert.equal(alicePhone.frames.length, 0);
    for (const c of [alicePhone, aliceWatch, bobClient]) c.close();
  }, { rollOverMs: 100 });
});

test("the device in use keeps the conversation: a reply rings the iPhone Alice talked from", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, bob } = await twoDevices(url);
    await register(url, alice.token, pushToTalk(PHONE));
    await register(url, bob.token, inApp);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();

    // Alice talks from her iPhone; Bob is rung in his app and joins.
    const alicePhone = relayClient(url, "alice-phone", alice.token, "ios");
    await alicePhone.connect();
    const { conversationId } = await alicePhone.talk(bob.user.id, pcm(2), { realtime: false });
    const bobRing = await bobClient.waitFor("ring");
    bobClient.send({ type: "join", conversationId, ringId: bobRing.ringId });
    await bobClient.waitFor("burst-end");

    // Her iPhone app goes to the background and closes its stream. Bob's reply rings the
    // iPhone (PushToTalk), not the watch that would ring by default.
    alicePhone.close();
    await sleep(50);
    await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    assert.deepEqual(pusher.sent.map((p) => [p.pushType, p.token]), [["pushtotalk", PHONE]]);
    bobClient.close();
  });
});

test("a token kept after signing out is refused, and can't make new sessions", async () => {
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal((await call(url, "POST", "/v2/auth/signout", alice.token)).status, 200);
    for (const [method, path, body] of [
      ["GET", "/v2/me", undefined],
      ["GET", "/v2/friends", undefined],
      ["POST", "/v2/invites", undefined],
      ["POST", "/v2/auth/device", { deviceId: "alice-watch", clientKind: "watchos", requestId: "r1" }],
    ] as const) {
      const res = await call(url, method, path, alice.token, body);
      assert.deepEqual([res.status, res.body.error], [401, "session-ended"], `${method} ${path}`);
    }
    assert.equal((await call(url, "POST", "/v2/auth/refresh", alice.token)).status, 401);

    // Signing in again on the device replaces the session, so the old token stops working too.
    const first = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const second = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal((await call(url, "GET", "/v2/me", first.token)).status, 401);
    assert.equal((await call(url, "GET", "/v2/me", second.token)).status, 200);
  });
});

test("blocking ends a conversation already under way, even mid-burst", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    const aliceWatch = relayClient(url, "alice-watch", watchToken, "watchos");

    // Bob rings, Alice joins, and Bob keeps talking live.
    bobClient.send({ type: "talk-start", to: alice.user.id, burstId: "b1", codec: "pcm16le16k" });
    const { conversationId } = await bobClient.waitFor("floor-granted");
    await aliceWatch.connect(conversationId, undefined, ringIn(pusher, WATCH).ringId);
    await aliceWatch.waitFor("burst-start");
    bobClient.sendFrame(Codec.pcm16le16k, 0, Buffer.alloc(640, 1));
    while (aliceWatch.frames.length < 1) await sleep(5);

    // Alice blocks him. His audio is checked again (every frame here, with no grace period),
    // the conversation ends for both, and nothing more reaches her.
    assert.equal((await call(url, "POST", "/v2/blocks", alice.token, { userId: bob.user.id })).status, 200);
    bobClient.sendFrame(Codec.pcm16le16k, 1, Buffer.alloc(640, 1));
    assert.equal((await bobClient.waitFor("talk-refused")).reason, "not-friends");
    assert.equal((await aliceWatch.waitFor("conversation-ended")).conversationId, conversationId);
    const heard = aliceWatch.frames.length;
    for (let seq = 2; seq < 5; seq++) bobClient.sendFrame(Codec.pcm16le16k, seq, Buffer.alloc(640, 1));
    await sleep(50);
    assert.equal(aliceWatch.frames.length, heard);

    // And a new Talk from him is refused.
    bobClient.send({ type: "talk-start", to: alice.user.id, burstId: "b2", codec: "pcm16le16k" });
    assert.equal((await bobClient.waitFor("talk-refused", (m) => m.burstId === "b2")).reason, "not-friends");
    bobClient.close();
    aliceWatch.close();
  }, { authTtlMs: 0 });
});

test("unfriending ends the conversation at the next Talk, whoever talks", async () => {
  await withApi(async ({ url, pusher }) => {
    const { alice, watchToken, bob } = await twoDevices(url);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    const aliceWatch = relayClient(url, "alice-watch", watchToken, "watchos");
    const { conversationId } = await bobClient.talk(alice.user.id, pcm(2), { realtime: false });
    await aliceWatch.connect(conversationId, undefined, ringIn(pusher, WATCH).ringId);
    await aliceWatch.waitFor("burst-end");

    assert.equal((await call(url, "DELETE", `/v2/friends/${bob.user.id}`, alice.token)).status, 200);
    aliceWatch.send({ type: "talk-start", to: bob.user.id, burstId: "a1", codec: "pcm16le16k" });
    assert.equal((await aliceWatch.waitFor("talk-refused")).reason, "not-friends");
    assert.equal((await bobClient.waitFor("conversation-ended")).conversationId, conversationId);
    bobClient.close();
    aliceWatch.close();
  }, { authTtlMs: 0 });
});

// APNs says a token is unregistered.
class RejectingPusher extends DryRunPusher {
  private dead: string;
  constructor(dead: string) {
    super();
    this.dead = dead;
  }
  override async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    const result = await super.sendAlert(token, env, push);
    return token === this.dead ? { ok: false, status: 410, reason: "Unregistered", latencyMs: 1, dryRun: false } : result;
  }
}

test("a watch APNs no longer knows is unregistered, and the iPhone rings instead", async () => {
  const pusher = new RejectingPusher("dead-watch-token");
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watchToken = await watchFor(url, alice.token, "alice-watch");
    await register(url, watchToken, alertTo("dead-watch-token"));
    await register(url, alice.token, pushToTalk(PHONE));
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();

    const ring = await bobClient.talk(alice.user.id, pcm(1), { realtime: false });
    assert.equal(ring.pushed, true);
    assert.deepEqual(pusher.sent.map((p) => [p.pushType ?? "alert", p.token]), [["alert", "dead-watch-token"], ["pushtotalk", PHONE]]);
    await sleep(20);
    assert.deepEqual((await call(url, "GET", "/v2/me", alice.token)).body.formFactors, ["phone"]);
    bobClient.close();
  }, { pusher });
});

test("when APNs turns away the only device, the sender hears nobody can be rung", async () => {
  const pusher = new RejectingPusher("dead-phone-token");
  await withApi(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    await register(url, alice.token, pushToTalk("dead-phone-token"));
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const bobClient = relayClient(url, "bob", bob.token, "ios");
    await bobClient.connect();
    bobClient.send({ type: "talk-start", to: alice.user.id, burstId: "b1", codec: "pcm16le16k" });
    assert.equal((await bobClient.waitFor("talk-refused")).reason, "unavailable");
    bobClient.close();
  }, { pusher });
});
