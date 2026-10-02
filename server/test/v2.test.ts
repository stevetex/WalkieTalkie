// The contract end to end (contracts/README.md): the account API and the relay together, as
// the apps use them. Rings, one device at a time, answers that claim a ring, stale rings, codec
// admission, session revocation at the relay, and synthetic Android peers (Google dev accounts,
// the FCM stub).

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DryRunPusher, type AlertPush, type ApnsEnvironment, type PushResult } from "../src/apns.ts";
import { Codec } from "../src/protocol.ts";
import { SpikeClient } from "../tools/client.ts";
import { SchemaSet } from "./json-schema.ts";
import { call, clientHeaders, pcm, withServer } from "./harness.ts";

const contracts = join(import.meta.dirname!, "..", "..", "contracts");
const schemas = new SchemaSet(join(contracts, "schemas"));

function valid(schema: string, value: unknown): void {
  assert.deepEqual(schemas.validate(schema, value), [], `${schema}: ${JSON.stringify(value)}`);
}

async function signIn(url: string, sub: string, name: string, deviceId: string, provider: "apple" | "google" = "apple") {
  const res = await call(url, "POST", `/v2/auth/${provider}`, null, { identityToken: sub, nonce: "n", name, deviceId, clientKind: provider === "apple" ? "ios" : "android" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  valid("session.schema.json", res.body);
  return res.body as { token: string; expiresAt: number; user: { id: string; name: string; signInProvider: string }; created: boolean };
}

async function befriend(url: string, inviterToken: string, inviteeToken: string) {
  const invite = await call(url, "POST", "/v2/invites", inviterToken);
  assert.equal(invite.status, 200);
  assert.equal((await call(url, "POST", `/v2/invites/${invite.body.code}/accept`, inviteeToken)).status, 200);
}

async function watchFor(url: string, phoneToken: string, deviceId: string, requestId = "req-1") {
  const res = await call(url, "POST", "/v2/auth/device", phoneToken, { deviceId, clientKind: "watchos", requestId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  valid("session.schema.json", res.body);
  return res.body as { token: string; deviceId: string; parentDeviceId: string };
}

const apnsAlert = (token: string) => ({ clientKind: "watchos", delivery: { provider: "apns", mode: "alert", token, environment: "sandbox" }, availability: { enabled: true, notifications: "authorized" } });
const apnsPtt = (token: string) => ({ clientKind: "ios", delivery: { provider: "apns", mode: "pushtotalk", token, environment: "sandbox" } });

// The ring envelope in the newest push to this token.
function pushedRing(pusher: DryRunPusher, token: string): Record<string, unknown> {
  const push = pusher.sent.filter((p) => p.token === token).at(-1);
  assert.ok(push, `no push to ${token}`);
  return push.payload as Record<string, unknown>;
}

function realOpus(): Buffer[] {
  const { frames } = JSON.parse(readFileSync(join(contracts, "fixtures", "frames.json"), "utf8")) as { frames: Array<{ name: string; hex: string }> };
  return frames.filter((f) => f.name.startsWith("opus-apple-")).map((f) => Buffer.from(f.hex, "hex").subarray(5));
}

test("config is public, cacheable and follows its schema", async () => {
  await withServer(async ({ url }) => {
    const res = await call(url, "GET", "/v2/config", null);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") ?? "", /public, max-age=300/);
    valid("config.schema.json", res.body);
    assert.deepEqual(res.body.api.versions, [2]);
    assert.deepEqual(res.body.relay.protocols, [2]);
    assert.deepEqual(res.body.features, { googleSignIn: true, fcmDelivery: true });
    assert.deepEqual(res.body.compatibility.minimumBuilds, { ios: 160 });
  }, { minimumBuilds: { ios: 160 } });
});

test("sign-in, the account and its preferences", async () => {
  await withServer(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal(alice.user.signInProvider, "apple");
    const me = await call(url, "GET", "/v2/me", alice.token);
    valid("me.schema.json", me.body);
    assert.deepEqual(me.body.formFactors, []);
    // Apple signs in iPhones only.
    const watch = await call(url, "POST", "/v2/auth/apple", null, { identityToken: "apple.alice", nonce: "n", deviceId: "w", clientKind: "watchos" });
    assert.equal(watch.body.error, "unsupported-client-kind");
    // Ring Me On: set, read back, changed, and back to automatic.
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: "phone" })).body.preferredFormFactor, "phone");
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.preferredFormFactor, "phone");
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: "watch" })).body.preferredFormFactor, "watch");
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.preferredFormFactor, "watch");
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: null })).body.preferredFormFactor, undefined);
    assert.equal((await call(url, "PATCH", "/v2/me", alice.token, { preferredFormFactor: "glasses" })).body.error, "bad-preferred-form-factor");
    // Friends and invites follow their schemas.
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const friends = await call(url, "GET", "/v2/friends", alice.token);
    valid("friends.schema.json", friends.body);
    assert.deepEqual(friends.body.friends.map((f: { name: string }) => f.name), ["Bob"]);
  });
});

