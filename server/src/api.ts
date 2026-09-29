// The account API (design decision 2026-09-27): Sign in with Apple, sessions, the profile,
// friends, invites, blocks, reports, push registration and account deletion. It runs as its
// own Cloud Run service (api-main.ts), behind overandout.app/v1/* on Firebase Hosting, and
// locally inside the relay's server (main.ts with SERVE_API=1).
//
// Every route except sign-in takes the session token as "Authorization: Bearer <token>".
// Errors are { error: <code>, message } with a stable code the apps can switch on.
//
//   POST   /v1/auth/apple            {identityToken, nonce, name?, deviceId, platform} → session + user
//   POST   /v1/auth/refresh          (a token up to a year past expiry) → {token, expiresAt}
//   POST   /v1/auth/device           {deviceId, platform} → a session for another device (the watch)
//   POST   /v1/auth/signout          ends this session and its device's push registration
//   GET    /v1/me                    → the user, plus platforms: the kinds of device registered for rings
//   PATCH  /v1/me                    {name?, ringOn?: "watch" | "iphone" | null, avatar?: <mascot ID> | null}
//                                     (a mascot replaces the photo, and a new photo replaces the mascot)
//   DELETE /v1/me                    {authorizationCode} → revokes the Apple token, deletes everything
//   PUT    /v1/me/device             {platform, pushToken, pushType?, apnsEnvironment} for this session's
//                                     device; pushType "pushtotalk" = an iPhone's PushToTalk channel token
//   GET    /v1/friends               DELETE /v1/friends/{id}
//   PATCH  /v1/friends/{id}          {favorite: boolean}: the user's star on a friend
//   POST   /v1/invites               → {code, url, expiresAt}
//   GET    /v1/invites/{code}        → who it's from, before accepting
//   POST   /v1/invites/{code}/accept → {friend}
//   DELETE /v1/invites/{code}        (the inviter cancels it)
//   GET    /v1/blocks                POST /v1/blocks {userId}   DELETE /v1/blocks/{id}
//   POST   /v1/reports               {userId, reason, note?, conversationId?, block?}
//   PUT    /v1/me/photo              the profile photo, as an image/jpeg body → {photoVersion}
//   DELETE /v1/me/photo
//   GET    /v1/users/{id}/photo      → image/jpeg: your own photo or a friend's
//   POST   /v1/events                {device?, events: [{name, t, fields?}]} device events outside
//                                     conversations, logged as oao.event (telemetry.ts)
//   POST   /v1/diagnostics           this device's compressed diagnostics log (gzip or raw
//                                     DEFLATE; x-oao-platform, x-oao-build), when GET /v1/me asks
//   POST   /v1/feedback              {note, platform?, build?, conversationId?, diagnostics?} a
//                                     problem report; with diagnostics, the devices' logs follow

import type { IncomingMessage, ServerResponse } from "node:http";
import { AccountError, MAX_DIAGNOSTICS_BYTES, MAX_PHOTO_BYTES, isAvatar, isPlatform, isPushType, type Accounts, type Platform, type User } from "./accounts.ts";
import type { AppleIdentity } from "./apple.ts";
import { REFRESH_GRACE_MS, SessionError, type SessionClaims, type SessionSigner, type SessionVerifier } from "./session.ts";
import { StdoutSink, cleanEvents, type LogSink } from "./telemetry.ts";

