// The Test Bot as a real account (design decision 2026-09-27), so one set of devices can
// test invites, friend checks, blocks and reports. Its session token is saved to
// data/bot-token.json (gitignored, readable only by you) and never printed; bot.ts uses it.
//
//   node tools/test-account.ts create [--name "Test Bot"]
//       Creates (or finds) the bot's account and a session for its "device", and registers
//       that device so rings reach the bot over its relay connection.
//       Local (OAO_API is http://localhost…): signs in through the local API, which must run
//       with DEV_APPLE_SIGNIN=1 TEST_DELIVERY=1 (see HANDOFF.md, Simulator).
//       Google Cloud: writes the account to Firestore and signs the token with the key in
//       Secret Manager, with your gcloud credentials. No test entry point in the API.
//
//   node tools/test-account.ts accept <invite link or code>
//       Accepts an invite as the bot (send yourself one from the iPhone app).
//
//   node tools/test-account.ts invite
//       Prints a new invite link from the bot, to open on the iPhone (tests the acceptance sheet).
//       Single use; App Review uses the bot's standing invite instead (TEST_BOT_INVITE, accounts.ts).
//
//   node tools/test-account.ts friends
//       The bot's friends.
//
//   node tools/test-account.ts photo [file.jpg]
//       Sets the bot's profile photo: a square JPEG under 100 KB, by default
//       tools/test-bot-photo.jpg (the robot face emoji on indigo).
//
//   node tools/test-account.ts canary
//       The Ops dashboard's Canary (src/canary.ts): an account with an iPhone session on the
//       device "canary" and the Test Bot as its friend, and no device to ring. Prints its ID for
//       CANARY_USER_ID in deploy/gcp/config.sh. Run once; again, it finds the same account and
//       makes a fresh session. No token is saved: the rolling job signs a short one each run.
//       Google Cloud: needs the Test Bot's account (TEST_BOT_USER_ID, or the bot's token file).
//       Local: the bot made with "create" against the local API.
//
//   node tools/test-account.ts android <name>
//       Local only (Phase 0's synthetic Android peer): signs <name> in with a dev Google identity
//       on an "android" device and registers it for FCM rings, which the relay's FCM stub records
//       instead of sending. Needs a local relay run with SERVE_API=1 DEV_GOOGLE_SIGNIN=1
//       FCM_STUB=1. Saves its session to OAO_BOT_TOKEN_FILE for bot.ts --client-kind android.
//
// OAO_API is the account API (default https://overandout.app); GCP_PROJECT the Google Cloud
// project (default walkie-talkie-relay).

import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Firestore, gcloudAccessToken } from "../src/firestore.ts";
import { SessionSigner, parseSigningKey } from "../src/session.ts";
import { CANARY_DEVICE } from "../src/canary.ts";
import { createEndpointSecrets, localEndpointKeys, openEndpointSecrets, type EndpointSecrets } from "../src/endpoint-keys.ts";

// OAO_BOT_TOKEN_FILE keeps a local bot (simulator testing) apart from the Google Cloud one.
export const BOT_TOKEN_FILE = process.env.OAO_BOT_TOKEN_FILE ?? join(import.meta.dirname, "..", "data", "bot-token.json");
export const BOT_KEYS_FILE = process.env.OAO_BOT_KEYS_FILE ?? join(dirname(BOT_TOKEN_FILE), "test-bot-keys.json");
const BOT_APPLE_SUB = "test-bot.overandout";
const CANARY_APPLE_SUB = "canary.overandout";
const BOT_DEVICE = "test-bot";
// Rings reach the bot over its relay connection: a test delivery, which only servers run for
// tests let clients register (TEST_DELIVERY), so on Google Cloud it's written directly.
const BOT_REGISTRATION = {
  clientKind: "watchos" as const,
  delivery: { provider: "test" as const, mode: "connection" as const },
  availability: { enabled: true, notifications: "authorized" as const },
  capabilities: { relayProtocols: [2], audioFormats: [2], decode: ["opus16k" as const, "pcm16le16k" as const], encode: ["opus16k" as const], features: [] },
};

// Null without a keys file: a device registers only with its keys (format 2 only), and the relay
// registers the Test Bot's own when it starts.
function botRegistration(userId: string) {
  if (!existsSync(BOT_KEYS_FILE)) return null;
  const keys = openEndpointSecrets(JSON.parse(readFileSync(BOT_KEYS_FILE, "utf8")) as EndpointSecrets, userId, BOT_DEVICE);
  return { ...BOT_REGISTRATION, e2ee: keys.registration };
}