test("Google accounts are separate from Apple ones, and off until enabled", async () => {
  await withServer(async ({ url }) => {
    const apple = await signIn(url, "same-subject", "On iPhone", "phone-1");
    const google = await signIn(url, "same-subject", "On Android", "pixel-1", "google");
    assert.notEqual(google.user.id, apple.user.id);
    assert.equal(google.user.signInProvider, "google");
    // A Google account deletes with Google's proof only.
    const wrong = await call(url, "DELETE", "/v2/me", google.token, { proof: { provider: "apple", authorizationCode: "code:same-subject" } });
    assert.deepEqual([wrong.status, wrong.body.error], [400, "wrong-provider"]);
    const other = await call(url, "DELETE", "/v2/me", google.token, { proof: { provider: "google", identityToken: "someone-else", nonce: "n" } });
    assert.equal(other.body.error, "wrong-google-account");
    assert.equal((await call(url, "DELETE", "/v2/me", google.token, { proof: { provider: "google", identityToken: "same-subject", nonce: "n" } })).status, 200);
    assert.equal((await call(url, "GET", "/v2/me", apple.token)).status, 200);
  });
  await withServer(async ({ url }) => {
    const res = await call(url, "POST", "/v2/auth/google", null, { identityToken: "g", nonce: "n", deviceId: "pixel-1", clientKind: "android" });
    assert.deepEqual([res.status, res.body.error, res.body.provider], [503, "provider-unavailable", "google"]);
    assert.equal((await call(url, "GET", "/v2/config", null)).body.features.googleSignIn, false);
  }, { google: false });
});

test("deletion needs the account's own provider's proof", async () => {
  await withServer(async ({ url }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    assert.equal((await call(url, "DELETE", "/v2/me", alice.token, {})).body.error, "proof-required");
    assert.equal((await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "google", identityToken: "t", nonce: "n" } })).body.error, "wrong-provider");
    assert.equal((await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "apple", authorizationCode: "code:apple.bob" } })).body.error, "wrong-apple-id");
    assert.equal((await call(url, "DELETE", "/v2/me", alice.token, { proof: { provider: "apple", authorizationCode: "code:apple.alice" } })).status, 200);
    assert.equal((await call(url, "GET", "/v2/me", alice.token)).body.error, "session-ended");
  });
});

