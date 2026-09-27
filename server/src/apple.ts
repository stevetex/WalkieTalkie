// Sign in with Apple on the server: verifying the identity token the app gets from
// ASAuthorizationAppleIDCredential, and revoking the user's Apple tokens when they delete
// their account (App Review 5.1.1(v)).
//
// Revoking needs a Sign in with Apple private key from the developer portal (Keys, with
// Sign in with Apple enabled for the app's primary App ID). The app sends a fresh
// authorization code when the user deletes their account; the server exchanges it for a
// refresh token and revokes that, so no Apple tokens are ever stored (design decision
// 2026-09-27).
//
//   APPLE_AUDIENCES   comma-separated bundle IDs whose identity tokens are accepted
//   APPLE_TEAM_ID, APPLE_SIWA_KEY_ID, APPLE_SIWA_KEY (the .p8's text, or APPLE_SIWA_KEY_SECRET)
//                     the Sign in with Apple key, for revocation; if any is missing,
//                     account deletion skips revocation and logs a warning
//   APPLE_CLIENT_ID   the bundle ID the authorization codes come from (default: the first
//                     of APPLE_AUDIENCES)

import { createHash, createPrivateKey, createPublicKey, sign, verify, timingSafeEqual, type JsonWebKey, type KeyObject } from "node:crypto";
import { decodeJWT } from "./session.ts";

const ISSUER = "https://appleid.apple.com";
const KEYS_URL = "https://appleid.apple.com/auth/keys";
const TOKEN_URL = "https://appleid.apple.com/auth/token";
const REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const KEYS_CACHE_MS = 60 * 60 * 1000;

export interface AppleIdentity {
  // Apple's stable user identifier for this developer team.
  sub: string;
  email?: string;
}

export class AppleAuthError extends Error {}

export interface AppleVerifierOptions {
  audiences: string[];
  fetch?: typeof fetch;
  now?: () => number;
  keysUrl?: string;
}

export class AppleVerifier {
  private opts: Required<AppleVerifierOptions>;
  private keys: Map<string, KeyObject> | null = null;
  private keysFetchedAt = 0;

  constructor(options: AppleVerifierOptions) {
    if (!options.audiences.length) throw new Error("AppleVerifier needs at least one audience (bundle ID)");
    this.opts = { fetch, now: Date.now, keysUrl: KEYS_URL, ...options };
  }

  // Checks the token's signature against Apple's published keys, and its issuer, audience,
  // expiry and nonce. `nonce` is the raw value; the app put its SHA-256 (hex) in the request,
  // and Apple copies that into the token, so a token can't be replayed with another nonce.
  async verify(identityToken: string, nonce: string): Promise<AppleIdentity> {
    let decoded: ReturnType<typeof decodeJWT>;
    try {
      decoded = decodeJWT(identityToken);
    } catch {
      throw new AppleAuthError("identity token isn't a JWT");
    }
    const { header, claims } = decoded;
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AppleAuthError("unexpected identity token header");
    const key = await this.key(header.kid);
    const [h, c, s] = identityToken.split(".");
    if (!verify("sha256", Buffer.from(`${h}.${c}`), key, Buffer.from(s, "base64url"))) {
      throw new AppleAuthError("identity token signature doesn't verify");
    }
    if (claims.iss !== ISSUER) throw new AppleAuthError("identity token has the wrong issuer");
    if (typeof claims.aud !== "string" || !this.opts.audiences.includes(claims.aud)) {
      throw new AppleAuthError(`identity token is for ${String(claims.aud)}`);
    }
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= this.opts.now()) throw new AppleAuthError("identity token expired");
    if (typeof claims.sub !== "string" || !claims.sub) throw new AppleAuthError("identity token has no subject");
    const expected = createHash("sha256").update(nonce).digest("hex");
    if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected)) throw new AppleAuthError("identity token nonce doesn't match");
    return { sub: claims.sub, ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
  }

  private async key(kid: string): Promise<KeyObject> {
    const stale = this.opts.now() - this.keysFetchedAt > KEYS_CACHE_MS;
    // An unknown key ID refetches: Apple rotates its keys.
    if (!this.keys || stale || !this.keys.has(kid)) await this.fetchKeys();
    const key = this.keys?.get(kid);
    if (!key) throw new AppleAuthError(`Apple has no key ${kid}`);
    return key;
  }

  private async fetchKeys(): Promise<void> {
    const res = await this.opts.fetch(this.opts.keysUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Apple keys: HTTP ${res.status}`);
    const { keys } = (await res.json()) as { keys: Array<JsonWebKey & { kid: string }> };
    this.keys = new Map(keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })]));
    this.keysFetchedAt = this.opts.now();
  }
}

export interface AppleRevokerOptions {
  teamId: string;
  keyId: string;
  // The Sign in with Apple .p8 key's text.
  privateKey: string;
  clientId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class AppleRevoker {
  private opts: Required<AppleRevokerOptions>;
  private key: KeyObject;

  constructor(options: AppleRevokerOptions) {
    this.opts = { fetch, now: Date.now, ...options };
    this.key = createPrivateKey(options.privateKey);
  }

  // Exchanges a fresh authorization code for the user's refresh token, revokes it, and
  // returns the Apple user it belonged to (so the caller can check it's the right account).
  async revokeWithCode(code: string): Promise<{ sub: string }> {
    const tokens = (await this.post(TOKEN_URL, { code, grant_type: "authorization_code" })) as {
      refresh_token?: string;
      id_token?: string;
    };
    if (!tokens.refresh_token || !tokens.id_token) throw new AppleAuthError("Apple returned no refresh token");
    // The ID token came straight from Apple over TLS, so its subject can be read directly.
    const sub = decodeJWT(tokens.id_token).claims.sub;
    if (typeof sub !== "string") throw new AppleAuthError("Apple's ID token has no subject");
    await this.post(REVOKE_URL, { token: tokens.refresh_token, token_type_hint: "refresh_token" });
    return { sub };
  }

  private async post(url: string, params: Record<string, string>): Promise<unknown> {
    const body = new URLSearchParams({ client_id: this.opts.clientId, client_secret: this.clientSecret(), ...params });
    const res = await this.opts.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    // Apple's errors are codes like invalid_grant; the body never echoes the secrets.
    if (!res.ok) throw new AppleAuthError(`Apple ${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  // An ES256 JWT signed with the Sign in with Apple key, valid for 5 minutes.
  private clientSecret(): string {
    const iat = Math.floor(this.opts.now() / 1000);
    const header = { alg: "ES256", kid: this.opts.keyId };
    const claims = { iss: this.opts.teamId, iat, exp: iat + 300, aud: ISSUER, sub: this.opts.clientId };
    const input = `${b64(header)}.${b64(claims)}`;
    const signature = sign("sha256", Buffer.from(input), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${input}.${signature}`;
  }
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
