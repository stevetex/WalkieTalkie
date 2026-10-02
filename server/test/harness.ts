// A relay with the account API in one process, on in-memory accounts, as the tests use it: people
// sign in through POST /v2/auth/{apple,google} (an identity token "dev:<name>" is that provider's
// user), register a device, become friends through an invite, and talk with tools/client.ts.

import assert from "node:assert/strict";
import { startServer, type RunningServer, type ServerOptions } from "../src/main.ts";
import { DryRunPusher } from "../src/apns.ts";
import { Accounts } from "../src/accounts.ts";
import { createApi, type ApiOptions } from "../src/api.ts";
import { MemoryDocs } from "../src/docs.ts";
import { SessionSigner, SessionVerifier, generateSigningKey } from "../src/session.ts";
import { ApnsDelivery, Deliveries, FcmStub } from "../src/delivery.ts";
import type { LogSink } from "../src/telemetry.ts";
import { SpikeClient, type ClientOptions } from "../tools/client.ts";

export interface TestServer {
  server: RunningServer;
  url: string;
  pusher: DryRunPusher;
  fcm: FcmStub;
  accounts: Accounts;
  docs: MemoryDocs;
  signer: SessionSigner;
}

export type HarnessOptions = Partial<Omit<ServerOptions, "port" | "dataDir" | "sessions" | "accounts" | "api" | "pusher">> & {
  pusher?: DryRunPusher;
  docs?: MemoryDocs;
  // Google sign-in (dev identities) and FCM rings (the stub); both on by default.
  google?: boolean;
  fcm?: boolean;
  // What the API's GET /v2/config and the rest say; merged over the defaults.
  api?: Partial<ApiOptions>;
};

// Apple and Google are faked: an identity token is the provider's user ID ("dev:<name>" is the
// user "dev.<name>", and lets a watch sign itself in), and an Apple authorization code
// "code:<sub>" revokes that user's token.
export async function withServer(fn: (h: TestServer) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const { signingKey, publicKeys } = generateSigningKey("test");
  const signer = new SessionSigner(signingKey);
  const verifier = new SessionVerifier(publicKeys);
  const docs = options.docs ?? new MemoryDocs();
  const accounts = new Accounts(docs);
  const pusher = options.pusher ?? new DryRunPusher();
  const fcm = new FcmStub();
  const silent: LogSink = { write: () => {}, flush: async () => {} };
  const { google: googleOn, fcm: fcmOn, api: apiOverrides, docs: _docs, pusher: _pusher, ...serverOptions } = options;
  const api = createApi({
    accounts,
    signer,
    verifier,
    apple: { verify: async (identityToken) => ({ sub: devSubject(identityToken) }) },
    revoker: { revokeWithCode: async (code) => ({ sub: code.replace(/^code:/, "") }) },
    google: googleOn !== false ? { verify: async (identityToken) => ({ sub: devSubject(identityToken) }) } : null,
    devSignIn: true,
    deliveryPolicy: { fcm: fcmOn !== false, testDelivery: true },
    config: { relayBaseUrl: "https://relay-1.overandout.app", minimumBuilds: options.minimumBuilds },
    inviteBaseUrl: "https://overandout.app/i/",
    log: () => {},
    telemetry: silent,
    ...apiOverrides,
  });
  const server = await startServer({
    port: 0,
    dataDir: null,
    adminToken: "admin",
    sessions: verifier,
    accounts,
    api,
    pusher,
    deliveries: new Deliveries({ apns: new ApnsDelivery(pusher), ...(fcmOn !== false ? { fcm } : {}) }),
    ...serverOptions,
  });
  try {
    await fn({ server, url: `http://localhost:${server.port}`, pusher, fcm, accounts, docs, signer });
  } finally {
    await server.close();
  }
}

function devSubject(identityToken: string): string {
  return identityToken.startsWith("dev:") ? `dev.${identityToken.slice(4)}` : identityToken;
}

