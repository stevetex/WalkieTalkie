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
}

// Apple is faked: the identity token is the Apple user ID, and an authorization code
// "code:<sub>" revokes that user's token.
async function withApi(fn: (h: Harness) => Promise<void>): Promise<void> {
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
  const server = await startServer({
    port: 0,
    dataDir: null,
    token: "shared",
    sessions: verifier,
    accounts,
    api,
    pusher: new DryRunPusher(),
  });
  try {
    await fn({ server, url: `http://localhost:${server.port}`, revoked, now, signer });
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
