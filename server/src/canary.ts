// The Canary (OPS_DASHBOARD_SPEC.md, "Canary"): every 15 minutes the rolling job talks to the
// always-on Test Bot over the live relay as a dedicated account, the way an iPhone does, and
// times three steps: connect → hello-ack, talk-start → go-ahead, and talk-start → the first frame
// of the bot's greeting. It checks admission, the stored-session check, the friend lookup and the
// relay end to end; not APNs or FCM (the Test Bot is rung over its own connection).
//
// Its session is made once (tools/test-account.ts canary): users/{CANARY_USER_ID}/sessions/canary.
// Each run signs a short token for that session with the session signing key, so no long-lived
// token is stored anywhere. The Canary is left out of every usage number and live count.

import { randomUUID } from "node:crypto";
import type { Docs } from "./docs.ts";
import { Codec, type ServerMessage } from "./protocol.ts";
import { SessionSigner, parseSigningKey } from "./session.ts";

export const CANARY_DEVICE = "canary";

export interface CanaryResult {
  at: number;
  ok: boolean;
  connectMs?: number;
  goAheadMs?: number;
  firstFrameMs?: number;
  // The step that failed, and why.
  error?: string;
}

// A token for the Canary's stored session, good for ten minutes. `signer`: the session signing
// key, or its JSON.
export async function canaryToken(docs: Docs, userId: string, signer: SessionSigner | string): Promise<string> {
  const [session] = await docs.getAll([`users/${userId}/sessions/${CANARY_DEVICE}`]);
  if (typeof session?.sid !== "string") throw new Error("the Canary has no session (run: node tools/test-account.ts canary)");
  const key = typeof signer === "string" ? new SessionSigner(parseSigningKey(signer)) : signer;
  return key.issue({ sub: userId, sid: session.sid, dev: CANARY_DEVICE }, 10 * 60_000).token;
}

export interface CanaryOptions {
  relayUrl: string;
  token: string;
  botUserId: string;
  timeoutMs?: number;
  now?: () => number;
}

// One run: never throws; a failure is { ok: false, error }.
export async function runCanary(options: CanaryOptions): Promise<CanaryResult> {
  const now = options.now ?? (() => performance.now());
  const at = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const url = new URL("/v2/relay", options.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const result: CanaryResult = { at, ok: false };
  let ws: WebSocket | null = null;
  let stage = "connect";
  try {
    const t0 = now();
    // Node's WebSocket takes headers, as the apps' do: the token and the admission headers.
    ws = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${options.token}`,
        "x-oao-client-kind": "ios",
        "x-oao-build": "1",
        "x-oao-client-version": "canary",
        "x-oao-relay-protocol": "2",
        "x-oao-decode": "opus16k,pcm16le16k",
        "x-oao-encode": "pcm16le16k",
      },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    const inbox: Array<ServerMessage | "frame"> = [];
    let wake: (() => void) | null = null;
    ws.onmessage = (event) => {
      inbox.push(typeof event.data === "string" ? (JSON.parse(event.data) as ServerMessage) : "frame");
      wake?.();
    };
    const closed = new Promise<never>((_, reject) => {
      ws!.onerror = () => reject(new Error("the connection failed"));
      ws!.onclose = (e) => reject(new Error(`the relay closed the connection (${e.code})`));
    });
    // Closing at the end rejects it too, with nobody waiting.
    closed.catch(() => {});
    const deadline = t0 + timeoutMs;
    const next = async (match: (m: ServerMessage | "frame") => boolean): Promise<ServerMessage | "frame"> => {
      for (;;) {
        const i = inbox.findIndex(match);
        if (i >= 0) return inbox.splice(i, 1)[0];
        const left = deadline - now();
        if (left <= 0) throw new Error("timed out");
        await Promise.race([closed, new Promise<void>((r) => { wake = r; setTimeout(r, Math.min(left, 500)); })]);
      }
    };
    await Promise.race([closed, new Promise<void>((resolve) => { ws!.onopen = () => resolve(); })]);
    ws.send(JSON.stringify({ type: "hello", clientTime: Date.now() }));
    await next((m) => m !== "frame" && m.type === "hello-ack");
    result.connectMs = Math.round(now() - t0);

    stage = "go-ahead";
    const burstId = randomUUID();
    const t1 = now();
    ws.send(JSON.stringify({ type: "talk-start", to: options.botUserId, burstId, codec: "pcm16le16k" }));
    const decision = await next((m) => m !== "frame" && (m.type === "floor-granted" || m.type === "floor-denied" || m.type === "talk-refused" || m.type === "error"));
    if (decision === "frame" || decision.type !== "floor-granted") throw new Error(decision === "frame" ? "unexpected frame" : `${decision.type}${"reason" in decision ? ` ${decision.reason}` : ""}`);
    result.goAheadMs = Math.round(now() - t1);
    // Half a second of silence, so the bot has something to answer.
    for (let seq = 0; seq < 25; seq++) {
      const frame = Buffer.alloc(5 + 640);
      frame[0] = Codec.pcm16le16k;
      frame.writeUInt32BE(seq, 1);
      ws.send(frame);
    }
    ws.send(JSON.stringify({ type: "talk-end", burstId }));

    stage = "the bot's greeting";
    await next((m) => m === "frame");
    result.firstFrameMs = Math.round(now() - t1);
    result.ok = true;
    ws.send(JSON.stringify({ type: "leave", conversationId: decision.conversationId }));
  } catch (err) {
    result.error = `${stage}: ${(err as Error).message}`.slice(0, 200);
  } finally {
    ws?.close();
  }
  return result;
}
