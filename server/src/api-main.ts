// The account API as its own server: the Cloud Run service behind overandout.app/v2/*
// (design decision 2026-09-27). main.ts also mounts it for local runs (SERVE_API=1).
//
//   PORT                  listen port (default 8080; Cloud Run sets it)
//   STORE                 "firestore" (the image's default) or "json" (DATA_DIR/accounts.json)
//   FIRESTORE_PROJECT, FIRESTORE_EMULATOR_HOST, FIRESTORE_AUTH   as in main.ts
//   SESSION_SIGNING_KEY   JSON {kid, privateKey} (session.ts); SESSION_SIGNING_KEY_SECRET
//                         names a Secret Manager secret instead
//   SESSION_PUBLIC_KEYS   JSON {kid: PEM}; the signing key's own public key is always included
//   APPLE_AUDIENCES       bundle IDs whose Sign in with Apple tokens are accepted
//                         (default com.cypressoakstudios.overandout)
//   APPLE_TEAM_ID, APPLE_SIWA_KEY_ID, APPLE_SIWA_KEY (or APPLE_SIWA_KEY_SECRET), APPLE_CLIENT_ID
//                         the Sign in with Apple key, for revoking on deletion (apple.ts)
//   INVITE_BASE_URL       default https://overandout.app/i/
//   TEST_BOT_USER_ID, TEST_BOT_INVITE
//                         the Test Bot's account and its standing invite: a code (12–64 letters,
//                         digits, "_" or "-") that befriends the bot, and only the bot, any number
//                         of times (accounts.ts). The link is INVITE_BASE_URL plus the code
//   DEV_APPLE_SIGNIN      1 = also accept the identity token "dev:<name>" as that Apple user, for
//                         local runs, simulators and tools/test-account.ts. Refused against the
//                         real Firestore
//   DEV_GOOGLE_SIGNIN     1 = /v2/auth/google accepts "dev:<name>" as that Google user: synthetic
//                         Google accounts for the later-service fixture (Phase 0 has no real
//                         Google sign-in). Local only, like DEV_APPLE_SIGNIN
//   FCM_STUB              1 = registrations may name FCM delivery (rings are recorded by the
//                         relay's stub, not sent). Local only
//   TEST_DELIVERY         1 = registrations may name the test delivery (rung over any of the
//                         account's relay connections, as a bot is). Local only
//   RELAY_BASE_URL        the relay GET /v2/config names (default https://relay-1.overandout.app)
//   MINIMUM_BUILDS        JSON {clientKind: build}, said in GET /v2/config (the relay enforces it)
//   REVISION              the git commit, reported by /healthz

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Accounts } from "./accounts.ts";
import { createApi, send, type ApiHandler, type ApiOptions, type IdentityVerifier } from "./api.ts";
import { parseMinimumBuilds } from "./contract.ts";
import { AppleRevoker, AppleVerifier } from "./apple.ts";
import { MemoryDocs, type Docs } from "./docs.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { loadSecrets } from "./secrets.ts";
import { SessionSigner, SessionVerifier, generateSigningKey, parsePublicKeys, parseSigningKey, type SigningKey } from "./session.ts";
import { ensureDir } from "./store.ts";
import { FileSink, StdoutSink } from "./telemetry.ts";

export const DEFAULT_APPLE_AUDIENCE = "com.cypressoakstudios.overandout";

export interface ApiSetup {
  handler: ApiHandler;
  accounts: Accounts;
  verifier: SessionVerifier;
  notes: string[];
}