test("device registrations follow the contract, and refused ones match the rejected examples", async () => {
  await withServer(async ({ url }) => {
    const phone = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watch = await watchFor(url, phone.token, "alice-watch");
    const res = await call(url, "PUT", "/v2/me/device", phone.token, { ...apnsPtt("cc".repeat(32)), capabilities: { relayProtocols: [2, 9], decode: ["opus16k", "pcm16le16k", "lyra"], encode: ["opus16k"] }, build: "170" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    valid("device.schema.json", res.body);
    assert.equal(res.body.device.receiveMode, "automatic");
    assert.deepEqual(res.body.device.capabilities.decode, ["opus16k", "pcm16le16k"]);
    assert.deepEqual(res.body.device.capabilities.relayProtocols, [2]);
    assert.equal((await call(url, "PUT", "/v2/me/device", watch.token, apnsAlert("ab".repeat(32)))).status, 200);
    assert.deepEqual((await call(url, "GET", "/v2/me", phone.token)).body.formFactors, ["phone", "watch"]);
    // A watch session can't register as a phone.
    assert.equal((await call(url, "PUT", "/v2/me/device", watch.token, apnsPtt("cc".repeat(32)))).body.error, "client-kind-mismatch");
    // The contract's rejected requests, on the session of the kind they name.
    const manifest = JSON.parse(readFileSync(join(contracts, "examples", "manifest.json"), "utf8")) as { examples: Array<{ file: string; schema: string; serverError?: string }> };
    for (const entry of manifest.examples.filter((e) => e.file.startsWith("rejected/") && e.schema === "device-registration.schema.json")) {
      const body = JSON.parse(readFileSync(join(contracts, "examples", entry.file), "utf8"));
      const token = body.clientKind === "watchos" ? watch.token : phone.token;
      const refused = await call(url, "PUT", "/v2/me/device", token, body);
      assert.equal(refused.body.error, entry.serverError, `${entry.file}: ${JSON.stringify(refused.body)}`);
    }
    for (const file of ["rejected/me-patch-unknown-form-factor.json", "rejected/companion-phone-kind.json"]) {
      const entry = manifest.examples.find((e) => e.file === file)!;
      const body = JSON.parse(readFileSync(join(contracts, "examples", file), "utf8"));
      const refused = file.includes("me-patch") ? await call(url, "PATCH", "/v2/me", phone.token, body) : await call(url, "POST", "/v2/auth/device", phone.token, body);
      assert.equal(refused.body.error, entry.serverError, file);
    }
    // As in production: the test delivery is refused (the harness turns it on for its bots).
  }, { api: { deliveryPolicy: { fcm: true, testDelivery: false } } });
});

test("a watch's session ends with its phone's, at the API and the relay, even mid-conversation", async () => {
  await withServer(async ({ url }) => {
    const phone = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watch = await watchFor(url, phone.token, "alice-watch");
    // The same request again gets the same session.
    const again = await watchFor(url, phone.token, "alice-watch");
    assert.equal((await call(url, "GET", "/v2/me", watch.token)).status, 200);
    assert.equal((await call(url, "GET", "/v2/me", again.token)).status, 200);
    // A watch can't make sessions.
    assert.equal((await call(url, "POST", "/v2/auth/device", watch.token, { deviceId: "w2", clientKind: "watchos", requestId: "x" })).body.error, "unsupported-client-kind");
    const listening = new SpikeClient({ server: url, userId: "x", token: watch.token, transport: "http", clientKind: "watchos" });
    await listening.connect();
    // The phone signs out: the watch's next request, and its open stream, end.
    assert.equal((await call(url, "POST", "/v2/auth/signout", phone.token)).status, 200);
    assert.equal((await call(url, "GET", "/v2/me", watch.token)).body.error, "session-ended");
    await listening.waitFor("session-ended", () => true, 3000);
    listening.close();
    const stream = await fetch(new URL("/v2/relay/stream", url), { headers: { authorization: `Bearer ${watch.token}`, ...clientHeaders("watchos") } });
    assert.deepEqual([stream.status, (await stream.json()).error], [401, "session-ended"]);
  }, { sessionCheckMs: 100 });
});

test("relay admission refuses what the device can't speak, on both transports", async () => {
  await withServer(async ({ url, server }) => {
    const phone = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const stream = (headers: Record<string, string>) =>
      call(url, "GET", "/v2/relay/stream", phone.token, undefined, headers).catch((err) => ({ status: 0, body: { error: String(err) } }));
    assert.equal((await stream({})).body.error, "bad-request");
    const old = await stream({ ...clientHeaders("ios"), "x-oao-relay-protocol": "3" });
    assert.deepEqual([old.status, old.body.error, old.body.supported], [409, "unsupported-protocol", { relayProtocols: [2] }]);
    const outdated = await stream(clientHeaders("ios", "100"));
    assert.deepEqual([outdated.status, outdated.body.error, outdated.body.minimumBuild], [409, "client-upgrade-required", 160]);
    const noCodec = await stream({ ...clientHeaders("ios"), "x-oao-decode": "lyra" });
    assert.deepEqual([noCodec.status, noCodec.body.error], [409, "unsupported-codec"]);
    assert.equal((await stream(clientHeaders("watchos"))).body.error, "client-kind-mismatch");
    // The same refusal, as the WebSocket's answer to the upgrade.
    const upgrade = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = request({ port: server.port, path: "/v2/relay", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", authorization: `Bearer ${phone.token}`, ...clientHeaders("ios", "100") } });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.end();
    });
    assert.equal(upgrade.status, 409);
    assert.equal(JSON.parse(upgrade.body).error, "client-upgrade-required");
  }, { minimumBuilds: { ios: 160 } });
});

test("a ring has an ID and a deadline, one device rings, and an answer claims it", async () => {
  await withServer(async ({ url, pusher }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watch = await watchFor(url, alice.token, "alice-watch");
    await call(url, "PUT", "/v2/me/device", watch.token, apnsAlert("aa".repeat(32)));
    await call(url, "PUT", "/v2/me/device", alice.token, apnsPtt("bb".repeat(32)));
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);

    const bobRelay = new SpikeClient({ server: url, userId: "x", token: bob.token, clientKind: "ios" });
    await bobRelay.connect();
    const { conversationId, pushed } = await bobRelay.talk(alice.user.id, pcm(10), { realtime: false });
    assert.equal(pushed, true);
    // The watch rang (the default), and only the watch.
    assert.deepEqual(pusher.sent.map((p) => p.token), ["aa".repeat(32)]);
    const ring = pushedRing(pusher, "aa".repeat(32));
    valid("ring.schema.json", ring);
    assert.equal(ring.conversationId, conversationId);
    assert.equal(Number(ring.expiresAt) - Number(ring.pushSentAt), 35_000);
    const ringId = String(ring.ringId);

    const pending = await call(url, "GET", "/v2/rings/pending", watch.token, undefined, clientHeaders("watchos"));
    valid("pending-rings.schema.json", pending.body);
    assert.deepEqual(pending.body.rings.map((r: { ringId: string }) => r.ringId), [ringId]);
    // Ring calls need admission too.
    assert.equal((await call(url, "GET", "/v2/rings/pending", watch.token)).body.error, "bad-request");
    // A ring that isn't this conversation's is expired.
    const wrong = await call(url, "POST", "/v2/rings/answer", watch.token, { conversationId, ringId: "r_notTheRing" }, clientHeaders("watchos"));
    assert.deepEqual([wrong.status, wrong.body.error], [410, "ring-expired"]);
    // The prefetch, for this ring.
    const audio = await fetch(new URL(`/v2/rings/audio?conversationId=${conversationId}&ringId=${ringId}`, url), { headers: { authorization: `Bearer ${watch.token}`, ...clientHeaders("watchos") } });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("x-ring-id"), ringId);
    assert.equal(audio.headers.get("x-frames"), "10");
    // The watch answers: it has the ring. The phone can't answer it too.
    const answer = await call(url, "POST", "/v2/rings/answer", watch.token, { conversationId, ringId }, clientHeaders("watchos"));
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    valid("ring.schema.json", answer.body.ring);
    assert.equal((await call(url, "POST", "/v2/rings/answer", watch.token, { conversationId, ringId }, clientHeaders("watchos"))).status, 200);
    const phoneAnswer = await call(url, "POST", "/v2/rings/answer", alice.token, { conversationId, ringId }, clientHeaders("ios"));
    assert.deepEqual([phoneAnswer.status, phoneAnswer.body.error], [409, "ring-answered-elsewhere"]);
    // The phone's join gives way to the watch, which joins with the ring and hears the message.
    const phoneRelay = new SpikeClient({ server: url, userId: "x", token: alice.token, transport: "http", clientKind: "ios" });
    await phoneRelay.connect(conversationId, undefined, ringId);
    await phoneRelay.waitFor("moved");
    phoneRelay.close();
    const watchRelay = new SpikeClient({ server: url, userId: "x", token: watch.token, transport: "http", clientKind: "watchos" });
    await watchRelay.connect(conversationId, undefined, ringId);
    const joined = await watchRelay.waitFor("joined");
    valid("relay-server-message.schema.json", joined);
    assert.equal(joined.ringId, ringId);
    const start = await watchRelay.waitFor("burst-start");
    assert.equal(start.codec, "pcm16le16k");
    await watchRelay.waitFor("burst-end");
    assert.equal(watchRelay.frames.length, 10);
    // Answered and joined: no longer pending; declining it now is harmless.
    assert.deepEqual((await call(url, "GET", "/v2/rings/pending", watch.token, undefined, clientHeaders("watchos"))).body.rings, []);
    assert.equal((await call(url, "POST", "/v2/rings/decline", watch.token, { conversationId, ringId }, clientHeaders("watchos"))).status, 200);
    bobRelay.close();
    watchRelay.close();
  });
});