export interface ApiOptions {
  accounts: Accounts;
  signer: SessionSigner;
  verifier: SessionVerifier;
  apple: { verify(identityToken: string, nonce: string): Promise<AppleIdentity> };
  // Null when no Sign in with Apple key is configured (local runs): deletion skips revoking.
  revoker: { revokeWithCode(code: string): Promise<{ sub: string }> } | null;
  // Invite links are this plus the code, for example https://overandout.app/i/.
  inviteBaseUrl: string;
  log?: (line: string) => void;
  // Structured telemetry entries (oao.api, oao.event, …); stdout JSON by default (Cloud Run).
  telemetry?: LogSink;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

// Returns true if it handled the request (any /v1/auth, /v1/me, /v1/friends, /v1/invites,
// /v1/blocks or /v1/reports path, or /v1/users/{id}/photo).
export function createApi(options: ApiOptions): ApiHandler {
  const { accounts, signer, verifier } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const telemetry = options.telemetry ?? new StdoutSink();

  // The token's claims, checked only for its signature and expiry. Refresh and sign-out, which
  // check the session themselves, use this directly; every other route uses authorize.
  const authenticate = (req: IncomingMessage, graceMs = 0): SessionClaims => {
    const token = bearer(req);
    if (!token) throw new AccountError(401, "unauthorized");
    try {
      return verifier.verify(token, graceMs);
    } catch (err) {
      if (err instanceof SessionError) throw new AccountError(401, err.reason === "expired" ? "token-expired" : "unauthorized");
      throw err;
    }
  };

  // A valid token whose session is still current: a token kept after signing out (or after
  // the account was deleted) is refused, even before it expires.
  const authorize = async (req: IncomingMessage): Promise<SessionClaims> => {
    const claims = authenticate(req);
    if (!(await accounts.sessionActive(claims.sub, claims.sid, claims.dev))) throw new AccountError(401, "session-ended");
    return claims;
  };

  const issue = (userId: string, sid: string, deviceId: string) => signer.issue({ sub: userId, sid, dev: deviceId });

  // A handler's result: a JSON body, or raw bytes with their content type.
  type Reply = [number, unknown] | [number, { bytes: Buffer; contentType: string; version: number }];
  const routes: Array<[string, RegExp, (req: IncomingMessage, params: string[]) => Promise<Reply>]> = [
    ["POST", /^\/v1\/auth\/apple$/, async (req) => {
      const body = await readBody(req);
      const { identityToken, nonce, name, deviceId, platform } = body;
      if (typeof identityToken !== "string" || typeof nonce !== "string" || typeof deviceId !== "string" || !isPlatform(platform)) {
        throw new AccountError(400, "bad-request", "identityToken, nonce, deviceId and platform are required");
      }
      let identity: AppleIdentity;
      try {
        identity = await options.apple.verify(identityToken, nonce);
      } catch (err) {
        log(`[api] Sign in with Apple rejected: ${(err as Error).message}`);
        throw new AccountError(401, "apple-token-rejected");
      }
      const { user, created } = await accounts.signInWithApple(identity.sub, typeof name === "string" ? name : undefined);
      const sid = await accounts.createSession(user.id, deviceId, platform);
      log(`[api] ${user.id} signed in on a ${platform}${created ? " (new account)" : ""}`);
      return [200, { ...issue(user.id, sid, deviceId), user: userJSON(user), created }];
    }],
    ["POST", /^\/v1\/auth\/refresh$/, async (req) => {
      const claims = authenticate(req, REFRESH_GRACE_MS);
      if (!(await accounts.touchSession(claims.sub, claims.sid, claims.dev))) throw new AccountError(401, "session-ended");
      return [200, issue(claims.sub, claims.sid, claims.dev)];
    }],
    ["POST", /^\/v1\/auth\/device$/, async (req) => {
      const claims = await authorize(req);
      const { deviceId, platform } = await readBody(req);
      if (typeof deviceId !== "string" || !isPlatform(platform)) throw new AccountError(400, "bad-request", "deviceId and platform are required");
      if (deviceId === claims.dev) throw new AccountError(400, "same-device");
      const sid = await accounts.createSession(claims.sub, deviceId, platform);
      log(`[api] ${claims.sub} added a ${platform}`);
      return [200, issue(claims.sub, sid, deviceId)];
    }],
    ["POST", /^\/v1\/auth\/signout$/, async (req) => {
      const claims = authenticate(req, REFRESH_GRACE_MS);
      await accounts.endSession(claims.sub, claims.sid, claims.dev);
      return [200, {}];
    }],
    ["GET", /^\/v1\/me$/, async (req) => {
      const id = (await authorize(req)).sub;
      const [user, platforms] = await Promise.all([accounts.user(id), accounts.platforms(id)]);
      if (!user) throw new AccountError(404, "no-account");
      return [200, { ...userJSON(user), platforms }];
    }],
    ["PATCH", /^\/v1\/me$/, async (req) => {
      const claims = await authorize(req);
      const { name, ringOn, avatar } = await readBody(req);
      if (name === undefined && ringOn === undefined && avatar === undefined) {
        throw new AccountError(400, "bad-request", "name, ringOn or avatar is required");
      }
      if (name !== undefined && typeof name !== "string") throw new AccountError(400, "bad-name");
      if (ringOn !== undefined && ringOn !== null && !isPlatform(ringOn)) throw new AccountError(400, "bad-ring-on");
      let user: User | undefined;
      if (avatar !== undefined && avatar !== null && !isAvatar(avatar)) throw new AccountError(400, "bad-avatar");
      if (typeof name === "string") user = await accounts.rename(claims.sub, name);
      if (ringOn !== undefined) user = await accounts.setRingOn(claims.sub, ringOn as Platform | null);
      if (avatar !== undefined) user = await accounts.setAvatar(claims.sub, avatar as string | null);
      return [200, userJSON(user!)];
    }],
    ["DELETE", /^\/v1\/me$/, async (req) => {
      const claims = await authorize(req);
      const { authorizationCode } = await readBody(req);
      if (options.revoker) {
        if (typeof authorizationCode !== "string" || !authorizationCode) {
          throw new AccountError(400, "authorization-code-required");
        }
        const appleSub = await accounts.appleSub(claims.sub);
        let revoked: { sub: string };
        try {
          revoked = await options.revoker.revokeWithCode(authorizationCode);
        } catch (err) {
          log(`[api] ${claims.sub}: revoking the Apple token failed: ${(err as Error).message}`);
          throw new AccountError(502, "apple-revoke-failed");
        }
        // The code must come from the same Apple ID, or the wrong account's token was revoked.
        if (appleSub && revoked.sub !== appleSub) throw new AccountError(403, "wrong-apple-id");
      } else {
        log(`[api] ${claims.sub}: no Sign in with Apple key configured, so the Apple token isn't revoked`);
      }
      await accounts.deleteAccount(claims.sub);
      log(`[api] ${claims.sub} deleted their account`);
      return [200, {}];
    }],
    ["PUT", /^\/v1\/me\/device$/, async (req) => {
      const claims = await authorize(req);
      const { platform, pushToken, pushType, apnsEnvironment } = await readBody(req);
      if (!isPlatform(platform) || typeof pushToken !== "string" || !pushToken || pushToken.length > 512) {
        throw new AccountError(400, "bad-request", "platform and pushToken are required");
      }
      if (pushType !== undefined && !isPushType(pushType)) throw new AccountError(400, "bad-request", "unknown pushType");
      if (pushType === "pushtotalk" && platform !== "iphone") throw new AccountError(400, "bad-request", "pushtotalk is for iPhones");
      const registration = {
        platform,
        pushToken,
        pushType: pushType ?? "alert",
        apnsEnvironment: apnsEnvironment === "production" ? "production" : "sandbox",
      } as const;
      await accounts.registerDevice(claims.sub, claims.dev, registration);
      // Never the token itself; "app:" is the iPhone reachable only while the app is open.
      telemetry.write({
        kind: "oao.registration",
        userId: claims.sub,
        deviceId: claims.dev,
        platform,
        pushType: registration.pushType,
        apnsEnvironment: registration.apnsEnvironment,
        inApp: pushToken === "app:",
      });
      return [200, {}];
    }],
    ["PUT", /^\/v1\/me\/photo$/, async (req) => {
      const claims = await authorize(req);
      const jpeg = await readBytes(req, MAX_PHOTO_BYTES);
      const photoVersion = await accounts.setPhoto(claims.sub, jpeg);
      log(`[api] ${claims.sub} set a photo (${jpeg.length} bytes)`);
      return [200, { photoVersion }];
    }],
    ["DELETE", /^\/v1\/me\/photo$/, async (req) => {
      await accounts.removePhoto((await authorize(req)).sub);
      return [200, {}];
    }],
    ["GET", /^\/v1\/users\/([\w.-]+)\/photo$/, async (req, [id]) => {
      const { jpeg, version } = await accounts.photo((await authorize(req)).sub, id);
      return [200, { bytes: jpeg, contentType: "image/jpeg", version }];
    }],
    ["GET", /^\/v1\/friends$/, async (req) => [200, { friends: await accounts.friends((await authorize(req)).sub) }]],
    ["PATCH", /^\/v1\/friends\/([\w.-]+)$/, async (req, [id]) => {
      const claims = await authorize(req);
      const { favorite } = await readBody(req);
      if (typeof favorite !== "boolean") throw new AccountError(400, "bad-request", "favorite is required");
      await accounts.setFavorite(claims.sub, id, favorite);
      return [200, {}];
    }],
    ["DELETE", /^\/v1\/friends\/([\w.-]+)$/, async (req, [id]) => {
      await accounts.removeFriend((await authorize(req)).sub, id);
      return [200, {}];
    }],
    ["POST", /^\/v1\/invites$/, async (req) => {
      const { code, expiresAt } = await accounts.createInvite((await authorize(req)).sub);
      return [200, { code, url: `${options.inviteBaseUrl}${code}`, expiresAt }];
    }],
    ["GET", /^\/v1\/invites\/([\w.-]+)$/, async (req, [code]) => [200, await accounts.invite(code, (await authorize(req)).sub)]],
    ["POST", /^\/v1\/invites\/([\w.-]+)\/accept$/, async (req, [code]) => {
      const claims = await authorize(req);
      const friend = await accounts.acceptInvite(code, claims.sub);
      log(`[api] ${claims.sub} and ${friend.id} are friends`);
      return [200, { friend }];
    }],
    ["DELETE", /^\/v1\/invites\/([\w.-]+)$/, async (req, [code]) => {
      await accounts.cancelInvite(code, (await authorize(req)).sub);
      return [200, {}];
    }],
    ["GET", /^\/v1\/blocks$/, async (req) => [200, { blocks: await accounts.blocks((await authorize(req)).sub) }]],
    ["POST", /^\/v1\/blocks$/, async (req) => {
      const claims = await authorize(req);
      const { userId } = await readBody(req);
      await accounts.block(claims.sub, String(userId));
      log(`[api] ${claims.sub} blocked ${userId}`);
      return [200, {}];
    }],
    ["DELETE", /^\/v1\/blocks\/([\w.-]+)$/, async (req, [id]) => {
      await accounts.unblock((await authorize(req)).sub, id);
      return [200, {}];
    }],
    ["POST", /^\/v1\/reports$/, async (req) => {
      const claims = await authorize(req);
      const body = await readBody(req);
      const report = {
        userId: String(body.userId),
        reason: String(body.reason),
        ...(typeof body.note === "string" ? { note: body.note } : {}),
        ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      };
      const id = await accounts.report(claims.sub, report);
      if (body.block === true) await accounts.block(claims.sub, report.userId);
      // A log-based alert on "[report]" emails the operator (deploy/gcp/setup-api.sh).
      log(`[report] ${id}: ${claims.sub} reported ${report.userId} for ${report.reason}${body.block === true ? ", and blocked them" : ""}`);
      return [200, { id }];
    }],
    ["POST", /^\/v1\/events$/, async (req) => {
      const claims = await authorize(req);
      const events = cleanEvents(await readBody(req), { userId: claims.sub, deviceId: claims.dev });
      for (const event of events) telemetry.write(event, WARNING_EVENTS.has(String(event.name)) ? "WARNING" : "INFO");
      return [200, { accepted: events.length }];
    }],
    ["POST", /^\/v1\/diagnostics$/, async (req) => {
      const claims = await authorize(req);
      const gzip = await readBytes(req, MAX_DIAGNOSTICS_BYTES, "diagnostics-too-large");
      const meta = { platform: header(req, "x-oao-platform"), build: header(req, "x-oao-build") };
      const id = await accounts.saveDiagnostics(claims.sub, claims.dev, meta, gzip);
      telemetry.write({ kind: "oao.diagnostics", userId: claims.sub, deviceId: claims.dev, id, bytes: gzip.length, ...meta });
      return [200, { id }];
    }],
    ["POST", /^\/v1\/feedback$/, async (req) => {
      const claims = await authorize(req);
      const body = await readBody(req);
      if (typeof body.note !== "string" || !body.note.trim()) throw new AccountError(400, "bad-request", "note is required");
      const feedback = {
        note: body.note,
        diagnostics: body.diagnostics !== false,
        ...(typeof body.platform === "string" ? { platform: body.platform.slice(0, 16) } : {}),
        ...(typeof body.build === "string" ? { build: body.build.slice(0, 32) } : {}),
        ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
      };
      const id = await accounts.saveFeedback(claims.sub, feedback);
      // A log-based alert on "[feedback]" emails Steve (deploy/gcp/setup-telemetry.sh). The note
      // itself stays in Firestore.
      log(`[feedback] ${id}: ${claims.sub}${feedback.diagnostics ? ", with diagnostics" : ""}`);
      telemetry.write({ kind: "oao.feedback", id, userId: claims.sub, deviceId: claims.dev, diagnostics: feedback.diagnostics, ...(feedback.build ? { build: feedback.build } : {}) }, "WARNING");
      return [200, { id }];
    }],
  ];

  // An error response, as a structured entry: the route's template, never its IDs.
  const logError = (req: IncomingMessage, route: string, status: number, code: string): void => {
    let userId: string | undefined;
    try {
      const token = bearer(req);
      if (token) userId = verifier.verify(token, REFRESH_GRACE_MS).sub;
    } catch {}
    telemetry.write({ kind: "oao.api", method: req.method, route, status, error: code, ...(userId ? { userId } : {}) }, status >= 500 ? "ERROR" : "WARNING");
  };

  return async (req, res, url) => {
    // /v1/users itself is the relay's (diagnostics); only a user's photo is the API's.
    if (!/^\/v1\/(auth|me|friends|invites|blocks|reports|events|diagnostics|feedback)(\/|$)|^\/v1\/users\/[\w.-]+\/photo$/.test(url.pathname)) return false;
    let route = "unmatched";
    try {
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (!match) continue;
        if (req.method !== method) continue;
        route = routeTemplate(pattern);
        const [status, body] = await handler(req, match.slice(1));
        if (isBytes(body)) {
          // Private: only the viewer and their friends may see it, so no shared caches.
          res.writeHead(status, { "content-type": body.contentType, "cache-control": "private, no-cache", etag: `"${body.version}"` });
          res.end(body.bytes);
        } else {
          send(res, status, body);
        }
        return true;
      }
      send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
      logError(req, route, 404, "not-found");
    } catch (err) {
      if (err instanceof AccountError) {
        send(res, err.status, { error: err.code, message: err.message });
        logError(req, route, err.status, err.code);
      } else if (err instanceof SyntaxError) {
        send(res, 400, { error: "bad-json", message: err.message });
        logError(req, route, 400, "bad-json");
      } else {
        log(`[api] ${req.method} ${url.pathname} failed: ${(err as Error).stack ?? err}`);
        send(res, 500, { error: "internal", message: "something went wrong" });
        logError(req, route, 500, "internal");
      }
    }
    return true;
  };
}

