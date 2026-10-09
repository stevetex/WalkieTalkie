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
import type { Capabilities } from "../src/contract.ts";
import { SpikeClient, type ClientOptions } from "../tools/client.ts";
import type { KeyObject } from "node:crypto";
import { createEndpointSecrets, openEndpointSecrets, type EndpointKeys } from "../src/endpoint-keys.ts";
import { agreementKey, issueDeviceCertificate, issueEncryptionKeyCertificate, keyId, rawPublic, signingKey } from "../src/e2ee.ts";

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
    config: { relayBaseUrl: "https://relay-1.nowza.app", minimumBuilds: options.minimumBuilds },
    inviteBaseUrl: "https://nowza.app/i/",
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
  return { "x-oao-client-kind": kind, "x-oao-build": build, "x-oao-relay-protocol": "2", "x-oao-decode": "opus16k,pcm16le16k", "x-oao-encode": encode, "x-oao-audio-formats": "2" };
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

// What every build since E2EE says it supports: format 2 only.
export const CAPABILITIES: Capabilities = { relayProtocols: [2], audioFormats: [2], decode: ["opus16k", "pcm16le16k"], encode: ["opus16k", "pcm16le16k"], features: [] };

// New E2EE keys for a device of this account (each device here is its own phone identity).
export function deviceKeys(userId: string, deviceId: string, kind: Kind): EndpointKeys {
  return openEndpointSecrets(createEndpointSecrets(userId, deviceId, kind), userId, deviceId);
}

// Keys for a companion (a watch the phone signed in): its device certificate is issued by the
// phone's identity key, as the apps do, so it registers under the phone's certificate.
export function companionKeys(phone: EndpointKeys, deviceId: string, kind: Kind, now = Date.now()): EndpointKeys {
  const { userId } = phone.secrets;
  const seed = () => crypto.getRandomValues(new Uint8Array(32));
  const raw = (key: KeyObject) => new Uint8Array(rawPublic(key));
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const deviceSeed = seed();
  const encSeed = seed();
  const device = signingKey(deviceSeed);
  const encryption = agreementKey(encSeed);
  const identity = signingKey(new Uint8Array(Buffer.from(phone.secrets.phoneSeed, "base64")));
  const deviceCert = issueDeviceCertificate(identity, { userId, deviceId, clientKind: kind, signingKey: raw(device) }, now);
  const encCert = issueEncryptionKeyCertificate(device, { userId, deviceId, encKey: raw(encryption) }, now);
  return {
    secrets: { ...phone.secrets, deviceId, clientKind: kind, deviceSeed: base64(deviceSeed), encSeed: base64(encSeed),
      deviceCert: deviceCert.toString("base64"), encCert: encCert.toString("base64") },
    sender: { userId, deviceId, phoneCert: phone.sender.phoneCert, deviceCert, signingKey: device },
    encryption: new Map([[keyId(raw(encryption)), encryption]]),
    registration: { phoneCert: phone.secrets.phoneCert, deviceCert: deviceCert.toString("base64"), encCert: encCert.toString("base64") },
  };
}

// A PUT /v2/me/device body: how it's rung, plus the capabilities and, with `keys`, its
// certificates (a registration without them is refused).
export function registration(kind: Kind, ringing: Exclude<Ringing, "none">, notifications: "authorized" | "denied" | "unknown" = "authorized", keys?: EndpointKeys): Record<string, unknown> {
  const delivery = ringing === "foreground"
    ? { provider: "relay", mode: "foreground" }
    : ringing === "test"
      ? { provider: "test", mode: "connection" }
      : "fcm" in ringing
        ? { provider: "fcm", mode: "notification", token: ringing.fcm }
        : { provider: "apns", mode: ringing.apns, token: ringing.token, environment: "sandbox" };
  return { clientKind: kind, delivery, availability: { enabled: true, notifications }, capabilities: CAPABILITIES, ...(keys ? { e2ee: keys.registration } : {}) };
}

export interface TestUser {
  id: string;
  name: string;
  token: string;
  deviceId: string;
  kind: Kind;
  // This device's E2EE keys, registered with it.
  keys: EndpointKeys;
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
  const id = res.body.user.id as string;
  const keys = deviceKeys(id, deviceId, kind);
  const ringing = options.ringing ?? "test";
  if (ringing !== "none") {
    const reg = await call(h.url, "PUT", "/v2/me/device", token, registration(kind, ringing, options.notifications, keys));
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
  }
  return {
    id,
    name,
    token,
    deviceId,
    kind,
    keys,
    client: (clientOptions = {}) => new SpikeClient({
      server: h.url, userId: id, token, clientKind: kind,
      e2ee: { keys, directory: (friend) => h.accounts.friendKeys(friend) },
      ...clientOptions,
    }),
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
