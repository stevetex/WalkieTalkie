// What the scenarios share: the relay under test (in its own process), bots, a recorder for
// what a bot hears, the integrity checks, and the results the run writes.
//
// Every Talk is format 2 (E2EE_SPEC.md), as the apps send it: each person's device registers
// real certificates, and bursts are sealed to the friend's keys and opened by the listener. The
// keys stay in this process (a registry by account), so sealing doesn't ask the API. Sealing a
// burst (its bundle and every frame) happens before its press is timed, so press-to-grant
// timings are the relay's and the network's, not the bot's crypto. Timings measured from an
// earlier event (C's turn gap, from the previous release) do include it: about a millisecond.
// A listener opens each frame as it arrives (microseconds for a 60-byte frame).

import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SpikeClient, type WireMessage } from "../tools/client.ts";
import { Codec, FRAME_HEADER_BYTES, type ServerMessage } from "../src/protocol.ts";
import { createEndpointSecrets, openEndpointSecrets, type EndpointKeys } from "../src/endpoint-keys.ts";
import type { FriendKeysJSON } from "../src/e2ee.ts";
import { LatencyProxy } from "./latency-proxy.ts";
import type { RelayStats } from "./relay-child.ts";

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
  // The telemetry entries it wrote (DATA_DIR/telemetry.jsonl), once it has closed.
  telemetry(): Array<Record<string, any>>;
}

// The operator's diagnostics token (SPIKE_TOKEN), for /admin/status.
export const ADMIN_TOKEN = "perf";

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

// relayDir's src/main.ts, run as a local relay is (HANDOFF's Simulator section): the account API
// in the same process on its JSON store, dev sign-ins, test deliveries, and dry-run pushes (no
// APNs key). Only these variables, so nothing from this shell (an APNs key, Firestore) leaks in.
// `env`: more settings for the relay (scenario F shortens the ring timeout).
export function startRelay(relayDir: string, env: Record<string, string> = {}): Promise<Relay> {
  const dataDir = mkdtempSync(join(tmpdir(), "oao-perf-"));
  const child: ChildProcess = fork(join(relayDir, "src", "main.ts"), [], {
    cwd: relayDir,
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      HOST: "127.0.0.1",
      STORE: "json",
      DATA_DIR: dataDir,
      SERVE_API: "1",
      DEV_APPLE_SIGNIN: "1",
      TEST_DELIVERY: "1",
      SPIKE_TOKEN: ADMIN_TOKEN,
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    execArgv: [...process.execArgv, "--expose-gc", "--import", pathToFileURL(childPath).href],
  });
  children.add(child);
  let telemetry: Array<Record<string, any>> = [];
  child.once("exit", () => {
    children.delete(child);
    const file = join(dataDir, "telemetry.jsonl");
    if (existsSync(file)) telemetry = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    rmSync(dataDir, { recursive: true, force: true });
  });
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
    const early = (code: number | null) => reject(new Error(`relay exited with ${code} before listening`));
    child.once("exit", early);
    const onPort = (m: Record<string, unknown>) => {
      if (typeof m.port !== "number") return;
      child.off("message", onPort);
      child.off("exit", early);
      const port = m.port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        stats: () => request<RelayStats>("stats", "stats"),
        resetStats: () => request<boolean>("reset", "reset").then(() => {}),
        telemetry: () => telemetry,
        close: () =>
          new Promise<void>((done) => {
            child.once("exit", () => done());
            child.send("close");
            setTimeout(() => child.kill("SIGKILL"), 5000).unref();
          }),
      });
    };
    child.on("message", onPort);
  });
}

// ---- People ----

export type ClientKind = "ios" | "watchos";

// A synthetic person: an account signed in on one device, registered to be rung, with that
// device's E2EE keys.
export interface Person {
  id: string;
  name: string;
  token: string;
  kind: ClientKind;
  deviceId: string;
  keys: EndpointKeys;
}

// How a person's device is rung: over its open relay connection (a bot, like the Test Bot), or
// by a push the relay's dry-run pusher accepts (a device that isn't connected yet; the watch's
// alert, the iPhone's PushToTalk).
export type Ringing = "connection" | "push";

let nextId = 0;
// Distinct names per iteration, so nothing carries over between them.
export function ids(prefix: string): { a: string; b: string } {
  const n = nextId++;
  return { a: `${prefix}-a${n}`, b: `${prefix}-b${n}` };
}

// Session tokens by account, so the fetch hook below can tell whose POST it is.
const owners = new Map<string, string>();

// Everyone signed in, by account: the key directory the bots seal to.
const people = new Map<string, Person>();

// A friend's keys, as GET /v2/friends lists them.
export async function directory(userId: string): Promise<FriendKeysJSON> {
  const person = people.get(userId);
  if (!person) return { phones: [], devices: [] };
  const { phoneCert, deviceCert, encCert } = person.keys.registration;
  return { phones: [phoneCert], devices: [{ deviceId: person.deviceId, clientKind: person.kind, deviceCert, encCert }], allDevicesHaveKeys: true };
}

// What every build since E2EE registers: format 2 only (a relay that also carries format 1, a
// PR's base, takes it too).
const CAPABILITIES = { relayProtocols: [2], audioFormats: [2], decode: ["opus16k", "pcm16le16k"], encode: ["opus16k", "pcm16le16k"], features: [] };

