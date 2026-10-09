// The account API (design decision 2026-09-27): sign-in, sessions, the profile, friends,
// invites, blocks, reports, push registration and account deletion. It runs as its own Cloud
// Run service (api-main.ts), behind overandout.app/v2/* on Firebase Hosting, and locally inside
// the relay's server (main.ts with SERVE_API=1).
//
// The contract is contracts/README.md (Phase 0 of ANDROID_WEAR_OS_PLAN.md): provider-neutral
// identities, client kinds and form factors, explicit deliveries and capabilities,
// provider-tagged deletion proofs, and GET /v2/config.
//
// Every route except sign-in and config takes the session token as "Authorization: Bearer
// <token>". Errors are { error: <code>, message, ...details } with a stable code the apps can
// switch on.
//
//   GET    /v2/config                (no token) supported versions, the relay, features, minimum builds
//   POST   /v2/auth/apple            {identityToken, nonce, name?, deviceId, clientKind: "ios"} → session + user
//   POST   /v2/auth/google           the same with clientKind "android"; 503 provider-unavailable until enabled
//   POST   /v2/auth/refresh          (a token up to a year past expiry) → {token, expiresAt}
//   POST   /v2/auth/device           {deviceId, clientKind, requestId} → a companion session (the watch's)
//   POST   /v2/auth/signout          ends this session and its device's push registration (and a
//                                     phone's companions')
//   GET    /v2/me                    → the user, plus formFactors: the form factors registered for rings
//   PATCH  /v2/me                    {name?, preferredFormFactor?: "phone" | "watch" | null, rollOver?: boolean,
//                                     avatar?: <mascot ID> | null}
//                                     (a mascot replaces the photo, and a new photo replaces the mascot)
//   DELETE /v2/me                    {proof: {provider: "apple", authorizationCode} | {provider: "google", …}}
//   PUT    /v2/me/device             {clientKind, delivery, availability?, capabilities?, clientVersion?, build?}
//                                     for this session's device
//   And, under /v2:
//   GET    /friends                  DELETE /friends/{id}
//   PATCH  /friends/{id}             {favorite: boolean}: the user's star on a friend
//   POST   /invites                  → {code, url, expiresAt}
//   GET    /invites/{code}           → who it's from, before accepting
//   POST   /invites/{code}/accept    → {friend}
//   DELETE /invites/{code}           (the inviter cancels it)
//   GET    /blocks                   POST /blocks {userId}   DELETE /blocks/{id}
//   POST   /reports                  {userId, reason, note?, conversationId?, block?}
//   PUT    /me/photo                 the profile photo, as an image/jpeg body → {photoVersion}
//   DELETE /me/photo
//   GET    /users/{id}/photo         → image/jpeg: your own photo or a friend's
//   POST   /events                   {device?, events: [{name, t, fields?}]} device events outside
//                                     conversations, logged as oao.event (telemetry.ts)
//   POST   /diagnostics              this device's compressed diagnostics log (gzip or raw
//                                     DEFLATE; x-oao-platform or x-oao-client-kind, x-oao-build),
//                                     when GET /me asks
//   POST   /feedback                 {note, platform?, build?, conversationId?, diagnostics?} a
//                                     problem report; with diagnostics, the devices' logs follow

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AccountError,
  MAX_DIAGNOSTICS_BYTES,
  MAX_PHOTO_BYTES,
  isAvatar,
  type AccountDevice,
  type Accounts,
  type SessionRecord,
  type User,
} from "./accounts.ts";
import type { AppleIdentity } from "./apple.ts";
import { REFRESH_GRACE_MS, SessionError, type SessionClaims, type SessionSigner, type SessionVerifier } from "./session.ts";
import { StdoutSink, cleanEvents, type LogSink } from "./telemetry.ts";
import {
  API_VERSIONS,
  AUDIO_FORMATS,
  CODEC_NAMES,
  ContractError,
  RELAY_PROTOCOLS,
  formFactorOf,
  isClientKind,
  isFormFactor,
  isObject,
  parseAvailability,
  parseCapabilities,
  parseDelivery,
  platformLabel,
  type DeliveryPolicy,
  type FormFactor,
  type MinimumBuilds,
  type SignInProvider,
} from "./contract.ts";