test("a late tap on an old ring can't hear or join a newer one", async () => {
  await withServer(async ({ url, pusher }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watch = await watchFor(url, alice.token, "alice-watch");
    await call(url, "PUT", "/v2/me/device", watch.token, apnsAlert("aa".repeat(32)));
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const bobRelay = new SpikeClient({ server: url, userId: "x", token: bob.token, clientKind: "ios" });
    await bobRelay.connect();
    const first = await bobRelay.talk(alice.user.id, pcm(5), { realtime: false });
    const oldRing = String(pushedRing(pusher, "aa".repeat(32)).ringId);
    // Nobody answers: the ring runs out and its audio goes. Bob is still in the conversation.
    await bobRelay.waitFor("ring-timeout");
    assert.equal((await call(url, "POST", "/v2/rings/answer", watch.token, { conversationId: first.conversationId, ringId: oldRing }, clientHeaders("watchos"))).body.error, "ring-expired");
    // Bob talks again: the same conversation, a new ring.
    const second = await bobRelay.talk(alice.user.id, pcm(7), { realtime: false });
    assert.equal(second.conversationId, first.conversationId);
    const newRing = String(pushedRing(pusher, "aa".repeat(32)).ringId);
    assert.notEqual(newRing, oldRing);
    // The old notification's tap: expired, and nothing plays.
    const late = new SpikeClient({ server: url, userId: "x", token: watch.token, transport: "http", clientKind: "watchos" });
    await late.connect(first.conversationId, undefined, oldRing);
    assert.equal((await late.waitFor("error")).code, "ring-expired");
    assert.equal((await fetch(new URL(`/v2/rings/audio?conversationId=${first.conversationId}&ringId=${oldRing}`, url), { headers: { authorization: `Bearer ${watch.token}`, ...clientHeaders("watchos") } })).status, 410);
    // Nor can a join without a ring take the newer one.
    late.send({ type: "join", conversationId: first.conversationId });
    assert.equal((await late.waitFor("error")).code, "ring-expired");
    assert.equal(late.frames.length, 0);
    // The new ring's own join hears it.
    late.send({ type: "join", conversationId: first.conversationId, ringId: newRing });
    await late.waitFor("burst-end");
    assert.equal(late.frames.length, 7);
    late.close();
    bobRelay.close();
  }, { ringTimeoutMs: 300 });
});

