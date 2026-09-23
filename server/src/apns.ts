// APNs provider for VoIP pushes (token-based auth, HTTP/2). Without credentials it
// runs in dry-run mode and only logs, which is what the tests use.

import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

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

export interface VoipPusher {
  sendVoip(token: string, env: ApnsEnvironment, payload: object): Promise<PushResult>;
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

export class DryRunPusher implements VoipPusher {
  sent: Array<{ token: string; env: ApnsEnvironment; payload: object }> = [];

  async sendVoip(token: string, env: ApnsEnvironment, payload: object): Promise<PushResult> {
    this.sent.push({ token, env, payload });
    console.log(`[apns:dry-run] voip -> ${token.slice(0, 8)}… (${env}) ${JSON.stringify(payload)}`);
    return { ok: true, status: 200, latencyMs: 0, dryRun: true };
  }

  close(): void {}
}

export class ApnsPusher implements VoipPusher {
  private config: ApnsConfig;
  private key: KeyObject;
  private jwt: { token: string; issuedAt: number } | null = null;
  private sessions = new Map<ApnsEnvironment, ClientHttp2Session>();

  constructor(config: ApnsConfig) {
    this.config = config;
    this.key = createPrivateKey(readFileSync(config.keyPath));
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
    const session = connect(HOSTS[env]);
    session.on("error", (err) => console.error(`[apns] ${env} session error:`, err.message));
    session.on("close", () => this.sessions.delete(env));
    this.sessions.set(env, session);
    return session;
  }

  sendVoip(token: string, env: ApnsEnvironment, payload: object): Promise<PushResult> {
    const started = performance.now();
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      const req = this.session(env).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.providerToken()}`,
        "apns-push-type": "voip",
        "apns-topic": `${this.config.bundleId}.voip`,
        // Deliver now or never: a stale ring is worse than a missed one.
        "apns-priority": "10",
        "apns-expiration": "0",
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