export interface IdentityVerifier {
  verify(identityToken: string, nonce: string): Promise<{ sub: string }>;
}

export interface ApiOptions {
  accounts: Accounts;
  signer: SessionSigner;
  verifier: SessionVerifier;
  apple: { verify(identityToken: string, nonce: string): Promise<AppleIdentity> };
  // Null when no Sign in with Apple key is configured (local runs): deletion skips revoking.
  revoker: { revokeWithCode(code: string): Promise<{ sub: string }> } | null;
  // Google sign-in (Phase 2); null = off: /v2/auth/google answers provider-unavailable. Phase 0
  // has only the local test double (DEV_GOOGLE_SIGNIN).
  google?: IdentityVerifier | null;
  // Dev sign-ins ("dev:<name>", local runs only): a watch simulator may sign itself in.
  devSignIn?: boolean;
  // Which deliveries v2 registrations may ask for (FCM and the test routes are off by default).
  deliveryPolicy?: DeliveryPolicy;
  // What GET /v2/config says.
  config?: { relayBaseUrl: string; minimumBuilds?: MinimumBuilds; message?: string | null };
  // Invite links are this plus the code, for example https://overandout.app/i/.
  inviteBaseUrl: string;
  log?: (line: string) => void;
  // Structured telemetry entries (oao.api, oao.event, …); stdout JSON by default (Cloud Run).
  telemetry?: LogSink;
}

export type ApiHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

// A handler's result: a JSON body, or raw bytes with their content type.
type Reply = [number, unknown] | [number, { bytes: Buffer; contentType: string; version: number }] | [number, unknown, Record<string, string>];
type Handler = (req: IncomingMessage, params: string[]) => Promise<Reply>;

const DEFAULT_TIMING = { ringUnansweredMs: 35_000, answerJoinGraceMs: 30_000, conversationIdleMs: 45_000 };