// Events that mean something went wrong on a device, so alerts and the dashboard can pick them out.
const WARNING_EVENTS = new Set(["crash", "hang", "uncleanExit", "extensionUnfinished", "pttJoinFailed", "registrationFailed", "sessionRefreshFailed", "relayDropped"]);

// "/^\/v1\/friends\/([\w.-]+)$/" → "/v1/friends/{id}".
function routeTemplate(pattern: RegExp): string {
  return pattern.source.replace(/^\^|\$$/g, "").replace(/\([^)]*\)/g, "{id}").replace(/\\\//g, "/");
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value ? value.replace(/[^\w .()-]/g, "").slice(0, 40) : undefined;
}

function userJSON(user: User): { id: string; name: string; photoVersion?: number; avatar?: string; ringOn?: Platform; diagnosticsRequestedAt?: number } {
  return {
    id: user.id,
    name: user.name,
    ...(user.photoVersion !== undefined ? { photoVersion: user.photoVersion } : {}),
    ...(user.avatar !== undefined ? { avatar: user.avatar } : {}),
    ...(user.ringOn !== undefined ? { ringOn: user.ringOn } : {}),
    ...(user.diagnosticsRequestedAt !== undefined ? { diagnosticsRequestedAt: user.diagnosticsRequestedAt } : {}),
  };
}

function isBytes(body: unknown): body is { bytes: Buffer; contentType: string; version: number } {
  return typeof body === "object" && body !== null && Buffer.isBuffer((body as { bytes?: unknown }).bytes);
}

// Past `max`, the rest is read and dropped (up to 1 MB) so the client sees the 413 rather
// than a reset connection.
async function readBytes(req: IncomingMessage, max: number, tooLarge = "photo-too-large"): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > Math.max(max, 1024 * 1024)) break;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  if (size > max) throw new AccountError(413, tooLarge);
  return Buffer.concat(chunks);
}

export function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() || null : null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new AccountError(413, "body-too-large");
  }
  const body = JSON.parse(raw || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AccountError(400, "bad-json");
  return body as Record<string, unknown>;
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