test("the one device that rings: most recently used first, the next only after a definite rejection", async () => {
  const pusher = new (class extends DryRunPusher {
    async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
      const result = await super.sendAlert(token, env, push);
      if (token.startsWith("dead")) return { ok: false, status: 410, reason: "Unregistered", latencyMs: 1, dryRun: false };
      if (token.startsWith("slow")) return { ok: false, status: 0, reason: "timeout", latencyMs: 1, dryRun: false };
      return result;
    }
  })();
  await withServer(async ({ url, accounts }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const older = await watchFor(url, alice.token, "watch-old", "a");
    const newer = await watchFor(url, alice.token, "watch-new", "b");
    await call(url, "PUT", "/v2/me/device", older.token, apnsAlert("11".repeat(32)));
    await call(url, "PUT", "/v2/me/device", newer.token, apnsAlert("dead".repeat(16)));
    await accounts.markActive(alice.user.id, "watch-new", Date.now() + 1000);
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const bobRelay = new SpikeClient({ server: url, userId: "x", token: bob.token, clientKind: "ios" });
    await bobRelay.connect();
    // The newer watch's token is dead: it's removed, and only then the older watch rings.
    await bobRelay.talk(alice.user.id, pcm(3), { realtime: false });
    assert.deepEqual(pusher.sent.map((p) => p.token), ["dead".repeat(16), "11".repeat(32)]);
    assert.deepEqual((await accounts.devices(alice.user.id)).map((d) => d.id), ["watch-old"]);
    bobRelay.close();

    // An ambiguous failure isn't a rejection: nothing else rings for it.
    pusher.sent.length = 0;
    await call(url, "PUT", "/v2/me/device", newer.token, apnsAlert("slow".repeat(16)));
    await accounts.markActive(alice.user.id, "watch-new", Date.now() + 120_000);
    const carol = await signIn(url, "apple.carol", "Carol", "carol-phone");
    await befriend(url, alice.token, carol.token);
    const carolRelay = new SpikeClient({ server: url, userId: "x", token: carol.token, clientKind: "ios" });
    await carolRelay.connect();
    const { pushed } = await carolRelay.talk(alice.user.id, pcm(3), { realtime: false });
    assert.equal(pushed, true);
    assert.deepEqual(pusher.sent.map((p) => p.token), ["slow".repeat(16)]);
    carolRelay.close();
  }, { pusher });
});

