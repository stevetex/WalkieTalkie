// APNs provider for ring notifications (token-based auth, HTTP/2). A watch ring is a
// time-sensitive alert push that opens the app on tap (option C: no CallKit or VoIP push).
// An iPhone ring is a PushToTalk push (design decision 2026-09-27), which wakes the app and
// plays the message with no tap.
// Without credentials it runs in dry-run mode and only logs, which is what the tests use.

import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RingPayload } from "./protocol.ts";

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsConfig {
  // The .p8 key: a file, or its PEM text (relay nodes read it from Secret Manager).
  keyPath?: string;
  key?: string;
  keyId: string;
  teamId: string;
  // The watch app's bundle ID: the topic for alert pushes, since the watch registers itself.
  bundleId: string;
  // The iPhone app's: PushToTalk pushes go to "<this>.voip-ptt". The same key signs both.
  iphoneBundleId: string;
}

export interface PushResult {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  latencyMs: number;
  dryRun: boolean;
}

export interface AlertPush {
  // Alert (the default) goes to the watch app; pushtotalk to the iPhone app's PushToTalk channel.
  pushType?: "alert" | "pushtotalk";
  // The whole APNs JSON body: `aps` plus custom keys.
  payload: object;
  // A later push with the same ID replaces this one on the device.
  collapseId?: string;
  // Milliseconds since epoch. APNs keeps retrying an offline device until then; 0 = now or never.
  expiresAt: number;
}

export interface Pusher {
  sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult>;
  close(): void;
}

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

export function apnsConfigFromEnv(env: NodeJS.ProcessEnv): ApnsConfig | null {
  const { APNS_KEY, APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_IPHONE_BUNDLE_ID } = env;
  if (!(APNS_KEY || APNS_KEY_PATH) || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) return null;
  return {
    key: APNS_KEY,
    keyPath: APNS_KEY_PATH,
    keyId: APNS_KEY_ID,
    teamId: APNS_TEAM_ID,
    bundleId: APNS_BUNDLE_ID,
    // The watch app's ID is the iPhone app's plus ".watchkitapp".
    iphoneBundleId: APNS_IPHONE_BUNDLE_ID || APNS_BUNDLE_ID.replace(/\.watchkitapp$/, ""),
  };
}

// The ring notification. Time-sensitive so it breaks through Focus modes that allow it;
// the ring fields ride along as custom keys so the tap can join the right conversation.
// It expires when the relay abandons the ring, since after that there's nothing to hear.
export function ringAlert(ring: RingPayload, expiresAt: number): AlertPush {
  return {
    payload: {
      aps: {
        alert: { title: ring.fromName, body: "Tap to listen" },
        sound: "default",
        "interruption-level": "time-sensitive",
        "thread-id": ring.conversationId,
      },
      ...ring,
    },
    collapseId: ring.conversationId,
    expiresAt,
  };
}

// Prototype (PREFETCH_PUSH): a second push for the same ring, sent once the sender has said
// something, so the watch's notification service extension downloads the message while the
// watch's network is still awake from the push, and a tap plays it without a request. It
// replaces the ring (same collapse ID) and carries no sound, so it shouldn't ring twice.
export function prefetchAlert(ring: RingPayload, expiresAt: number): AlertPush {
  return {
    payload: {
      aps: {
        alert: { title: ring.fromName, body: "Tap to listen" },
        "mutable-content": 1,
        "interruption-level": "time-sensitive",
        "thread-id": ring.conversationId,
      },
      ...ring,
      prefetch: 1,
    },
    collapseId: ring.conversationId,
    expiresAt,
  };
}

// The iPhone's ring: a PushToTalk push. The app reports the sender as the channel's active
// speaker, the system activates its audio, and the app joins the conversation and plays it.
// Expiration 0, as Apple recommends: a late wake for audio that's gone is worse than none.
// The body needs an "aps" dictionary even though Apple's example has none: without one, APNs
// accepts the push (200) but iOS never hands it to the app (seen on Steve's iPhone, and
// developer forums thread 772008). The ring fields go inside it and at the top level, where
// the app reads them.
export function pushToTalkRing(ring: RingPayload): AlertPush {
  const fields = { ...ring, activeSpeaker: ring.fromName };
  return { pushType: "pushtotalk", payload: { aps: fields, ...fields }, expiresAt: 0 };
}

