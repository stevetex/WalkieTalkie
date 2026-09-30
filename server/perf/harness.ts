// What the scenarios share: the relay under test (in its own process), bots, a recorder for
// what a bot hears, the integrity checks, and the results the run writes.

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SpikeClient } from "../tools/client.ts";
import { Codec, type ServerMessage } from "../src/protocol.ts";
import { LatencyProxy } from "./latency-proxy.ts";
import type { RelayStats } from "./relay-child.ts";

export const TOKEN = "perf";
// One way, the middle of the watch's measured 0.17–0.45 s round trips through its iPhone.
export const ONE_WAY_MS = 150;
// 24 kbps Opus in 20 ms frames.
export const OPUS_BYTES = 60;
export const PCM_BYTES = 640;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- Results ----

// How a metric is judged (compare.ts):
//   integrity  must be 0, always fails the build
//   count      exact; fails over its budget
//   approx     a count that depends on timing (POST batching); fails over its budget, which
//              has headroom
//   legs       one-way network trips under the simulated delay; judged against its budget
//   sim        milliseconds under a simulated network (delay and rate); judged against its budget
//   time       milliseconds on the runner; judged base vs head
//   load       load-test numbers; warn only
//   level, quality  the kit's audio measurements (compare.ts reads them from swift test)
//   info       recorded and watched for drift, never judged (the kit's bytes per frame, codec times)
export type Kind = "integrity" | "count" | "approx" | "legs" | "sim" | "time" | "load" | "level" | "quality" | "info";

export interface Metric {
  unit: string;
  kind: Kind;
  median: number;
  p95: number;
  n: number;
}

export class Results {
  metrics: Record<string, Metric> = {};
  errors: string[] = [];

  add(key: string, values: number | number[], unit: string, kind: Kind): void {
    const list = (Array.isArray(values) ? values : [values]).filter((v) => Number.isFinite(v));
    if (!list.length) return void this.errors.push(`${key}: no samples`);
    this.metrics[key] = { unit, kind, median: round(percentile(list, 50)), p95: round(percentile(list, 95)), n: list.length };
  }

  // Integrity failures: counted under the key, and each one described.
  fail(key: string, problems: string[]): void {
    const metric = this.metrics[key] ?? { unit: "failures", kind: "integrity" as const, median: 0, p95: 0, n: 0 };
    metric.median += problems.length;
    metric.p95 = metric.median;
    metric.n++;
    this.metrics[key] = metric;
    for (const p of problems.slice(0, 5)) this.errors.push(`${key}: ${p}`);
  }

  // Legs from a delayed timing: how many one-way trips it took.
  legs(key: string, values: number[], oneWayMs = ONE_WAY_MS): void {
    const ms = percentile(values, 50);
    this.metrics[key] = { unit: "legs", kind: "legs", median: Math.round(ms / oneWayMs), p95: Math.round(percentile(values, 95) / oneWayMs), n: values.length };
  }
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---- The relay under test ----

export interface Relay {
  port: number;
  url: string;
  stats(): Promise<RelayStats>;
  resetStats(): Promise<void>;
  close(): Promise<void>;
}

const childPath = fileURLToPath(new URL("./relay-child.ts", import.meta.url));
const children = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of children) child.kill();
});

// A bot on the HTTP transport posts its outbox in the background; a POST still in flight when
// a scenario closes its proxy fails with "fetch failed". That's the scenario ending, not a
// relay problem, so it's noted, not fatal.
export const lateErrors: string[] = [];
process.on("unhandledRejection", (err) => {
  const message = (err as Error)?.message ?? String(err);
  if (message === "fetch failed") lateErrors.push(message);
  else throw err;
});

export function startRelay(relayDir: string, options: Record<string, unknown> = {}): Promise<Relay> {
  const child: ChildProcess = fork(childPath, [JSON.stringify({ relayDir, options })], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: [...process.execArgv, "--expose-gc"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  const request = <T>(message: string, key: string): Promise<T> =>
    new Promise((resolve) => {
      const onMessage = (m: Record<string, unknown>) => {
        if (!(key in m)) return;
        child.off("message", onMessage);
        resolve(m[key] as T);
      };
      child.on("message", onMessage);
      child.send(message);
    });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`relay exited with ${code} before listening`)));
    const onPort = (m: Record<string, unknown>) => {
      if (typeof m.port !== "number") return;
      child.off("message", onPort);
      child.removeAllListeners("exit");
      const port = m.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        stats: () => request<RelayStats>("stats", "stats"),
        resetStats: () => request<boolean>("reset", "reset").then(() => {}),
        close: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.send("close");
            setTimeout(() => child.kill(), 3000).unref();
          }),
      });
    };
    child.on("message", onPort);
  });
}

