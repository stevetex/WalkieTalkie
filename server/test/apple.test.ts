import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { AppleAuthError, AppleRevoker, AppleVerifier } from "../src/apple.ts";

// A stand-in for Apple: an RSA key published as a JWKS, and identity tokens signed with it.
function fakeApple() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "apple-1", alg: "RS256", use: "sig" };
  let keyFetches = 0;
  const fetchFn = (async (url: string) => {
    assert.equal(String(url), "https://appleid.apple.com/auth/keys");
    keyFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }));
  }) as typeof fetch;
  const token = (claims: Record<string, unknown>, key: KeyObject = privateKey, kid = "apple-1") => {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${header}.${body}.${sign("sha256", Buffer.from(`${header}.${body}`), key).toString("base64url")}`;
  };
  return { fetchFn, token, keyFetches: () => keyFetches };
}

const now = Date.UTC(2026, 8, 27);
const nonce = "raw-nonce-123";
const hashed = createHash("sha256").update(nonce).digest("hex");
const good = {
  iss: "https://appleid.apple.com",
  aud: "com.cypressoakstudios.overandout",
  exp: now / 1000 + 600,
  iat: now / 1000,
  sub: "001234.abcdef0123456789.0123",
  nonce: hashed,
  email: "x@privaterelay.appleid.com",
};

test("a valid identity token gives the Apple user", async () => {
  const apple = fakeApple();
  const verifier = new AppleVerifier({ audiences: ["com.cypressoakstudios.overandout"], fetch: apple.fetchFn, now: () => now });
  assert.deepEqual(await verifier.verify(apple.token(good), nonce), { sub: good.sub, email: good.email });
  // Keys are cached.
  await verifier.verify(apple.token(good), nonce);
  assert.equal(apple.keyFetches(), 1);
});

test("identity tokens with the wrong audience, issuer, nonce, expiry or signature are rejected", async () => {
  const apple = fakeApple();
  const verifier = new AppleVerifier({ audiences: ["com.cypressoakstudios.overandout"], fetch: apple.fetchFn, now: () => now });
  const reject = (token: string, n = nonce) => assert.rejects(verifier.verify(token, n), AppleAuthError);
  await reject(apple.token({ ...good, aud: "com.example.other" }));
  await reject(apple.token({ ...good, iss: "https://evil.example" }));
  await reject(apple.token({ ...good, exp: now / 1000 - 1 }));
  await reject(apple.token(good), "another-nonce");
  await reject(apple.token({ ...good, nonce: undefined }));
  await reject(apple.token(good, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey));
  await reject(apple.token(good, undefined, "unknown-kid"));
  await reject("garbage");
});

test("deleting an account exchanges the code and revokes the refresh token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const calls: Array<{ url: string; params: URLSearchParams }> = [];
  const idToken = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: good.sub })).toString("base64url")}.sig`;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const params = new URLSearchParams(String(init.body));
    calls.push({ url: String(url), params });
    if (String(url).endsWith("/auth/token")) return new Response(JSON.stringify({ refresh_token: "r-1", id_token: idToken }));
    return new Response("");
  }) as typeof fetch;
  const revoker = new AppleRevoker({
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    clientId: "com.cypressoakstudios.overandout",
    fetch: fetchFn,
    now: () => now,
  });
  assert.deepEqual(await revoker.revokeWithCode("code-1"), { sub: good.sub });
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ["/auth/token", "/auth/revoke"]);
  assert.equal(calls[0].params.get("code"), "code-1");
  assert.equal(calls[0].params.get("grant_type"), "authorization_code");
  assert.equal(calls[1].params.get("token"), "r-1");
  assert.equal(calls[1].params.get("token_type_hint"), "refresh_token");

  // The client secret is an ES256 JWT from the team, about this app, signed with the key.
  const secret = calls[0].params.get("client_secret")!;
  const [h, c, s] = secret.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY1234567" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(claims.sub, "com.cypressoakstudios.overandout");
  assert.equal(claims.aud, "https://appleid.apple.com");
  assert.equal(calls[0].params.get("client_id"), "com.cypressoakstudios.overandout");
});

test("a rejected authorization code fails the revocation", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const revoker = new AppleRevoker({
    teamId: "T",
    keyId: "K",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    clientId: "com.cypressoakstudios.overandout",
    fetch: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch,
  });
  await assert.rejects(revoker.revokeWithCode("stale"), /HTTP 400 .*invalid_grant/);
});