export type Kind = "ios" | "watchos" | "android" | "wearos";

// The admission headers a build of this kind sends.
export function clientHeaders(kind: Kind, build = "170", encode = "opus16k"): Record<string, string> {
  return { "x-oao-client-kind": kind, "x-oao-build": build, "x-oao-relay-protocol": "2", "x-oao-decode": "opus16k,pcm16le16k", "x-oao-encode": encode };
}

export async function call(url: string, method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

// How a device is rung: a real-looking APNs token (through the pusher), the app's own open
// stream, any of the account's connections (a bot's), FCM (the stub), or not at all.
export type Ringing =
  | { apns: "alert" | "pushtotalk"; token: string }
  | { fcm: string }
  | "foreground"
  | "test"
  | "none";

export function registration(kind: Kind, ringing: Exclude<Ringing, "none">, notifications: "authorized" | "denied" | "unknown" = "authorized"): Record<string, unknown> {
  const delivery = ringing === "foreground"
    ? { provider: "relay", mode: "foreground" }
    : ringing === "test"
      ? { provider: "test", mode: "connection" }
      : "fcm" in ringing
        ? { provider: "fcm", mode: "notification", token: ringing.fcm }
        : { provider: "apns", mode: ringing.apns, token: ringing.token, environment: "sandbox" };
  return { clientKind: kind, delivery, availability: { enabled: true, notifications } };
}

export interface TestUser {
  id: string;
  name: string;
  token: string;
  deviceId: string;
  kind: Kind;
  // A relay client for this device.
  client(options?: Partial<ClientOptions>): SpikeClient;
}

// Signs `name` in on a device of `kind` (default a watch, rung over its connection like the
// spike's bots) and registers it. Phones and watches both sign in themselves here.
export async function user(h: TestServer, name: string, options: { kind?: Kind; ringing?: Ringing; deviceId?: string; notifications?: "authorized" | "denied" | "unknown" } = {}): Promise<TestUser> {
  const kind = options.kind ?? "watchos";
  const provider = kind === "ios" || kind === "watchos" ? "apple" : "google";
  const deviceId = options.deviceId ?? `${name.toLowerCase()}-${kind}`;
  const res = await call(h.url, "POST", `/v2/auth/${provider}`, null, { identityToken: `dev:${name.toLowerCase()}`, nonce: "n", name, deviceId, clientKind: kind });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const token = res.body.token as string;
  const ringing = options.ringing ?? "test";
  if (ringing !== "none") {
    const reg = await call(h.url, "PUT", "/v2/me/device", token, registration(kind, ringing, options.notifications));
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
  }
  const id = res.body.user.id as string;
  return {
    id,
    name,
    token,
    deviceId,
    kind,
    client: (clientOptions = {}) => new SpikeClient({ server: h.url, userId: id, token, clientKind: kind, ...clientOptions }),
  };
}

// Makes them all friends with each other, through invites.
export async function befriend(h: TestServer, ...people: TestUser[]): Promise<void> {
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const invite = await call(h.url, "POST", "/v2/invites", people[i].token);
      assert.equal(invite.status, 200, JSON.stringify(invite.body));
      const accepted = await call(h.url, "POST", `/v2/invites/${invite.body.code}/accept`, people[j].token);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    }
  }
}

// Several people who are all friends: user() for each, then befriend().
export async function friends(h: TestServer, ...people: Array<string | [string, Parameters<typeof user>[2]]>): Promise<TestUser[]> {
  const made: TestUser[] = [];
  for (const p of people) made.push(typeof p === "string" ? await user(h, p) : await user(h, p[0], p[1]));
  await befriend(h, ...made);
  return made;
}

// 16 kHz PCM16, a ramp so frames are distinguishable.
export function pcm(frames: number): Buffer {
  const buf = Buffer.alloc(frames * 640);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE((i * 37) % 32000, i * 2);
  return buf;
}