test("a watch with notifications off isn't rung; the phone is", async () => {
  await withServer(async ({ url, pusher }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const watch = await watchFor(url, alice.token, "alice-watch");
    await call(url, "PUT", "/v2/me/device", watch.token, { ...apnsAlert("aa".repeat(32)), availability: { notifications: "denied" } });
    await call(url, "PUT", "/v2/me/device", alice.token, apnsPtt("bb".repeat(32)));
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    const bobRelay = new SpikeClient({ server: url, userId: "x", token: bob.token, clientKind: "ios" });
    await bobRelay.connect();
    await bobRelay.talk(alice.user.id, pcm(3), { realtime: false });
    assert.deepEqual(pusher.sent.map((p) => [p.token, p.pushType]), [["bb".repeat(32), "pushtotalk"]]);
    const ptt = pushedRing(pusher, "bb".repeat(32));
    valid("ring.schema.json", ptt);
    valid("ring.schema.json", (ptt as { aps: unknown }).aps);
    bobRelay.close();
  });
});

test("codec admission: nobody is sent, or rung for, a codec they can't play", async () => {
  await withServer(async ({ url, pusher }) => {
    const alice = await signIn(url, "apple.alice", "Alice", "alice-phone");
    const bob = await signIn(url, "apple.bob", "Bob", "bob-phone");
    await befriend(url, alice.token, bob.token);
    // Alice's only device plays PCM alone, and is rung in the app.
    await call(url, "PUT", "/v2/me/device", alice.token, { clientKind: "ios", delivery: { provider: "relay", mode: "foreground" }, capabilities: { decode: ["pcm16le16k"], encode: ["pcm16le16k"] } });
    const bobRelay = new SpikeClient({ server: url, userId: "x", token: bob.token, clientKind: "ios" });
    await bobRelay.connect();
    // Ringing her with Opus is refused before anything rings.
    await assert.rejects(bobRelay.talkFrames(alice.user.id, { codec: Codec.opus16k, frames: realOpus() }, { realtime: false }), /unavailable|unsupported-codec/);
    const aliceRelay = new SpikeClient({ server: url, userId: "x", token: alice.token, clientKind: "ios", decode: ["pcm16le16k"] });
    await aliceRelay.connect();
    await assert.rejects(bobRelay.talkFrames(alice.user.id, { codec: Codec.opus16k, frames: realOpus() }, { realtime: false }), /unsupported-codec/);
    assert.equal(pusher.sent.length, 0);
    // PCM rings her in the app; she answers with the ring's ID.
    const { conversationId } = await bobRelay.talk(alice.user.id, pcm(2), { realtime: false });
    const ring = await aliceRelay.waitFor("ring");
    valid("relay-server-message.schema.json", ring);
    aliceRelay.send({ type: "join", conversationId, ringId: ring.ringId } as never);
    await aliceRelay.waitFor("joined");
    await aliceRelay.waitFor("burst-end");
    // She's listening: Opus is refused at talk-start, and Opus frames in a PCM burst are dropped.
    await assert.rejects(bobRelay.talkFrames(alice.user.id, { codec: Codec.opus16k, frames: realOpus() }, { realtime: false }), /unsupported-codec/);
    const burstId = "mixed-burst";
    bobRelay.send({ type: "talk-start", to: alice.user.id, burstId, codec: "pcm16le16k" } as never);
    await bobRelay.waitFor("floor-granted", (m) => m.burstId === burstId);
    const before = aliceRelay.frames.length;
    bobRelay.sendFrame(Codec.pcm16le16k, 0, Buffer.alloc(640, 2));
    bobRelay.sendFrame(Codec.opus16k, 1, realOpus()[0]);
    bobRelay.sendFrame(Codec.pcm16le16k, 2, Buffer.alloc(640, 3));
    bobRelay.send({ type: "talk-end", burstId });
    await aliceRelay.waitFor("burst-end", (m) => m.burstId === burstId);
    assert.deepEqual(aliceRelay.frames.slice(before).map((f) => f[0]), [Codec.pcm16le16k, Codec.pcm16le16k]);
    aliceRelay.close();
    bobRelay.close();
  });
});

