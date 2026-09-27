// The Test Bot as a real account (design decision 2026-09-27), so one set of devices can
// test invites, friend checks, blocks and reports. Its session token is saved to
// data/bot-token.json (gitignored, readable only by you) and never printed; bot.ts --account
// uses it.
//
//   node tools/test-account.ts create [--name "Test Bot"]
//       Creates (or finds) the bot's account and a session for its "device", and registers
//       that device so rings reach the bot over its relay connection.
//       Local (OAO_API is http://localhost…): signs in through the local API, which must run
//       with DEV_APPLE_SIGNIN=1 (see HANDOFF.md, Simulator).
//       Google Cloud: writes the account to Firestore and signs the token with the key in
//       Secret Manager, with your gcloud credentials. No test entry point in the API.
//
//   node tools/test-account.ts accept <invite link or code>
//       Accepts an invite as the bot (send yourself one from the iPhone app).
//
//   node tools/test-account.ts invite
//       Prints a new invite link from the bot, to open on the iPhone (tests the acceptance sheet).
//
//   node tools/test-account.ts friends
//       The bot's friends.
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

export const BOT_TOKEN_FILE = join(import.meta.dirname, "..", "data", "bot-token.json");
const BOT_APPLE_SUB = "test-bot.overandout";
const BOT_DEVICE = "test-bot";

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

  if (command === "create") {
    let session: BotSession;
    if (local) {
      const res = await api(base, null, "POST", "/v1/auth/apple", {
        identityToken: `dev:${BOT_APPLE_SUB}`,
        nonce: "unused",
        name: values.name,
        deviceId: BOT_DEVICE,
        platform: "watch",
      });
      session = { api: base, userId: res.user.id, name: res.user.name, token: res.token, expiresAt: res.expiresAt };
    } else {
      // Straight to Firestore and Secret Manager, as the signed-in gcloud user.
      const accounts = new Accounts(new Firestore({ projectId: project, accessToken: gcloudAccessToken() }));
      const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=session-signing-key", `--project=${project}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
      const signer = new SessionSigner(parseSigningKey(key));
      const { user } = await accounts.signInWithApple(BOT_APPLE_SUB, values.name);
      const sid = await accounts.createSession(user.id, BOT_DEVICE, "watch");
      const { token, expiresAt } = signer.issue({ sub: user.id, sid, dev: BOT_DEVICE });
      session = { api: base, userId: user.id, name: user.name, token, expiresAt };
    }
    // Rings reach the bot over its relay connection ("local:" pseudo-token, see relay.ts).
    await api(base, session.token, "PUT", "/v1/me/device", { platform: "watch", pushToken: `local:${session.userId}` });
    save(session);
    console.log(`Test Bot is ${session.userId} ("${session.name}"); its token is in ${BOT_TOKEN_FILE}.`);
  } else if (command === "accept") {
    if (!arg) throw new Error("usage: node tools/test-account.ts accept <invite link or code>");
    const session = loadBotSession();
    const code = arg.split("/").filter(Boolean).at(-1)!;
    const { friend } = await api(session.api, session.token, "POST", `/v1/invites/${code}/accept`);
    console.log(`Test Bot and ${friend.name} (${friend.id}) are friends.`);
  } else if (command === "invite") {
    const session = loadBotSession();
    const { url, expiresAt } = await api(session.api, session.token, "POST", "/v1/invites");
    console.log(`${url}  (from ${session.name}, single use, expires ${new Date(expiresAt).toISOString()})`);
  } else if (command === "friends") {
    const session = loadBotSession();
    const { friends } = await api(session.api, session.token, "GET", "/v1/friends");
    for (const f of friends) console.log(`${f.id}  ${f.name}`);
    if (!friends.length) console.log("No friends yet. Send the bot an invite from the iPhone app, then run: accept <link>");
  } else {
    console.error("usage: node tools/test-account.ts create | accept <invite link or code> | invite | friends");
    process.exit(2);
  }
}