async function api(relay: Relay, method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const res = await fetch(new URL(path, relay.url), {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${json.error ?? ""}`);
  return json;
}

// Signs `name` in with a dev Apple identity on one device of `kind` and registers it. Directly
// with the relay (not through a proxy): setup isn't measured.
export async function signIn(relay: Relay, name: string, kind: ClientKind, ringing: Ringing): Promise<Person> {
  const deviceId = `${name}-${kind}`;
  const signedIn = await api(relay, "POST", "/v2/auth/apple", null, { identityToken: `dev:${name}`, nonce: "perf", name, deviceId, clientKind: kind });
  const token = signedIn.token as string;
  const id = signedIn.user.id as string;
  const keys = openEndpointSecrets(createEndpointSecrets(id, deviceId, kind), id, deviceId);
  const delivery = ringing === "connection"
    ? { provider: "test", mode: "connection" }
    : { provider: "apns", mode: kind === "ios" ? "pushtotalk" : "alert", token: createHash("sha256").update(name).digest("hex"), environment: "sandbox" };
  await api(relay, "PUT", "/v2/me/device", token, { clientKind: kind, delivery, availability: { enabled: true, notifications: "authorized" },
    capabilities: CAPABILITIES, e2ee: keys.registration });
  owners.set(token, id);
  const person = { id, name, token, kind, deviceId, keys };
  people.set(id, person);
  return person;
}

// Friends, through an invite: rings need friendship.
export async function befriend(relay: Relay, a: Person, b: Person): Promise<void> {
  const invite = await api(relay, "POST", "/v2/invites", a.token);
  await api(relay, "POST", `/v2/invites/${invite.code}/accept`, b.token);
}

// Two friends: `a` talks first and is rung over its connection; `b` isn't connected yet, so a
// Talk to b rings it with a push. Each device is the kind its transport stands for: the watch on
// the HTTP stream, the iPhone on the WebSocket.
export async function pair(relay: Relay, prefix: string, transports: { a: "ws" | "http"; b: "ws" | "http" } = { a: "ws", b: "ws" }): Promise<{ a: Person; b: Person }> {
  const names = ids(prefix);
  const a = await signIn(relay, names.a, kindFor(transports.a), "connection");
  const b = await signIn(relay, names.b, kindFor(transports.b), "push");
  await befriend(relay, a, b);
  return { a, b };
}

export function kindFor(transport: "ws" | "http"): ClientKind {
  return transport === "http" ? "watchos" : "ios";
}

export function bot(server: string, person: Person, transport: "ws" | "http" = "ws"): SpikeClient {
  return new SpikeClient({ server, userId: person.id, token: person.token, clientKind: person.kind, transport, e2ee: { keys: person.keys, directory } });
}

// The ring waiting for this person in this conversation, as its push carries it. Asked of the
// relay directly, before the answer is timed: the device has it from the push.
export async function ringFor(relay: Relay, person: Person, conversationId: string): Promise<{ ringId: string; expiresAt: number }> {
  const { rings } = (await bot(relay.url, person).api("GET", "/v2/rings/pending")) as { rings: Array<{ ringId: string; conversationId: string; expiresAt: number }> };
  const ring = rings.find((r) => r.conversationId === conversationId);
  if (!ring) throw new Error(`no ring for ${person.name} in ${conversationId}`);
  return ring;
}

export function proxy(relay: Relay, delayMs: number, kbps?: number): Promise<LatencyProxy> {
  return LatencyProxy.start({ target: relay.port, delayMs, ...(kbps ? { kbps } : {}) });
}

// POSTs to /v2/relay/send by account, for the HTTP transport's batching.
export const sendPosts = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/v2/relay/send") {
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const user = owners.get(token) ?? "";
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

// A burst sealed ahead of its press: the talk-start with its bundle, and each frame's payload
// as it goes on the wire (ciphertext and tag).
export interface Sealed {
  burstId: string;
  message: WireMessage;
  frames: Buffer[];
}

export async function seal(client: SpikeClient, to: string, sound: Audio): Promise<Sealed> {
  const burstId = randomUUID();
  const { message, cipher } = await client.sealedTalkStart(to, burstId, sound.codec === Codec.opus16k ? "opus16k" : "pcm16le16k");
  const frames = sound.payloads.map((payload, seq) => cipher.seal(sound.codec, seq, payload).subarray(FRAME_HEADER_BYTES));
  return { burstId, message, frames };
}

// A Talk: talk-start, wait for the go-ahead, the frames (every 20 ms if realtime), talk-end.
// Sealed first unless `sealed` is given (a scenario that times from before its connection).
export async function talk(client: SpikeClient, to: string, sound: Audio, realtime: boolean, pressedAt?: number, sealed?: Sealed): Promise<Talk> {
  const { burstId, message, frames } = sealed ?? await seal(client, to, sound);
  pressedAt ??= performance.now();
  client.send(message);
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
    client.sendFrame(sound.codec, seq, frames[seq]);
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
        this.problems.push(`relay error ${message.code}: ${message.message}`);
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
  const people = await pair(relay, prefix, transports);
  const a = bot(servers.a, people.a, transports.a);
  const b = bot(servers.b, people.b, transports.b);
  const aHeard = new Recorder(a);
  const bHeard = new Recorder(b);
  await a.connect();
  const first = await talk(a, people.b.id, opus(5), false);
  const { ringId } = await ringFor(relay, people.b, first.conversationId);
  await b.connect();
  b.send({ type: "join", conversationId: first.conversationId, ringId });
  await bHeard.ended(first.burstId);
  return { a, b, aHeard, bHeard, names: { a: people.a.id, b: people.b.id } };
}

export interface Context {
  relayDir: string;
  suite: "quick" | "full";
  results: Results;
}