// Builds the API from environment variables. With no signing key configured and a data
// directory, a key is generated once and kept there (local runs only).
export function apiFromEnv(env: NodeJS.ProcessEnv, docs: Docs, dataDir: string | null): ApiSetup {
  const notes: string[] = [];
  let signingKey: SigningKey;
  if (env.SESSION_SIGNING_KEY) {
    signingKey = parseSigningKey(env.SESSION_SIGNING_KEY);
  } else if (dataDir) {
    const file = join(dataDir, "session-key.json");
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(generateSigningKey("local").signingKey), { mode: 0o600 });
    signingKey = parseSigningKey(readFileSync(file, "utf8"));
    notes.push(`session key from ${file} (local)`);
  } else {
    throw new Error("SESSION_SIGNING_KEY (or SESSION_SIGNING_KEY_SECRET) is required");
  }
  const signer = new SessionSigner(signingKey);
  const publicKeys = { ...(env.SESSION_PUBLIC_KEYS ? parsePublicKeys(env.SESSION_PUBLIC_KEYS) : {}), [signer.kid]: signer.publicKey() };
  const verifier = new SessionVerifier(publicKeys);

  const audiences = (env.APPLE_AUDIENCES || DEFAULT_APPLE_AUDIENCE).split(",").map((a) => a.trim()).filter(Boolean);
  const appleVerifier = new AppleVerifier({ audiences });
  let apple: ApiOptions["apple"] = appleVerifier;
  const realDatabase = env.STORE === "firestore" && !env.FIRESTORE_EMULATOR_HOST;
  for (const local of ["DEV_APPLE_SIGNIN", "DEV_GOOGLE_SIGNIN", "FCM_STUB", "TEST_DELIVERY"]) {
    if (env[local] === "1" && realDatabase) throw new Error(`${local} is for local runs only`);
  }
  if (env.DEV_APPLE_SIGNIN === "1") {
    apple = {
      verify: (identityToken, nonce) =>
        identityToken.startsWith("dev:") ? Promise.resolve({ sub: `dev.${identityToken.slice(4)}` }) : appleVerifier.verify(identityToken, nonce),
    };
    notes.push("DEV_APPLE_SIGNIN: identity tokens dev:<name> sign in without Apple");
  }
  let revoker: AppleRevoker | null = null;
  if (env.APPLE_TEAM_ID && env.APPLE_SIWA_KEY_ID && env.APPLE_SIWA_KEY) {
    revoker = new AppleRevoker({
      teamId: env.APPLE_TEAM_ID,
      keyId: env.APPLE_SIWA_KEY_ID,
      privateKey: env.APPLE_SIWA_KEY,
      clientId: env.APPLE_CLIENT_ID || audiences[0],
    });
  } else {
    notes.push("no Sign in with Apple key: account deletion won't revoke Apple tokens");
  }
  let botInvite: { code: string; userId: string } | null = null;
  if (env.TEST_BOT_INVITE) {
    if (!/^[\w-]{12,64}$/.test(env.TEST_BOT_INVITE)) throw new Error("TEST_BOT_INVITE must be 12–64 letters, digits, _ or -");
    if (!env.TEST_BOT_USER_ID?.startsWith("u_")) throw new Error("TEST_BOT_INVITE needs TEST_BOT_USER_ID");
    botInvite = { code: env.TEST_BOT_INVITE, userId: env.TEST_BOT_USER_ID };
    notes.push(`the Test Bot's standing invite befriends ${botInvite.userId}`);
  }
  // Google sign-in is Phase 2. Until then, only synthetic dev identities, for local fixtures.
  let google: IdentityVerifier | null = null;
  if (env.DEV_GOOGLE_SIGNIN === "1") {
    google = {
      verify: async (identityToken) => {
        if (!identityToken.startsWith("dev:")) throw new Error("only dev: identities are accepted");
        return { sub: `dev-google.${identityToken.slice(4)}` };
      },
    };
    notes.push("DEV_GOOGLE_SIGNIN: /v2/auth/google accepts dev:<name> (synthetic Google accounts)");
  }
  const deliveryPolicy = { fcm: env.FCM_STUB === "1", testDelivery: env.TEST_DELIVERY === "1" };
  if (deliveryPolicy.fcm) notes.push("FCM_STUB: registrations may name FCM delivery");
  if (deliveryPolicy.testDelivery) notes.push("TEST_DELIVERY: registrations may name the test delivery");
  const minimumBuilds = parseMinimumBuilds(env.MINIMUM_BUILDS);
  const accounts = new Accounts(docs, { botInvite });
  const handler = createApi({
    accounts,
    signer,
    verifier,
    apple,
    revoker,
    google,
    devSignIn: env.DEV_APPLE_SIGNIN === "1" || env.DEV_GOOGLE_SIGNIN === "1",
    deliveryPolicy,
    config: { relayBaseUrl: env.RELAY_BASE_URL || "https://relay-1.overandout.app", minimumBuilds },
    inviteBaseUrl: env.INVITE_BASE_URL || "https://overandout.app/i/",
    // Cloud Run turns JSON lines on stdout into structured entries; local runs keep a file.
    telemetry: dataDir ? new FileSink(dataDir) : new StdoutSink(),
  });
  notes.push(`session key ${signer.kid}, Apple audiences ${audiences.join(", ")}`);
  return { handler, accounts, verifier, notes };
}

// The Firestore or JSON document store, and the secrets, as main.ts sets them up.
export async function docsFromEnv(env: NodeJS.ProcessEnv): Promise<{ docs: Docs; dataDir: string | null; description: string; secrets: string[] }> {
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST || undefined;
  const onGoogleCloud = env.STORE === "firestore" && !emulatorHost && env.FIRESTORE_AUTH !== "gcloud";
  const projectId = env.FIRESTORE_PROJECT || (emulatorHost ? "demo-overandout" : onGoogleCloud ? await metadataProjectId() : "");
  const accessToken = env.FIRESTORE_AUTH === "gcloud" ? gcloudAccessToken() : metadataAccessToken();
  const secrets = await loadSecrets(env, projectId, accessToken);
  if (env.STORE === "firestore") {
    const docs = new Firestore({ projectId, emulatorHost, accessToken });
    return { docs, dataDir: null, description: `Firestore ${emulatorHost ? `emulator ${emulatorHost}, ` : ""}project ${projectId}`, secrets };
  }
  const dataDir = ensureDir(resolve(env.DATA_DIR ?? "data"));
  return { docs: new MemoryDocs(join(dataDir, "accounts.json")), dataDir, description: dataDir, secrets };
}

if (import.meta.main) {
  const env = process.env;
  const { docs, dataDir, description, secrets } = await docsFromEnv(env);
  const api = apiFromEnv(env, docs, dataDir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Cloud Run's front end reserves some paths ending in "z", so /v2/health too.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v2/health")) {
      return send(res, 200, { ok: true, revision: env.REVISION ?? "local" });
    }
    if (await api.handler(req, res, url)) return;
    send(res, 404, { error: "not-found" });
  });
  const port = Number(env.PORT ?? 8080);
  server.listen(port, () => {
    console.log(`[api] listening on :${port}, data in ${description}, revision ${env.REVISION ?? "local"}`);
    if (secrets.length) console.log(`[api] secrets ${secrets.join(", ")} from Secret Manager`);
    for (const note of api.notes) console.log(`[api] ${note}`);
  });
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