export interface BotSession {
  api: string;
  userId: string;
  name: string;
  token: string;
  expiresAt: number;
}

export function loadBotSession(): BotSession {
  if (!existsSync(BOT_TOKEN_FILE)) throw new Error(`no bot account yet: run node tools/test-account.ts create`);
  return JSON.parse(readFileSync(BOT_TOKEN_FILE, "utf8")) as BotSession;
}

async function api(base: string, token: string | null, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json.error ?? ""} ${json.message ?? ""}`);
  return json;
}

function save(session: BotSession): void {
  mkdirSync(dirname(BOT_TOKEN_FILE), { recursive: true });
  writeFileSync(BOT_TOKEN_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  chmodSync(BOT_TOKEN_FILE, 0o600);
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { name: { type: "string", default: "Test Bot" } },
  });
  const base = process.env.OAO_API ?? "https://overandout.app";
  const project = process.env.GCP_PROJECT ?? "walkie-talkie-relay";
  const local = new URL(base).hostname === "localhost" || new URL(base).hostname === "127.0.0.1";
  const [command, arg] = positionals;

  if (command === "keys") {
    const userId = process.env.TEST_BOT_USER_ID || (existsSync(BOT_TOKEN_FILE) ? loadBotSession().userId : "");
    if (!userId) throw new Error("create the Test Bot account first or set TEST_BOT_USER_ID");
    const path = arg ?? BOT_KEYS_FILE;
    mkdirSync(dirname(path), { recursive: true });
    localEndpointKeys(path, userId, BOT_DEVICE, "watchos");
    console.log(`Test Bot keys are saved at ${path}. Keep this file private; configure TEST_BOT_E2EE_SECRET before the encrypted rollout.`);
  } else if (command === "register-keys") {
    const session = loadBotSession();
    const reg = botRegistration(session.userId);
    if (!reg) throw new Error(`create ${BOT_KEYS_FILE} with the keys command first`);
    if (local) await api(base, session.token, "PUT", "/v2/me/device", reg);
    else {
      const accounts = new Accounts(new Firestore({ projectId: project, accessToken: gcloudAccessToken() }));
      await accounts.registerDevice(session.userId, BOT_DEVICE, reg);
    }
    console.log("Test Bot certificates registered; the private keys remain in the local file.");
  } else if (command === "create") {
    let session: BotSession;
    if (local) {
      const res = await api(base, null, "POST", "/v2/auth/apple", {
        identityToken: `dev:${BOT_APPLE_SUB}`,
        nonce: "unused",
        name: values.name,
        deviceId: BOT_DEVICE,
        clientKind: "watchos",
      });
      session = { api: base, userId: res.user.id, name: res.user.name, token: res.token, expiresAt: res.expiresAt };
      const reg = botRegistration(session.userId);
      if (reg) await api(base, session.token, "PUT", "/v2/me/device", reg);
    } else {
      // Straight to Firestore and Secret Manager, as the signed-in gcloud user.
      const accounts = new Accounts(new Firestore({ projectId: project, accessToken: gcloudAccessToken() }));
      const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=session-signing-key", `--project=${project}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      const signer = new SessionSigner(parseSigningKey(key));
      const { user } = await accounts.signInWithApple(BOT_APPLE_SUB, values.name);
      const sid = await accounts.createSession(user.id, BOT_DEVICE, "watchos");
      const { token, expiresAt } = signer.issue({ sub: user.id, sid, dev: BOT_DEVICE });
      session = { api: base, userId: user.id, name: user.name, token, expiresAt };
      const reg = botRegistration(user.id);
      if (reg) await accounts.registerDevice(user.id, BOT_DEVICE, reg);
    }
    save(session);
    console.log(`Test Bot is ${session.userId} ("${session.name}"); its token is in ${BOT_TOKEN_FILE}.`);
  } else if (command === "accept") {
    if (!arg) throw new Error("usage: node tools/test-account.ts accept <invite link or code>");
    const session = loadBotSession();
    const code = arg.split("/").filter(Boolean).at(-1)!;
    const { friend } = await api(session.api, session.token, "POST", `/v2/invites/${code}/accept`);
    console.log(`${session.name} and ${friend.name} (${friend.id}) are friends.`);
  } else if (command === "invite") {
    const session = loadBotSession();
    const { url, expiresAt } = await api(session.api, session.token, "POST", "/v2/invites");
    console.log(`${url}  (from ${session.name}, single use, expires ${new Date(expiresAt).toISOString()})`);
  } else if (command === "friends") {
    const session = loadBotSession();
    const { friends } = await api(session.api, session.token, "GET", "/v2/friends");
    for (const f of friends) console.log(`${f.id}  ${f.name}`);
    if (!friends.length) console.log("No friends yet. Send the bot an invite from the iPhone app, then run: accept <link>");
  } else if (command === "photo") {
    const session = loadBotSession();
    const file = arg ?? new URL("test-bot-photo.jpg", import.meta.url).pathname;
    const res = await fetch(new URL("/v2/me/photo", session.api), {
      method: "PUT",
      headers: { "content-type": "image/jpeg", authorization: `Bearer ${session.token}` },
      body: readFileSync(file),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PUT /v2/me/photo: ${res.status} ${json.error ?? ""}`);
    console.log(`${session.name}'s photo is ${file} (version ${json.photoVersion}).`);
  } else if (command === "canary") {
    let canaryId: string;
    if (local) {
      const bot = loadBotSession();
      const res = await api(base, null, "POST", "/v2/auth/apple", { identityToken: `dev:${CANARY_APPLE_SUB}`, nonce: "unused", name: "Canary", deviceId: CANARY_DEVICE, clientKind: "ios" });
      canaryId = res.user.id;
      const { friends } = await api(base, res.token, "GET", "/v2/friends");
      if (!friends.some((f: { id: string }) => f.id === bot.userId)) {
        const { code } = await api(base, bot.token, "POST", "/v2/invites");
        await api(base, res.token, "POST", `/v2/invites/${code}/accept`);
      }
    } else {
      const botId = process.env.TEST_BOT_USER_ID || (existsSync(BOT_TOKEN_FILE) ? loadBotSession().userId : "");
      if (!botId) throw new Error("set TEST_BOT_USER_ID (the Test Bot's account) first");
      const accounts = new Accounts(new Firestore({ projectId: project, accessToken: gcloudAccessToken() }));
      const { user } = await accounts.signInWithApple(CANARY_APPLE_SUB, "Canary");
      canaryId = user.id;
      await accounts.createSession(user.id, CANARY_DEVICE, "ios");
      if (!(await accounts.friends(user.id)).some((f) => f.id === botId)) {
        await accounts.acceptInvite((await accounts.createInvite(botId)).code, user.id);
      }
    }
    console.log(`The Canary is ${canaryId}, a friend of the Test Bot. Set CANARY_USER_ID="${canaryId}" in deploy/gcp/config.sh.`);
  } else if (command === "android") {
    if (!local || !arg) throw new Error("usage (local only): node tools/test-account.ts android <name>");
    const deviceId = `android-${arg.toLowerCase()}`;
    const res = await api(base, null, "POST", "/v2/auth/google", { identityToken: `dev:${arg.toLowerCase()}`, nonce: "unused", name: arg, deviceId, clientKind: "android" });
    const session: BotSession = { api: base, userId: res.user.id, name: res.user.name, token: res.token, expiresAt: res.expiresAt };
    const keys = openEndpointSecrets(createEndpointSecrets(session.userId, deviceId, "android"), session.userId, deviceId);
    await api(base, session.token, "PUT", "/v2/me/device", {
      clientKind: "android",
      delivery: { provider: "fcm", mode: "notification", token: `fcm-${deviceId}` },
      availability: { enabled: true, notifications: "authorized" },
      capabilities: { relayProtocols: [2], audioFormats: [2], decode: ["opus16k", "pcm16le16k"], encode: ["opus16k", "pcm16le16k"] },
      // Throwaway keys: the synthetic account is rung, never heard.
      e2ee: keys.registration,
      clientVersion: "synthetic",
      build: "1",
    });
    save(session);
    console.log(`${session.name} is an Android account ${session.userId} (Google dev identity); its token is in ${BOT_TOKEN_FILE}.`);
  } else {
    console.error("usage: node tools/test-account.ts keys [path] | register-keys | create | accept <invite link or code> | invite | friends | photo [file.jpg] | canary | android <name>");
    process.exit(2);
  }
}