// Returns true if it handled the request (any /v2/auth, /me, /friends, /invites, /blocks,
// /reports, /events, /diagnostics, /feedback or /config path, or /v2/users/{id}/photo).
export function createApi(options: ApiOptions): ApiHandler {
  const { accounts, signer, verifier } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const telemetry = options.telemetry ?? new StdoutSink();
  const policy: DeliveryPolicy = options.deliveryPolicy ?? { fcm: false, testDelivery: false };
  // What people do, for usage analytics (the Beta telemetry spec): the account and the action's
  // fields, never names.
  const act = (action: string, userId: string, fields: Record<string, string | number | boolean | null> = {}) =>
    telemetry.write({ kind: "oao.action", action, userId, ...fields });

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
  // the account was deleted, or its phone signed out) is refused, even before it expires.
  const authorize = async (req: IncomingMessage): Promise<SessionClaims & { session: SessionRecord }> => {
    const claims = authenticate(req);
    const session = await accounts.activeSession(claims.sub, claims.sid, claims.dev);
    if (!session) throw new AccountError(401, "session-ended");
    return { ...claims, session };
  };

  const issue = (userId: string, sid: string, deviceId: string) => signer.issue({ sub: userId, sid, dev: deviceId });

  // Sign-in, for either provider: the identity, the account, and this device's session.
  const signIn = async (req: IncomingMessage, provider: SignInProvider): Promise<Reply> => {
    const { identityToken, nonce, name, deviceId, clientKind } = await readBody(req);
    if (typeof identityToken !== "string" || typeof nonce !== "string" || typeof deviceId !== "string" || !isClientKind(clientKind)) {
      throw new AccountError(400, "bad-request", "identityToken, nonce, deviceId and clientKind are required");
    }
    // A provider signs in its own ecosystem's phone. (A dev sign-in may be a watch simulator,
    // which has no phone to get its session from.)
    const phone = provider === "apple" ? "ios" : "android";
    const devWatch = options.devSignIn && identityToken.startsWith("dev:") && clientKind === (provider === "apple" ? "watchos" : "wearos");
    if (clientKind !== phone && !devWatch) throw new ContractError(400, "unsupported-client-kind", `${provider} signs in ${phone} devices`);
    const identityVerifier = provider === "apple" ? options.apple : options.google;
    if (!identityVerifier) throw new ContractError(503, "provider-unavailable", "Google sign-in isn't available yet", { provider });
    let sub: string;
    try {
      sub = (await identityVerifier.verify(identityToken, nonce)).sub;
    } catch (err) {
      log(`[api] Sign in with ${provider === "apple" ? "Apple" : "Google"} rejected: ${(err as Error).message}`);
      throw new AccountError(401, `${provider}-token-rejected`);
    }
    const { user, created } = await accounts.signIn(provider, sub, typeof name === "string" ? name : undefined);
    const sid = await accounts.createSession(user.id, deviceId, clientKind);
    log(`[api] ${user.id} signed in on ${clientKind}${created ? " (new account)" : ""}`);
    act(created ? "account_created" : "signed_in", user.id, { platform: platformLabel(clientKind), clientKind, provider });
    return [200, { ...issue(user.id, sid, deviceId), user: userJSON(user), created }];
  };

  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/config$/, async () => [200, configJSON(options), { "cache-control": "public, max-age=300" }]],
    ["POST", /^\/auth\/apple$/, (req) => signIn(req, "apple")],
    ["POST", /^\/auth\/google$/, (req) => signIn(req, "google")],
    ["POST", /^\/auth\/refresh$/, async (req) => {
      const claims = authenticate(req, REFRESH_GRACE_MS);
      if (!(await accounts.touchSession(claims.sub, claims.sid, claims.dev))) throw new AccountError(401, "session-ended");
      return [200, issue(claims.sub, claims.sid, claims.dev)];
    }],
    ["POST", /^\/auth\/device$/, async (req) => {
      const claims = await authorize(req);
      const { deviceId, requestId, clientKind: kind } = await readBody(req);
      if (typeof deviceId !== "string" || !isClientKind(kind)) throw new AccountError(400, "bad-request", "deviceId and clientKind are required");
      if (typeof requestId !== "string") throw new AccountError(400, "bad-request", "requestId is required");
      if (deviceId === claims.dev) throw new AccountError(400, "same-device");
      const { sid, clientKind } = await accounts.createCompanionSession(claims.sub, { deviceId: claims.dev, sid: claims.sid }, deviceId, kind, requestId);
      log(`[api] ${claims.sub} added a ${clientKind}`);
      act("device_added", claims.sub, { platform: platformLabel(clientKind), clientKind });
      return [200, { ...issue(claims.sub, sid, deviceId), deviceId, clientKind, parentDeviceId: claims.dev }];
    }],
    ["POST", /^\/auth\/signout$/, async (req) => {
      const claims = authenticate(req, REFRESH_GRACE_MS);
      await accounts.endSession(claims.sub, claims.sid, claims.dev);
      act("signed_out", claims.sub);
      return [200, {}];
    }],
    ["GET", /^\/me$/, async (req) => {
      const id = (await authorize(req)).sub;
      const user = await accounts.user(id);
      if (!user) throw new AccountError(404, "no-account");
      return [200, { ...userJSON(user), formFactors: await accounts.formFactors(id) }];
    }],
    ["PATCH", /^\/me$/, async (req) => {
      const claims = await authorize(req);
      const { name, preferredFormFactor, rollOver, avatar } = await readBody(req);
      if (name === undefined && preferredFormFactor === undefined && rollOver === undefined && avatar === undefined) {
        throw new AccountError(400, "bad-request", "name, preferredFormFactor, rollOver or avatar is required");
      }
      if (name !== undefined && typeof name !== "string") throw new AccountError(400, "bad-name");
      if (preferredFormFactor !== undefined && preferredFormFactor !== null && !isFormFactor(preferredFormFactor)) {
        throw new AccountError(400, "bad-preferred-form-factor");
      }
      if (rollOver !== undefined && typeof rollOver !== "boolean") throw new AccountError(400, "bad-roll-over");
      let user: User | undefined;
      if (avatar !== undefined && avatar !== null && !isAvatar(avatar)) throw new AccountError(400, "bad-avatar");
      if (typeof name === "string") {
        user = await accounts.rename(claims.sub, name);
        act("renamed", claims.sub);
      }
      if (preferredFormFactor !== undefined) {
        user = await accounts.setPreferredFormFactor(claims.sub, preferredFormFactor as FormFactor | null);
        act("ring_on", claims.sub, { preferredFormFactor: user.preferredFormFactor ?? "automatic" });
      }
      if (typeof rollOver === "boolean") {
        user = await accounts.setRollOver(claims.sub, rollOver);
        act("roll_over", claims.sub, { rollOver });
      }
      if (avatar !== undefined) {
        user = await accounts.setAvatar(claims.sub, avatar as string | null);
        act("avatar_set", claims.sub, { avatar: (avatar as string | null) ?? "default" });
      }
      return [200, userJSON(user!)];
    }],
    ["DELETE", /^\/me$/, async (req) => {
      const claims = await authorize(req);
      const { proof } = await readBody(req);
      const identity = await accounts.identity(claims.sub);
      if (!identity) throw new AccountError(404, "no-account");
      await checkDeletionProof(claims.sub, identity, proof);
      await accounts.deleteAccount(claims.sub);
      log(`[api] ${claims.sub} deleted their account`);
      act("account_deleted", claims.sub, { provider: identity.provider });
      return [200, {}];
    }],
    ["PUT", /^\/me\/device$/, async (req) => {
      const claims = await authorize(req);
      const { clientKind, delivery, availability, capabilities, clientVersion, build, e2ee } = await readBody(req);
      if (!isClientKind(clientKind)) throw new AccountError(400, "bad-request", "clientKind is required");
      if (clientKind !== claims.session.clientKind) {
        throw new ContractError(400, "client-kind-mismatch", `this session is for a ${claims.session.clientKind} device`);
      }
      // The request's shape first, so a build that speaks only format 1 is told to update
      // (E2EE_SPEC.md, PR D) before its missing certificates are mentioned.
      const parsedDelivery = parseDelivery(delivery, clientKind, policy);
      const parsedAvailability = parseAvailability(availability);
      const parsedCapabilities = parseCapabilities(capabilities);
      // Every device has its keys: only format 2 is carried, so a device without them could
      // neither send nor play anything.
      const value = e2ee as Record<string, unknown> | undefined;
      const certificate = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").toString("base64") === v;
      if (!value || typeof value !== "object" || Array.isArray(value) || !certificate(value.deviceCert) || !certificate(value.encCert)) {
        throw new ContractError(400, "bad-certificate", "e2ee certificates are required");
      }
      let phoneCert = value.phoneCert;
      if (claims.session.parentDeviceId) {
        const parent = await accounts.device(claims.sub, claims.session.parentDeviceId);
        if (!parent?.e2ee?.phoneCert || (phoneCert !== undefined && phoneCert !== parent.e2ee.phoneCert)) {
          throw new ContractError(400, "bad-certificate", "the companion's phone certificate is unavailable");
        }
        phoneCert = parent.e2ee.phoneCert;
      }
      if (!certificate(phoneCert)) throw new ContractError(400, "bad-certificate", "phone certificate is required");
      const device = await accounts.registerDevice(claims.sub, claims.dev, {
        clientKind,
        delivery: parsedDelivery,
        availability: parsedAvailability,
        capabilities: parsedCapabilities,
        ...(typeof clientVersion === "string" && clientVersion ? { clientVersion: clientVersion.slice(0, 32) } : {}),
        ...(typeof build === "string" && build ? { build: build.slice(0, 32) } : {}),
        e2ee: { phoneCert, deviceCert: value.deviceCert, encCert: value.encCert },
      });
      // Never the token itself; "inApp" is a phone reachable only while the app is open.
      telemetry.write({
        kind: "oao.registration",
        userId: claims.sub,
        deviceId: claims.dev,
        platform: platformLabel(device.clientKind),
        clientKind: device.clientKind,
        formFactor: device.formFactor,
        provider: device.delivery.provider,
        mode: device.delivery.mode,
        pushType: device.delivery.provider === "apns" ? device.delivery.mode : device.delivery.provider,
        apnsEnvironment: device.delivery.provider === "apns" ? device.delivery.environment : null,
        notifications: device.availability.notifications,
        enabled: device.availability.enabled,
        inApp: device.delivery.provider === "relay",
        ...(device.build ? { build: device.build } : {}),
      });
      return [200, { device: deviceJSON(device) }];
    }],
    ["PUT", /^\/me\/photo$/, async (req) => {
      const claims = await authorize(req);
      const jpeg = await readBytes(req, MAX_PHOTO_BYTES);
      const photoVersion = await accounts.setPhoto(claims.sub, jpeg);
      log(`[api] ${claims.sub} set a photo (${jpeg.length} bytes)`);
      act("photo_set", claims.sub);
      return [200, { photoVersion }];
    }],
    ["DELETE", /^\/me\/photo$/, async (req) => {
      const id = (await authorize(req)).sub;
      await accounts.removePhoto(id);
      act("photo_removed", id);
      return [200, {}];
    }],
    ["GET", /^\/users\/([\w.-]+)\/photo$/, async (req, [id]) => {
      const { jpeg, version } = await accounts.photo((await authorize(req)).sub, id);
      return [200, { bytes: jpeg, contentType: "image/jpeg", version }];
    }],
    ["GET", /^\/friends$/, async (req) => [200, { friends: await accounts.friends((await authorize(req)).sub) }]],
    ["PATCH", /^\/friends\/([\w.-]+)$/, async (req, [id]) => {
      const claims = await authorize(req);
      const { favorite } = await readBody(req);
      if (typeof favorite !== "boolean") throw new AccountError(400, "bad-request", "favorite is required");
      await accounts.setFavorite(claims.sub, id, favorite);
      act("favorite", claims.sub, { on: favorite });
      return [200, {}];
    }],
    ["DELETE", /^\/friends\/([\w.-]+)$/, async (req, [id]) => {
      const me = (await authorize(req)).sub;
      await accounts.removeFriend(me, id);
      act("friend_removed", me);
      return [200, {}];
    }],
    ["POST", /^\/invites$/, async (req) => {
      const me = (await authorize(req)).sub;
      const { code, expiresAt } = await accounts.createInvite(me);
      act("invite_created", me);
      return [200, { code, url: `${options.inviteBaseUrl}${code}`, expiresAt }];
    }],
    ["GET", /^\/invites\/([\w.-]+)$/, async (req, [code]) => [200, await accounts.invite(code, (await authorize(req)).sub)]],
    ["POST", /^\/invites\/([\w.-]+)\/accept$/, async (req, [code]) => {
      const claims = await authorize(req);
      // How long the invite waited, from when it expires (read before accepting uses it up).
      const expiresAt = await accounts.invite(code, claims.sub).then((i) => i.expiresAt, () => undefined);
      const friend = await accounts.acceptInvite(code, claims.sub);
      log(`[api] ${claims.sub} and ${friend.id} are friends`);
      act("invite_accepted", claims.sub, {
        inviter: friend.id,
        ...(expiresAt ? { inviteAgeMs: Math.max(0, Math.round(accounts.inviteTtlMs - (expiresAt - Date.now()))) } : {}),
      });
      return [200, { friend }];
    }],
    ["DELETE", /^\/invites\/([\w.-]+)$/, async (req, [code]) => {
      const me = (await authorize(req)).sub;
      await accounts.cancelInvite(code, me);
      act("invite_cancelled", me);
      return [200, {}];
    }],
    ["GET", /^\/blocks$/, async (req) => [200, { blocks: await accounts.blocks((await authorize(req)).sub) }]],
    ["POST", /^\/blocks$/, async (req) => {
      const claims = await authorize(req);
      const { userId } = await readBody(req);
      await accounts.block(claims.sub, String(userId));
      log(`[api] ${claims.sub} blocked ${userId}`);
      act("blocked", claims.sub);
      return [200, {}];
    }],
    ["DELETE", /^\/blocks\/([\w.-]+)$/, async (req, [id]) => {
      const me = (await authorize(req)).sub;
      await accounts.unblock(me, id);
      act("unblocked", me);
      return [200, {}];
    }],
    ["POST", /^\/reports$/, async (req) => {
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
      act("reported", claims.sub, { reason: report.reason, block: body.block === true });
      return [200, { id }];
    }],
    ["POST", /^\/events$/, async (req) => {
      const claims = await authorize(req);
      const events = cleanEvents(await readBody(req), { userId: claims.sub, deviceId: claims.dev });
      for (const event of events) telemetry.write(event, WARNING_EVENTS.has(String(event.name)) ? "WARNING" : "INFO");
      return [200, { accepted: events.length }];
    }],
    ["POST", /^\/diagnostics$/, async (req) => {
      const claims = await authorize(req);
      const gzip = await readBytes(req, MAX_DIAGNOSTICS_BYTES, "diagnostics-too-large");
      const meta = { platform: header(req, "x-oao-platform") ?? header(req, "x-oao-client-kind"), build: header(req, "x-oao-build") };
      const id = await accounts.saveDiagnostics(claims.sub, claims.dev, meta, gzip);
      telemetry.write({ kind: "oao.diagnostics", userId: claims.sub, deviceId: claims.dev, id, bytes: gzip.length, ...meta });
      return [200, { id }];
    }],
    ["POST", /^\/feedback$/, async (req) => {
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

  // Deletion needs a fresh proof from the account's own provider, naming the account's own
  // subject, before anything irreversible (contracts/README.md, "The account"). Apple's proof
  // revokes the Apple token.
  const checkDeletionProof = async (userId: string, identity: { provider: SignInProvider; subject: string }, proof: unknown): Promise<void> => {
    if (!isObject(proof)) throw new ContractError(400, "proof-required", "a sign-in proof is required");
    if (proof.provider !== identity.provider) {
      throw new ContractError(400, "wrong-provider", `this account signs in with ${identity.provider === "apple" ? "Apple" : "Google"}`);
    }
    if (identity.provider === "apple") {
      if (!options.revoker) {
        log(`[api] ${userId}: no Sign in with Apple key configured, so the Apple token isn't revoked`);
        return;
      }
      if (typeof proof.authorizationCode !== "string" || !proof.authorizationCode) {
        throw new AccountError(400, "proof-required");
      }
      let revoked: { sub: string };
      try {
        revoked = await options.revoker.revokeWithCode(proof.authorizationCode);
      } catch (err) {
        log(`[api] ${userId}: revoking the Apple token failed: ${(err as Error).message}`);
        throw new AccountError(502, "apple-revoke-failed");
      }
      // The code must come from the same Apple ID, or the wrong account's token was revoked.
      if (revoked.sub !== identity.subject) throw new AccountError(403, "wrong-apple-id");
      return;
    }
    if (!options.google) throw new ContractError(503, "provider-unavailable", "Google sign-in isn't available yet", { provider: "google" });
    if (typeof proof.identityToken !== "string" || typeof proof.nonce !== "string") throw new ContractError(400, "proof-required");
    let sub: string;
    try {
      sub = (await options.google.verify(proof.identityToken, proof.nonce)).sub;
    } catch {
      throw new AccountError(401, "google-token-rejected");
    }
    if (sub !== identity.subject) throw new AccountError(403, "wrong-google-account");
  };

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
    const match = url.pathname.match(/^\/v2(\/(?:auth|me|friends|invites|blocks|reports|events|diagnostics|feedback|config)(?:\/.*)?|\/users\/[\w.-]+\/photo)$/);
    if (!match) return false;
    const path = match[1];
    let route = "unmatched";
    try {
      for (const [method, pattern, handler] of routes) {
        const params = path.match(pattern);
        if (!params || req.method !== method) continue;
        route = `/v2${routeTemplate(pattern)}`;
        const [status, body, headers] = await handler(req, params.slice(1));
        if (isBytes(body)) {
          // Private: only the viewer and their friends may see it, so no shared caches.
          res.writeHead(status, { "content-type": body.contentType, "cache-control": "private, no-cache", etag: `"${body.version}"` });
          res.end(body.bytes);
        } else {
          send(res, status, body, headers as Record<string, string> | undefined);
        }
        return true;
      }
      send(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
      logError(req, route, 404, "not-found");
    } catch (err) {
      if (err instanceof AccountError || err instanceof ContractError) {
        send(res, err.status, { error: err.code, message: err.message, ...(err instanceof ContractError ? err.detail : {}) });
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

// "/^\/friends\/([\w.-]+)$/" → "/friends/{id}".
function routeTemplate(pattern: RegExp): string {
  return pattern.source.replace(/^\^|\$$/g, "").replace(/\([^)]*\)/g, "{id}").replace(/\\\//g, "/");
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value ? value.replace(/[^\w .()-]/g, "").slice(0, 40) : undefined;
}

// GET /v2/config (contracts/README.md, "Configuration").
function configJSON(options: ApiOptions): unknown {
  return {
    schemaVersion: 1,
    api: { versions: [...API_VERSIONS] },
    relay: {
      baseUrl: options.config?.relayBaseUrl ?? "https://relay-1.overandout.app",
      protocols: [...RELAY_PROTOCOLS],
      audioFormats: [...AUDIO_FORMATS],
      codecs: [...CODEC_NAMES],
    },
    features: { googleSignIn: Boolean(options.google), fcmDelivery: options.deliveryPolicy?.fcm ?? false },
    compatibility: { minimumBuilds: options.config?.minimumBuilds ?? {}, message: options.config?.message ?? null },
    timing: DEFAULT_TIMING,
  };
}

// The user as the account's own devices see it, with its sign-in provider (never a friend's).
function userJSON(user: User): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    ...(user.photoVersion !== undefined ? { photoVersion: user.photoVersion } : {}),
    ...(user.avatar !== undefined ? { avatar: user.avatar } : {}),
    ...(user.signInProvider ? { signInProvider: user.signInProvider } : {}),
    ...(user.preferredFormFactor ? { preferredFormFactor: user.preferredFormFactor } : {}),
    ...(user.rollOver ? { rollOver: true } : {}),
    ...(user.diagnosticsRequestedAt !== undefined ? { diagnosticsRequestedAt: user.diagnosticsRequestedAt } : {}),
  };
}

// A registration as its device sees it: everything but the token.
function deviceJSON(device: AccountDevice): Record<string, unknown> {
  const { token: _token, ...delivery } = device.delivery as { token?: string } & Record<string, unknown>;
  return {
    id: device.id,
    clientKind: device.clientKind,
    formFactor: formFactorOf(device.clientKind),
    delivery,
    receiveMode: device.receiveMode,
    availability: device.availability,
    capabilities: device.capabilities,
    ...(device.clientVersion ? { clientVersion: device.clientVersion } : {}),
    ...(device.build ? { build: device.build } : {}),
    ...(device.e2ee ? { e2ee: { phoneCert: device.e2ee.phoneCert, deviceCert: device.e2ee.deviceCert, encCert: device.e2ee.encCert } } : {}),
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

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