test("synthetic Android peers: Google accounts, FCM rings (simulated), and Apple's Opus both ways", async () => {
  await withServer(async ({ url, fcm, pusher }) => {
    const apple = await signIn(url, "apple.alice", "Alice", "alice-phone");
    await call(url, "PUT", "/v2/me/device", apple.token, apnsPtt("bb".repeat(32)));
    const android = await signIn(url, "g.riley", "Riley", "pixel-1", "google");
    const reg = await call(url, "PUT", "/v2/me/device", android.token, { clientKind: "android", delivery: { provider: "fcm", mode: "notification", token: "fcm-pixel-1" }, capabilities: { decode: ["opus16k", "pcm16le16k"], encode: ["opus16k"] } });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.equal(reg.body.device.receiveMode, "tap");
    // A cross-provider invite: friends regardless of provider, and nothing says which.
    await befriend(url, android.token, apple.token);
    const appleFriends = await call(url, "GET", "/v2/friends", apple.token);
    valid("friends.schema.json", appleFriends.body);
    // The iPhone rings the Android phone: the FCM stub has the same envelope.
    const appleRelay = new SpikeClient({ server: url, userId: "x", token: apple.token, clientKind: "ios" });
    await appleRelay.connect();
    const opus = realOpus();
    const { conversationId } = await appleRelay.talkFrames(android.user.id, { codec: Codec.opus16k, frames: opus }, { realtime: false });
    assert.equal(fcm.sent.length, 1);
    valid("ring.schema.json", fcm.sent[0].ring);
    // Android taps the notification: it answers the ring and hears Apple's packets byte for byte.
    const androidRelay = new SpikeClient({ server: url, userId: "x", token: android.token, transport: "http", clientKind: "android" });
    assert.equal((await call(url, "POST", "/v2/rings/answer", android.token, { conversationId, ringId: fcm.sent[0].ring.ringId }, clientHeaders("android"))).status, 200);
    await androidRelay.connect(conversationId, undefined, fcm.sent[0].ring.ringId);
    await androidRelay.waitFor("burst-end");
    assert.deepEqual(androidRelay.frames.map((f) => f.subarray(5).toString("hex")), opus.map((p) => p.toString("hex")));
    // Android replies in Opus; the iPhone plays it.
    await androidRelay.talkFrames(apple.user.id, { codec: Codec.opus16k, frames: opus }, { realtime: false });
    await appleRelay.waitFor("burst-end");
    assert.deepEqual(appleRelay.frames.map((f) => f.subarray(5).toString("hex")), opus.map((p) => p.toString("hex")));
    assert.equal(pusher.sent.length, 0);
    appleRelay.close();
    androidRelay.close();
  });
});
