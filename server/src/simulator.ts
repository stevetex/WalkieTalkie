// Development only: delivers ring notifications to an Apple Watch or iPhone simulator on
// this Mac with `xcrun simctl push`, so option C's notification → tap → join path can be
// tested without an APNs key. The simulator app registers a "simulator:<udid>:<bundle ID>"
// token. Enabled with SIMULATOR_PUSH=1, and only for a relay running on the same Mac: it
// runs a local command.

import { execFile } from "node:child_process";
import type { AlertPush, ApnsEnvironment, Pusher, PushResult } from "./apns.ts";

export const SIMULATOR_TOKEN_PREFIX = "simulator:";

export function parseSimulatorToken(token: string): { udid: string; bundleId: string } | null {
  const match = /^simulator:([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}):([A-Za-z0-9.-]+)$/i.exec(token);
  return match ? { udid: match[1], bundleId: match[2] } : null;
}

export type Exec = (file: string, args: string[], input: string) => Promise<{ code: number; stderr: string }>;

const runCommand: Exec = (file, args, input) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { timeout: 10_000 }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr: String(stderr) });
    });
    child.stdin?.end(input);
  });

// Sends simulator tokens with simctl and everything else through `next` (APNs or dry run).
export class SimulatorPusher implements Pusher {
  private next: Pusher;
  private exec: Exec;

  constructor(next: Pusher, exec: Exec = runCommand) {
    this.next = next;
    this.exec = exec;
  }

  async sendAlert(token: string, env: ApnsEnvironment, push: AlertPush): Promise<PushResult> {
    if (!token.startsWith(SIMULATOR_TOKEN_PREFIX)) return this.next.sendAlert(token, env, push);
    const started = performance.now();
    const target = parseSimulatorToken(token);
    if (!target) return { ok: false, status: 400, reason: "bad simulator token", latencyMs: 0, dryRun: false };
    const { code, stderr } = await this.exec("xcrun", ["simctl", "push", target.udid, target.bundleId, "-"], JSON.stringify(push.payload));
    const latencyMs = performance.now() - started;
    return code === 0
      ? { ok: true, status: 200, latencyMs, dryRun: false }
      : { ok: false, status: 500, reason: stderr.trim() || `simctl exited ${code}`, latencyMs, dryRun: false };
  }

  close(): void {
    this.next.close();
  }
}
