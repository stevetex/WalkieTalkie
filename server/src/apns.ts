// APNs provider for ring notifications (token-based auth, HTTP/2). A ring is a
// time-sensitive alert push that opens the app on tap (option C: no CallKit or VoIP push).
// Without credentials it runs in dry-run mode and only logs, which is what the tests use.

import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RingPayload } from "./protocol.ts";

export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  bundleId: string;
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
  const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = env;
  if (!APNS_KEY_PATH || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) return null;
  return { keyPath: APNS_KEY_PATH, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, bundleId: APNS_BUNDLE_ID };
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

export class DryRunPusher implements Pusher {
  sent: Array<{ token: string; env: ApnsEnvironment } & AlertPush> = [];

  async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    this.sent.push({ token, env, ...push });
    console.log(`[apns:dry-run] alert -> ${token.slice(0, 8)}… (${env}) ${JSON.stringify(push.payload)}`);
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
    this.key = createPrivateKey(readFileSync(config.keyPath));
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
    session.on("error", (err) => console.error(`[apns] ${env} session error:`, err.message));
    session.on("close", () => this.sessions.delete(env));
    this.sessions.set(env, session);
    return session;
  }

  sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    const started = performance.now();
    const body = JSON.stringify(push.payload);
    return new Promise((resolve) => {
      const req = this.session(env).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-push-type": "alert",
        "apns-topic": this.config.bundleId,
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
