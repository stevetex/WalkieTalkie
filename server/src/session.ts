// Session tokens: JWTs signed with Ed25519 (alg EdDSA). The account API signs them with the
// private key; relay nodes verify them locally with the public keys, with no session store
// (Hosting, option E). Design decision 2026-09-27: 30-day tokens, refreshed by the apps; the
// refresh endpoint also takes a token up to a year past expiry while its session exists.
//
// Keys are passed as JSON, so Secret Manager can hold them as-is:
//   SESSION_SIGNING_KEY  {"kid":"k1","privateKey":"-----BEGIN PRIVATE KEY-----…"}   (API only)
//   SESSION_PUBLIC_KEYS  {"k1":"-----BEGIN PUBLIC KEY-----…", …}                  (API and nodes)
// More than one public key lets a new signing key roll out before the old one is retired.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// How long past expiry a token can still be refreshed, if its session record still exists.
export const REFRESH_GRACE_MS = 365 * 24 * 60 * 60 * 1000;

export interface SessionClaims {
  // The account's user ID.
  sub: string;
  // The session, users/{sub}/sessions/{sid}: deleting it stops refreshes.
  sid: string;
  // The device the session belongs to, users/{sub}/devices/{dev}.
  dev: string;
  // Seconds since epoch, as in any JWT.
  iat: number;
  exp: number;
}

export interface SigningKey {
  kid: string;
  privateKey: string;
}

export class SessionError extends Error {
  // "expired" tokens are otherwise valid (the refresh endpoint may still take them).
  reason: "malformed" | "unknown-key" | "bad-signature" | "expired";
  constructor(reason: SessionError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

export class SessionSigner {
  readonly kid: string;
  private key: KeyObject;
  private now: () => number;

  constructor(key: SigningKey, now: () => number = Date.now) {
    this.kid = key.kid;
    this.key = createPrivateKey(key.privateKey);
    if (this.key.asymmetricKeyType !== "ed25519") throw new Error("the session signing key must be Ed25519");
    this.now = now;
  }

  issue(claims: { sub: string; sid: string; dev: string }, ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
    const iat = Math.floor(this.now() / 1000);
    const exp = iat + Math.floor(ttlMs / 1000);
    const header = { alg: "EdDSA", typ: "JWT", kid: this.kid };
    const input = `${base64url(header)}.${base64url({ ...claims, iat, exp })}`;
    const signature = sign(null, Buffer.from(input), this.key).toString("base64url");
    return { token: `${input}.${signature}`, expiresAt: exp * 1000 };
  }

  publicKey(): string {
    return createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
  }
}

export class SessionVerifier {
  private keys = new Map<string, KeyObject>();
  private now: () => number;

  constructor(publicKeys: Record<string, string>, now: () => number = Date.now) {
    for (const [kid, pem] of Object.entries(publicKeys)) {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519") throw new Error(`session public key ${kid} isn't Ed25519`);
      this.keys.set(kid, key);
    }
    this.now = now;
  }

  // The claims of a valid token. A token that expired less than `graceMs` ago also passes
  // (only the refresh endpoint passes a grace period).
  verify(token: string, graceMs = 0): SessionClaims {
    const parts = token.split(".");
    if (parts.length !== 3) throw new SessionError("malformed", "not a JWT");
    const [headerPart, claimsPart, signaturePart] = parts;
    const header = parseJSON(headerPart) as { alg?: unknown; kid?: unknown };
    // Only EdDSA: never let the token pick a weaker algorithm.
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new SessionError("malformed", "unexpected header");
    const key = this.keys.get(header.kid);
    if (!key) throw new SessionError("unknown-key", `unknown key ${header.kid}`);
    const signature = Buffer.from(signaturePart, "base64url");
    if (!verify(null, Buffer.from(`${headerPart}.${claimsPart}`), key, signature)) {
      throw new SessionError("bad-signature", "bad signature");
    }
    const claims = parseJSON(claimsPart) as Partial<SessionClaims>;
    if (
      typeof claims.sub !== "string" || !claims.sub ||
      typeof claims.sid !== "string" || !claims.sid ||
      typeof claims.dev !== "string" || !claims.dev ||
      typeof claims.iat !== "number" || typeof claims.exp !== "number"
    ) {
      throw new SessionError("malformed", "missing claims");
    }
    if (claims.exp * 1000 + graceMs <= this.now()) throw new SessionError("expired", "token expired");
    return claims as SessionClaims;
  }
}

// A fresh key pair, for local runs, tests and tools/session-key.ts.
export function generateSigningKey(kid: string): { signingKey: SigningKey; publicKeys: Record<string, string> } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    signingKey: { kid, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    publicKeys: { [kid]: publicKey.export({ type: "spki", format: "pem" }).toString() },
  };
}

export function parseSigningKey(json: string): SigningKey {
  const key = JSON.parse(json) as Partial<SigningKey>;
  if (typeof key.kid !== "string" || typeof key.privateKey !== "string") {
    throw new Error("SESSION_SIGNING_KEY must be JSON with kid and privateKey");
  }
  return { kid: key.kid, privateKey: key.privateKey };
}

export function parsePublicKeys(json: string): Record<string, string> {
  const keys = JSON.parse(json) as Record<string, unknown>;
  if (!keys || typeof keys !== "object" || !Object.values(keys).every((v) => typeof v === "string")) {
    throw new Error("SESSION_PUBLIC_KEYS must be a JSON object of key ID to PEM");
  }
  return keys as Record<string, string>;
}

// The claims of a JWT without checking its signature (for reading Apple's tokens' headers,
// and for tools).
export function decodeJWT(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new SessionError("malformed", "not a JWT");
  return { header: parseJSON(parts[0]) as Record<string, unknown>, claims: parseJSON(parts[1]) as Record<string, unknown> };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseJSON(part: string): unknown {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new SessionError("malformed", "bad JWT segment");
  }
}