export class DryRunPusher implements Pusher {
  sent: Array<{ token: string; env: ApnsEnvironment } & AlertPush> = [];

  async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    this.sent.push({ token, env, ...push });
    console.log(`[apns:dry-run] ${push.pushType ?? "alert"} -> ${token.slice(0, 8)}… (${env}) ${JSON.stringify(push.payload)}`);
    return { ok: true, status: 200, latencyMs: 0, dryRun: true };
  }

  close(): void {}
}

export class ApnsPusher implements Pusher {
  private config: ApnsConfig;
  private key: KeyObject;
  private hosts: Record<ApnsEnvironment, string>;
  private jwt: { token: string; issuedAt: number } | null = null;
  private sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

  // `hosts` is for tests, which point it at a local HTTP/2 server.
  constructor(config: ApnsConfig, hosts: Record<ApnsEnvironment, string> = HOSTS) {
    this.config = config;
    this.key = createPrivateKey(config.key ?? readFileSync(config.keyPath!));
    this.hosts = hosts;
  }

  // APNs rejects tokens older than an hour and throttles refreshes more often than every 20 minutes.
  private providerToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.issuedAt < 50 * 60) return this.jwt.token;
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${b64({ alg: "ES256", kid: this.config.keyId })}.${b64({ iss: this.config.teamId, iat: now })}`;
    const signature = sign("sha256", Buffer.from(unsigned), { key: this.key, dsaEncoding: "ieee-p1363" });
    this.jwt = { token: `${unsigned}.${signature.toString("base64url")}`, issuedAt: now };
    return this.jwt.token;
  }

  private session(env: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(env);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.hosts[env]);
    const forget = () => {
      if (this.sessions.get(env) === session) this.sessions.delete(env);
    };
    session.on("error", (err) => console.error(`[apns] ${env} session error:`, err.message));
    // APNs closes connections it considers idle (GOAWAY); the next push opens a new one.
    session.on("goaway", forget);
    session.on("close", forget);
    this.sessions.set(env, session);
    return session;
  }

  // A connection APNs dropped while it sat idle (overnight, say) can look open until the next
  // push fails on it with ECONNRESET. A push that fails before any HTTP status gets one more
  // try on a fresh connection.
  async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    const first = await this.attempt(token, env, push);
    if (first.status !== 0) return first;
    const stale = this.sessions.get(env);
    this.sessions.delete(env);
    stale?.destroy();
    const second = await this.attempt(token, env, push);
    return { ...second, latencyMs: first.latencyMs + second.latencyMs, reason: second.ok ? `retried after ${first.reason}` : second.reason };
  }

  private attempt(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    const started = performance.now();
    const body = JSON.stringify(push.payload);
    return new Promise((resolve) => {
      const req = this.session(env).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-push-type": push.pushType ?? "alert",
        "apns-topic": push.pushType === "pushtotalk" ? `${this.config.iphoneBundleId}.voip-ptt` : this.config.bundleId,
        // Time-sensitive: deliver immediately rather than batched for power.
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(push.expiresAt / 1000)),
        ...(push.collapseId ? { "apns-collapse-id": push.collapseId } : {}),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      let status = 0;
      let apnsId: string | undefined;
      let responseBody = "";
      req.setEncoding("utf8");
      req.on("response", (headers) => {
        status = Number(headers[":status"]);
        apnsId = headers["apns-id"] as string | undefined;
      });
      req.on("data", (chunk: string) => (responseBody += chunk));
      req.on("end", () => {
        let reason: string | undefined;
        if (responseBody) {
          try {
            reason = JSON.parse(responseBody).reason;
          } catch {
            reason = responseBody;
          }
        }
        resolve({ ok: status === 200, status, apnsId, reason, latencyMs: performance.now() - started, dryRun: false });
      });
      req.on("error", (err) => {
        resolve({ ok: false, status: 0, reason: err.message, latencyMs: performance.now() - started, dryRun: false });
      });
      req.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