// ---- Bots ----

let nextId = 0;
// Distinct user IDs per iteration, so nothing carries over between them.
export function ids(prefix: string): { a: string; b: string } {
  const n = nextId++;
  return { a: `${prefix}-a${n}`, b: `${prefix}-b${n}` };
}

// Registers a bot directly with the relay (not through a proxy: setup isn't measured).
// "poll:" = not connected, so a Talk rings it; "local:" = rung over its open connection.
export async function register(relay: Relay, userId: string, pushToken: string): Promise<void> {
  const res = await fetch(`${relay.url}/v1/devices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ userId, name: userId, pushToken, apnsEnvironment: "sandbox" }),
  });
  if (!res.ok) throw new Error(`registering ${userId}: HTTP ${res.status}`);
}

export function bot(server: string, userId: string, transport: "ws" | "http" = "ws"): SpikeClient {
  return new SpikeClient({ server, userId, token: TOKEN, transport });
}

export function proxy(relay: Relay, delayMs: number, kbps?: number): Promise<LatencyProxy> {
  return LatencyProxy.start({ target: relay.port, delayMs, ...(kbps ? { kbps } : {}) });
}

// POSTs to /v1/relay/send by user, for the HTTP transport's batching.
export const sendPosts = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/v1/relay/send") {
    const user = url.searchParams.get("userId") ?? "";
    sendPosts.set(user, (sendPosts.get(user) ?? 0) + 1);
  }
  return realFetch(input, init);
};

// ---- Audio ----

export interface Audio {
  codec: number;
  payloads: Buffer[];
}

// Frames whose bytes say which burst and frame they are, so a mix-up can't go unnoticed.
export function audio(codec: number, frames: number, seed: number): Audio {
  const bytes = codec === Codec.pcm16le16k ? PCM_BYTES : OPUS_BYTES;
  const payloads: Buffer[] = [];
  for (let seq = 0; seq < frames; seq++) {
    const payload = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) payload[i] = (seed * 31 + seq * 7 + i) & 0xff;
    payloads.push(payload);
  }
  return { codec, payloads };
}

export const opus = (frames: number, seed = nextId): Audio => audio(Codec.opus16k, frames, seed);
export const pcm = (frames: number, seed = nextId): Audio => audio(Codec.pcm16le16k, frames, seed);

export interface Talk {
  burstId: string;
  conversationId: string;
  pushed: boolean;
  pressedAt: number;
  grantedAt: number;
  sentAt: number[];
  releasedAt: number;
}

// A Talk: talk-start, wait for the go-ahead, the frames (every 20 ms if realtime), talk-end.
export async function talk(client: SpikeClient, to: string, sound: Audio, realtime: boolean, pressedAt = performance.now()): Promise<Talk> {
  const burstId = randomUUID();
  client.send({ type: "talk-start", to, burstId });
  const decision = await client.waitForMatch(
    (m) => (m.type === "floor-granted" || m.type === "floor-denied" || m.type === "talk-refused") && m.burstId === burstId,
    "floor decision",
    15_000,
  );
  const grantedAt = performance.now();
  if (decision.type !== "floor-granted") throw new Error(`${client.userId}: ${decision.type}`);
  const sentAt: number[] = [];
  const start = performance.now();
  for (let seq = 0; seq < sound.payloads.length; seq++) {
    client.sendFrame(sound.codec, seq, sound.payloads[seq]);
    sentAt.push(performance.now());
    // The press ends as the last frame is captured, not 20 ms later.
    if (realtime && seq < sound.payloads.length - 1) await sleep(Math.max(0, start + (seq + 1) * 20 - performance.now()));
  }
  client.send({ type: "talk-end", burstId });
  return { burstId, conversationId: decision.conversationId, pushed: decision.pushed, pressedAt, grantedAt, sentAt, releasedAt: performance.now() };
}

// ---- What a bot hears ----

export interface HeardBurst {
  burstId: string;
  from: string;
  replay: boolean;
  startAt: number;
  frames: Array<{ frame: Buffer; at: number }>;
  endAt: number | null;
}

export class Recorder {
  bursts: HeardBurst[] = [];
  // Messages other than pings, with when they arrived.
  messages: Array<{ message: ServerMessage; at: number }> = [];
  problems: string[] = [];
  private current: HeardBurst | null = null;
  private waiters: Array<() => boolean> = [];

  constructor(client: SpikeClient) {
    client.onMessage = (message) => {
      const at = performance.now();
      this.messages.push({ message, at });
      if (message.type === "burst-start") {
        if (this.current) this.problems.push(`burst ${this.current.burstId} started over without a burst-end`);
        this.current = { burstId: message.burstId, from: message.from, replay: message.replay, startAt: at, frames: [], endAt: null };
        this.bursts.push(this.current);
      } else if (message.type === "burst-end") {
        const burst = this.bursts.find((b) => b.burstId === message.burstId);
        if (burst) burst.endAt = at;
        if (this.current?.burstId === message.burstId) this.current = null;
      } else if (message.type === "error") {
        this.problems.push(`relay error: ${message.message}`);
      }
      this.wake();
    };
    client.onFrame = (frame) => {
      if (this.current) this.current.frames.push({ frame, at: performance.now() });
      else this.problems.push("a frame outside any burst");
      this.wake();
    };
  }

  at(type: ServerMessage["type"]): number | undefined {
    return this.messages.find((m) => m.message.type === type)?.at;
  }

  burst(burstId: string): HeardBurst | undefined {
    return this.bursts.find((b) => b.burstId === burstId);
  }

  // Resolves once the burst has ended here.
  ended(burstId: string, timeoutMs = 15_000): Promise<HeardBurst> {
    return this.until(() => {
      const b = this.burst(burstId);
      return b?.endAt != null ? b : undefined;
    }, `the end of burst ${burstId}`, timeoutMs);
  }

  until<T>(check: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
    const now = check();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const waiter = (): boolean => {
        const value = check();
        if (value === undefined) return false;
        clearTimeout(timer);
        resolve(value);
        return true;
      };
      this.waiters.push(waiter);
    });
  }

  private wake(): void {
    this.waiters = this.waiters.filter((w) => !w());
  }
}

// ---- Integrity ----

const sha = (buffers: Buffer[]): string => {
  const hash = createHash("sha256");
  for (const b of buffers) hash.update(b);
  return hash.digest("hex");
};

// Did this burst arrive exactly as sent: every frame, in order, once, codec byte intact,
// replayed or live as expected, and closed with burst-end?
export function checkBurst(sent: Audio, heard: HeardBurst | undefined, expect: { replay: boolean }): string[] {
  if (!heard) return ["the burst never started"];
  const problems: string[] = [];
  if (heard.replay !== expect.replay) problems.push(`replay was ${heard.replay}, expected ${expect.replay}`);
  if (heard.endAt === null) problems.push("no burst-end");
  const frames = heard.frames.map((f) => f.frame);
  if (frames.length !== sent.payloads.length) problems.push(`${frames.length} frames, sent ${sent.payloads.length}`);
  frames.forEach((frame, i) => {
    if (frame[0] !== sent.codec) problems.push(`frame ${i}: codec ${frame[0]}, sent ${sent.codec}`);
    const seq = frame.readUInt32BE(1);
    if (seq !== i) problems.push(`frame ${i}: sequence number ${seq} (a gap, duplicate or reorder)`);
  });
  if (sha(frames.map((f) => f.subarray(5))) !== sha(sent.payloads)) problems.push("SHA-256 of the burst's payloads differs from what was sent");
  return problems;
}

// ---- Common setup ----

// Two bots in a live conversation: `a` rang `b`, who answered and heard that first burst.
export async function liveConversation(
  relay: Relay,
  prefix: string,
  servers: { a: string; b: string },
  transports: { a: "ws" | "http"; b: "ws" | "http" } = { a: "ws", b: "ws" },
): Promise<{ a: SpikeClient; b: SpikeClient; aHeard: Recorder; bHeard: Recorder; names: { a: string; b: string } }> {
  const names = ids(prefix);
  await register(relay, names.a, `local:${names.a}`);
  await register(relay, names.b, `poll:${names.b}`);
  const a = bot(servers.a, names.a, transports.a);
  const b = bot(servers.b, names.b, transports.b);
  const aHeard = new Recorder(a);
  const bHeard = new Recorder(b);
  await a.connect();
  const first = await talk(a, names.b, opus(5), false);
  await b.connect();
  b.send({ type: "join", conversationId: first.conversationId });
  await bHeard.ended(first.burstId);
  return { a, b, aHeard, bHeard, names };
}

export interface Context {
  relayDir: string;
  suite: "quick" | "full";
  results: Results;
}
