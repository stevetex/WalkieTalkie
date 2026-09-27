// The account API as its own server: the Cloud Run service behind overandout.app/v1/*
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
//   DEV_APPLE_SIGNIN      1 = also accept the identity token "dev:<name>" as that Apple user, for
//                         local runs, simulators and tools/test-account.ts. Refused against the
//                         real Firestore
//   REVISION              the git commit, reported by /healthz

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Accounts } from "./accounts.ts";
import { createApi, send, type ApiHandler, type ApiOptions } from "./api.ts";
import { AppleRevoker, AppleVerifier } from "./apple.ts";
import { MemoryDocs, type Docs } from "./docs.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { loadSecrets } from "./secrets.ts";
import { SessionSigner, SessionVerifier, generateSigningKey, parsePublicKeys, parseSigningKey, type SigningKey } from "./session.ts";
import { ensureDir } from "./store.ts";

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
  if (env.DEV_APPLE_SIGNIN === "1") {
    if (env.STORE === "firestore" && !env.FIRESTORE_EMULATOR_HOST) throw new Error("DEV_APPLE_SIGNIN is for local runs only");
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
  const accounts = new Accounts(docs);
  const handler = createApi({
    accounts,
    signer,
    verifier,
    apple,
    revoker,
    inviteBaseUrl: env.INVITE_BASE_URL || "https://overandout.app/i/",
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
    // Cloud Run's front end reserves some paths ending in "z", so /v1/health too.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/v1/health")) {
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
