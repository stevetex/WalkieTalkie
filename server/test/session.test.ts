import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionError, SessionSigner, SessionVerifier, generateSigningKey, parsePublicKeys, parseSigningKey } from "../src/session.ts";

const claims = { sub: "u_alice", sid: "s1", dev: "phone-1" };

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SessionError) return err.reason;
    throw err;
  }
  return "ok";
}

test("a signed token verifies and carries its claims", () => {
  const { signingKey, publicKeys } = generateSigningKey("k1");
  let now = Date.UTC(2026, 8, 27);
  const signer = new SessionSigner(signingKey, () => now);
  const { token, expiresAt } = signer.issue(claims);
  assert.equal(expiresAt, now + 30 * 24 * 60 * 60 * 1000);
  const verifier = new SessionVerifier(publicKeys, () => now);
  const verified = verifier.verify(token);
  assert.equal(verified.sub, "u_alice");
  assert.equal(verified.sid, "s1");
  assert.equal(verified.dev, "phone-1");
  assert.equal(verified.exp * 1000, expiresAt);

  // Expired, but still refreshable inside the grace period.
  now = expiresAt + 1000;
  assert.equal(reason(() => verifier.verify(token)), "expired");
  assert.equal(verifier.verify(token, 365 * 24 * 60 * 60 * 1000).sub, "u_alice");
});

test("tampered, foreign and malformed tokens are rejected", () => {
  const a = generateSigningKey("k1");
  const b = generateSigningKey("k2");
  const token = new SessionSigner(a.signingKey).issue(claims).token;
  const verifier = new SessionVerifier(a.publicKeys);

  const [header, body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: "u_mallory", iat: 1, exp: 9_999_999_999 })).toString("base64url");
  assert.equal(reason(() => verifier.verify(`${header}.${forged}.${signature}`)), "bad-signature");
  assert.equal(reason(() => verifier.verify(new SessionSigner(b.signingKey).issue(claims).token)), "unknown-key");
  // Same key ID, different key.
  const impostor = new SessionSigner({ kid: "k1", privateKey: b.signingKey.privateKey }).issue(claims).token;
  assert.equal(reason(() => verifier.verify(impostor)), "bad-signature");
  // The token can't choose its algorithm.
  const none = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
  assert.equal(reason(() => verifier.verify(`${none}.${body}.`)), "malformed");
  assert.equal(reason(() => verifier.verify("not-a-token")), "malformed");
  assert.equal(reason(() => verifier.verify("a.b.c")), "malformed");
});

test("several public keys allow a key rotation", () => {
  const old = generateSigningKey("k1");
  const next = generateSigningKey("k2");
  const verifier = new SessionVerifier({ ...old.publicKeys, ...next.publicKeys });
  assert.equal(verifier.verify(new SessionSigner(old.signingKey).issue(claims).token).sub, "u_alice");
  assert.equal(verifier.verify(new SessionSigner(next.signingKey).issue(claims).token).sub, "u_alice");
});

test("keys parse from the JSON kept in Secret Manager", () => {
  const { signingKey, publicKeys } = generateSigningKey("k1");
  const signer = new SessionSigner(parseSigningKey(JSON.stringify(signingKey)));
  const verifier = new SessionVerifier(parsePublicKeys(JSON.stringify(publicKeys)));
  assert.equal(verifier.verify(signer.issue(claims).token).dev, "phone-1");
  assert.equal(signer.publicKey(), publicKeys.k1);
  assert.throws(() => parseSigningKey("{}"), /kid and privateKey/);
  assert.throws(() => parsePublicKeys('{"k1": 3}'), /JSON object/);
});
