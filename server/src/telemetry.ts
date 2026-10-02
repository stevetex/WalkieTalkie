// Beta telemetry (the "Over&Out Beta telemetry spec" Claude Doc, design decision 2026-09-28):
// short structured entries in Cloud Logging, kept 30 days, instead of whole timelines in
// Firestore. Every entry has a `kind`:
//
//   oao.conversation  the relay's record of one conversation: who, each ring and its APNs
//                     results, the outcome, a few intervals, and the relay's own events
//   oao.device        one device's summary of a conversation, worked out here from the timeline
//                     it uploads (which isn't kept): outcome, how it answered, latencies
//   oao.levels        how much quieter one device played a friend's bursts than the friend's
//                     device sent them (once both have uploaded their per-burst levels)
//   oao.timeline      a device's whole timeline, only for accounts in FULL_TIMELINE_USERS
//   oao.apns          a push APNs refused, or that went out only on a retry
//   oao.event         a device event outside conversations (the API's POST /v2/events)
//   oao.api           an API request that ended in a 4xx or 5xx
//   oao.registration  a push registration
//   oao.feedback      a problem report from the app (its note stays in Firestore)
//
// Entries carry account and device IDs, never names, push tokens or audio.

import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { MetricEvent, MetricsUpload } from "./protocol.ts";
import type { ConversationSummary, MetricsStore, TimelineEntry } from "./store.ts";
import { isClientKind, platformLabel } from "./contract.ts";

export interface TelemetryEntry {
  kind: string;
  [field: string]: unknown;
}

export type Severity = "INFO" | "WARNING" | "ERROR";

export interface LogSink {
  // Never blocks and never throws.
  write(entry: TelemetryEntry, severity?: Severity): void;
  // Sends anything buffered (on shutdown).
  flush(): Promise<void>;
}

// Cloud Run: a JSON line on stdout becomes a structured entry (jsonPayload), with its
// severity and message.
export class StdoutSink implements LogSink {
  private out: (line: string) => void;

  constructor(out: (line: string) => void = (line) => process.stdout.write(line + "\n")) {
    this.out = out;
  }

  write(entry: TelemetryEntry, severity: Severity = "INFO"): void {
    this.out(JSON.stringify({ severity, message: entry.kind, ...entry }));
  }

  async flush(): Promise<void> {}
}

// Local runs: one JSON line per entry in DATA_DIR/telemetry.jsonl, which the tools read with
// --local. Nowhere when there's no data directory.
export class FileSink implements LogSink {
  private file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "telemetry.jsonl") : null;
  }

  write(entry: TelemetryEntry, severity: Severity = "INFO"): void {
    if (!this.file) return;
    try {
      appendFileSync(this.file, JSON.stringify({ timestamp: new Date().toISOString(), severity, ...entry }) + "\n");
    } catch (err) {
      console.error(`[telemetry] couldn't write ${entry.kind}: ${(err as Error).message}`);
    }
  }

  async flush(): Promise<void> {}
}

export class MemorySink implements LogSink {
  entries: Array<TelemetryEntry & { severity: Severity }> = [];

  write(entry: TelemetryEntry, severity: Severity = "INFO"): void {
    this.entries.push({ ...entry, severity });
  }

  async flush(): Promise<void> {}

  of(kind: string): Array<TelemetryEntry & { severity: Severity }> {
    return this.entries.filter((e) => e.kind === kind);
  }
}

export interface CloudLoggingOptions {
  projectId: string;
  accessToken: () => Promise<string>;
  // Labels on every entry (the node, the revision).
  labels?: Record<string, string>;
  logId?: string;
  // Entries go out this long after the first one is buffered, or once this many are.
  batchMs?: number;
  maxBatch?: number;
  fetchFn?: typeof fetch;
}

// Relay nodes: entries:write with the node's service account (logging.logWriter). The
// container's stdout reaches Cloud Logging as plain text, so structured entries go this way.
export class CloudLoggingSink implements LogSink {
  private opts: Required<Omit<CloudLoggingOptions, "labels">> & { labels: Record<string, string> };
  private buffered: Array<{ jsonPayload: TelemetryEntry; severity: Severity; timestamp: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  private sends = new Set<Promise<void>>();

  constructor(options: CloudLoggingOptions) {
    this.opts = { logId: "oao-telemetry", batchMs: 2_000, maxBatch: 50, fetchFn: fetch, labels: {}, ...options };
  }

  write(entry: TelemetryEntry, severity: Severity = "INFO"): void {
    this.buffered.push({ jsonPayload: entry, severity, timestamp: new Date().toISOString() });
    if (this.buffered.length >= this.opts.maxBatch) return this.send();
    if (!this.timer) {
      this.timer = setTimeout(() => this.send(), this.opts.batchMs);
      this.timer.unref();
    }
  }

  async flush(): Promise<void> {
    this.send();
    await Promise.all(this.sends);
  }

  private send(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffered.length) return;
    const entries = this.buffered;
    this.buffered = [];
    const sending = this.post(entries)
      .catch((err: Error) => console.error(`[telemetry] couldn't send ${entries.length} entries: ${err.message}`))
      .finally(() => this.sends.delete(sending));
    this.sends.add(sending);
  }

  private async post(entries: CloudLoggingSink["buffered"]): Promise<void> {
    const body = JSON.stringify({
      logName: `projects/${this.opts.projectId}/logs/${this.opts.logId}`,
      resource: { type: "global", labels: { project_id: this.opts.projectId } },
      labels: this.opts.labels,
      entries,
      partialSuccess: true,
    });
    for (let attempt = 0; ; attempt++) {
      const res = await this.opts.fetchFn("https://logging.googleapis.com/v2/entries:write", {
        method: "POST",
        headers: { authorization: `Bearer ${await this.opts.accessToken()}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      if (attempt === 0 && (res.status === 429 || res.status >= 500)) continue;
      throw new Error(`entries:write ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}

// ---- The relay's conversation record ----

export type ConversationOutcome = "answered" | "missed" | "refused" | "unavailable" | "push-failed" | "live" | "unresolved";

export interface Ring {
  at: number;
  // "watch" or "iphone" as before Phase 0 (Android kinds by their own names).
  platform: string;
  devices: number;
  // Phase 0 relays: the ring's ID (a rollover or fallback keeps it), the device's client kind,
  // and the delivery's provider and mode.
  ringId?: string;
  clientKind?: string;
  provider?: string;
  mode?: string;
  results: Array<{ kind: string; ok: boolean; status?: number; reason?: string; ms?: number; retried?: boolean; simulated?: boolean }>;
}

export interface ConversationRecord extends TelemetryEntry {
  kind: "oao.conversation";
  conversationId: string;
  from?: string;
  to?: string;
  outcome: ConversationOutcome;
  delivered: boolean;
  moved: boolean;
  // The Test Bot answered (test-bot.ts): `to` is the bot, not a person.
  testBot?: boolean;
  // The first ring's device kind, for log-based metric labels (which can't index arrays).
  ringPlatform?: string;
  // Phase 0: the first ring's client kind and provider, and whether any ring was only simulated
  // (the FCM stub, or a dry run), so it's never counted as a delivered push.
  ringClientKind?: string;
  ringProvider?: string;
  simulatedDelivery?: boolean;
  rings: Ring[];
  bursts: number;
  // Usage (the spec's usage analytics): bursts and talk time from each side; the callee's are replies.
  callerBursts: number;
  calleeBursts: number;
  callerTalkMs: number;
  calleeTalkMs: number;
  intervals: Record<string, number>;
  events: Array<{ name: string; t: number; detail?: string }>;
}

// What happened to a conversation, from the relay's events (relay.ts).
export function conversationRecord(conversationId: string, events: TimelineEntry[]): ConversationRecord {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const has = (name: string) => sorted.some((e) => e.name === name);
  const first = (name: string) => sorted.find((e) => e.name === name);
  const talk = first("talkStart");
  const [from, to] = talk?.detail?.split(" -> ") ?? [];
  const rings: Ring[] = [];
  for (const e of sorted) {
    if (e.name === "pushSent") rings.push({ at: e.t, ...parsePushSent(e.detail), results: [] }); else if ((e.name === "pushAccepted" || e.name === "pushFailed") && rings.length) {
      rings.at(-1)!.results.push({ ok: e.name === "pushAccepted", ...parsePushDetail(e.detail) });
    }
  }
  const delivered = rings.some((r) => r.results.some((x) => x.ok && !x.simulated));
  let outcome: ConversationOutcome;
  if (has("ringRefused") || has("conversationRevoked")) outcome = "refused";
  else if (has("receiverJoined") && rings.length) outcome = "answered";
  else if (has("pushSkipped")) outcome = "unavailable";
  else if (rings.length && rings.every((r) => r.results.length > 0 && r.results.every((x) => !x.ok))) outcome = "push-failed";
  else if (has("ringTimedOut")) outcome = "missed";
  else if (!rings.length && talk && !has("pushFailed")) outcome = "live";
  else outcome = "unresolved";
  const intervals: Record<string, number> = {};
  const between = (key: string, a?: TimelineEntry, b?: TimelineEntry) => {
    if (a && b && b.t >= a.t) intervals[key] = Math.round(b.t - a.t);
  };
  const talked = { caller: { bursts: 0, ms: 0 }, callee: { bursts: 0, ms: 0 } };
  for (const e of sorted.filter((e) => e.name === "burstEnded")) {
    const match = e.detail?.match(/^(\S+) (\d+) ms/);
    if (!match) continue;
    const side = match[1] === from ? talked.caller : talked.callee;
    side.bursts += 1;
    side.ms += Number(match[2]);
  }
  const push = first("pushSent");
  between("talkToPushMs", talk, push);
  between("apnsAcceptMs", push, sorted.find((e) => e.name === "pushAccepted" && push && e.t >= push.t));
  between("pushToJoinMs", push, first("receiverJoined"));
  return {
    kind: "oao.conversation",
    conversationId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    outcome,
    delivered,
    moved: has("movedDevice"),
    ...(has("testBotAnswered") ? { testBot: true } : {}),
    ...(rings.length ? { ringPlatform: rings[0].platform } : {}),
    ...(rings[0]?.clientKind ? { ringClientKind: rings[0].clientKind } : {}),
    ...(rings[0]?.provider ? { ringProvider: rings[0].provider } : {}),
    ...(rings.some((r) => r.results.some((x) => x.simulated)) ? { simulatedDelivery: true } : {}),
    rings,
    bursts: sorted.filter((e) => e.name === "talkStart").length,
    callerBursts: talked.caller.bursts,
    calleeBursts: talked.callee.bursts,
    callerTalkMs: talked.caller.ms,
    calleeTalkMs: talked.callee.ms,
    intervals,
    events: sorted.map((e) => ({ name: e.name, t: e.t, ...(e.detail ? { detail: e.detail } : {}) })),
  };
}

// A ring's pushSent detail: "watch" or "watch, 2 devices" before Phase 0; since then one device,
// "watch; r_…; watchos apns/alert".
export function parsePushSent(detail: string | undefined): Omit<Ring, "at" | "results"> {
  const [first = "", ringId, target] = (detail ?? "").split(";").map((p) => p.trim());
  const [platform, count] = first.split(", ");
  const ring: Omit<Ring, "at" | "results"> = { platform: platform || "unknown", devices: count ? parseInt(count, 10) || 1 : 1 };
  if (ringId?.startsWith("r_")) ring.ringId = ringId;
  const match = target?.match(/^(\w+) (\w+)\/(\w+)$/);
  if (match) Object.assign(ring, { clientKind: match[1], provider: match[2], mode: match[3] });
  return ring;
}

// "alert: status 410 Unregistered in 52 ms", "pushtotalk: status 200 retried after ECONNRESET
// in 80 ms (dry run)", "fcm-notification: status 200 in 0 ms (simulated)", "in-app ring",
// "device lookup: …".
export function parsePushDetail(detail: string | undefined): { kind: string; status?: number; reason?: string; ms?: number; retried?: boolean; simulated?: boolean } {
  const match = detail?.match(/^([\w-]+): status (\d+)(?: (.*?))? in (\d+) ms/);
  if (!match) return { kind: detail?.split(":")[0] || "unknown" };
  const reason = match[3] || undefined;
  return {
    kind: match[1],
    status: Number(match[2]),
    ...(reason ? { reason } : {}),
    ms: Number(match[4]),
    ...(reason?.startsWith("retried after") ? { retried: true } : {}),
    ...(detail?.endsWith("(simulated)") ? { simulated: true } : {}),
  };
}

// ---- A device's summary of a conversation ----

export interface DeviceInfo {
  platform?: string;
  // v2 clients: ios, watchos, android or wearos.
  clientKind?: string;
  model?: string;
  os?: string;
  build?: string;
}

export interface DeviceSummary extends TelemetryEntry {
  kind: "oao.device";
  conversationId: string;
  userId: string;
  deviceId?: string;
  role: string;
  platform: string;
  // Phase 0 clients say their kind (ios, watchos, android, wearos).
  clientKind?: string;
  outcome: string;
  via?: string;
  route?: string;
  intervals: Record<string, number>;
  problems: Record<string, number>;
  // Medians over the conversation's bursts (dBFS), from burstLevelSent / burstLevelPlayed.
  levels?: Levels;
}

export interface Levels {
  sentRmsDb?: number;
  sentPeakDb?: number;
  sentBursts?: number;
  playedRmsDb?: number;
  playedPeakDb?: number;
  playedBursts?: number;
}

// A burst's level as the apps mark it: "rms=-23.4,peak=-6.1,frames=150,clipped=0,in=…".
export interface BurstLevel {
  rms: number;
  peak: number;
  frames: number;
  clipped: number;
}

export function parseLevel(detail: string | undefined): BurstLevel | null {
  const fields = Object.fromEntries((detail ?? "").split(",").map((part) => part.split("=") as [string, string]));
  const [rms, peak, frames, clipped] = [fields.rms, fields.peak, fields.frames, fields.clipped ?? "0"].map(Number);
  return [rms, peak, frames, clipped].every(Number.isFinite) ? { rms, peak, frames, clipped } : null;
}

// Thresholds for the level problems (the plan: tuned from the first week of data). Bursts
// shorter than half a second are left out: a tap on Talk is silent on purpose.
export const LEVEL_PROBLEMS = {
  minFrames: 25,
  // A muted or covered microphone.
  silentSentRmsDb: -50,
  // Frames arrived but what was played is next to nothing.
  silentPlayedRmsDb: -60,
  // More than this share of a sent burst's samples at full scale.
  clippedShare: 0.01,
};

// Events that mean something went wrong or was slow, counted in the summary.
const PROBLEMS = ["relayClosed", "relayDropped", "ringTimedOut", "nseFetchFailed", "mainStall", "processPaused", "pttLeft", "transmitFailed", "audioRestarted", "joinFailed"];

// From the timeline a device uploads (device clock, shifted by its clock offset) and the relay's
// events for the same conversation, when it still has them.
export function deviceSummary(upload: MetricsUpload & { device?: DeviceInfo; deviceId?: string }, serverEvents: TimelineEntry[]): DeviceSummary {
  const events = (upload.events as MetricEvent[]).map((e) => ({ ...e, t: e.t + (upload.clockOffsetMs || 0) })).sort((a, b) => a.t - b.t);
  const at = (name: string) => events.find((e) => e.name === name);
  const t = (name: string) => at(name)?.t;
  const platform = upload.device?.platform ?? (isClientKind(upload.device?.clientKind) ? platformLabel(upload.device.clientKind) : inferPlatform(events));
  const answer = at("answerTapped");
  const via = answer?.detail;
  // The relay's push time: from the ring's payload (on the device's timeline) or the relay's events.
  const sentAtDetail = Number(at("pushSentAtServer")?.detail);
  const pushSent = Number.isFinite(sentAtDetail) && sentAtDetail > 0
    ? sentAtDetail
    : lastBefore(serverEvents.filter((e) => e.name === "pushSent").map((e) => e.t), answer?.t ?? t("pttPushReceived") ?? Infinity);
  const intervals: Record<string, number> = {};
  const put = (key: string, a: number | undefined, b: number | undefined) => {
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b >= a) intervals[key] = Math.round(b - a);
  };
  const received = t("pttPushReceived") ?? t("notificationDelivered") ?? t("pushReceived");
  const firstAudio = t("firstAudioScheduled");
  if (upload.role === "receiver") {
    put("ringDeliveryMs", pushSent, received);
    const ptt = via === "pushtotalk" || at("pttPushReceived") !== undefined;
    if (ptt) {
      put("pushToFirstAudioMs", pushSent, firstAudio);
      put("receivedToJoinedMs", t("pttPushReceived"), t("joined"));
      put("receivedToAudioMs", t("pttPushReceived"), t("audioActivated"));
    } else {
      put("tapToFirstAudioMs", answer?.t, firstAudio);
      put("tapToJoinedMs", answer?.t, t("joined"));
      put("tapToAudioMs", answer?.t, t("audioActivated"));
      put("humanAnswerMs", t("notificationDelivered"), t("notificationOpened"));
    }
  } else {
    put("talkToGoAheadMs", t("talkPressed"), t("floorGranted"));
    put("talkToFirstFrameMs", t("talkPressed"), t("firstFrameSent"));
  }
  let outcome: string;
  if (at("ringDeclined")) outcome = "declined";
  else if (upload.role === "sender") outcome = at("floorGranted") ? "sent" : "not-sent";
  else if (at("joined")) outcome = "answered";
  else if (at("ringTimedOut")) outcome = "missed";
  else outcome = "ended";
  const problems: Record<string, number> = {};
  for (const e of events) if (PROBLEMS.includes(e.name)) problems[e.name] = (problems[e.name] ?? 0) + 1;
  const sent = events.filter((e) => e.name === "burstLevelSent").map((e) => parseLevel(e.detail)).filter((l): l is BurstLevel => l !== null);
  const played = events.filter((e) => e.name === "burstLevelPlayed").map((e) => parseLevel(e.detail)).filter((l): l is BurstLevel => l !== null);
  const add = (name: string, n: number) => n && (problems[name] = n);
  const long = (l: BurstLevel) => l.frames >= LEVEL_PROBLEMS.minFrames;
  add("silentBurstSent", sent.filter((l) => long(l) && l.rms < LEVEL_PROBLEMS.silentSentRmsDb).length);
  add("silentBurstPlayed", played.filter((l) => long(l) && l.rms < LEVEL_PROBLEMS.silentPlayedRmsDb).length);
  add("clippedBurstSent", sent.filter((l) => long(l) && l.clipped / (l.frames * 320) > LEVEL_PROBLEMS.clippedShare).length);
  const levels: Levels = {
    ...(sent.length ? { sentRmsDb: medianOf(sent.map((l) => l.rms)), sentPeakDb: medianOf(sent.map((l) => l.peak)), sentBursts: sent.length } : {}),
    ...(played.length ? { playedRmsDb: medianOf(played.map((l) => l.rms)), playedPeakDb: medianOf(played.map((l) => l.peak)), playedBursts: played.length } : {}),
  };
  // Output ports only ("BluetoothHFP", "Speaker"); the route never names a device.
  const route = at("audioActivated")?.detail?.split(",")[0];
  return {
    kind: "oao.device",
    conversationId: upload.conversationId,
    userId: upload.userId,
    ...(upload.deviceId ? { deviceId: upload.deviceId } : {}),
    role: upload.role,
    platform,
    ...(upload.device?.clientKind ? { clientKind: upload.device.clientKind } : {}),
    ...(upload.device?.model ? { model: upload.device.model } : {}),
    ...(upload.device?.os ? { os: upload.device.os } : {}),
    ...(upload.device?.build ? { build: upload.device.build } : {}),
    outcome,
    ...(via ? { via } : {}),
    ...(route ? { route } : {}),
    intervals,
    problems,
    ...(Object.keys(levels).length ? { levels } : {}),
  };
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 10) / 10;
}

function inferPlatform(events: Array<{ name: string; detail?: string }>): string {
  if (events.some((e) => e.name === "pttPushReceived" || e.name === "pttLeft")) return "iphone";
  if (events.some((e) => ["notificationDelivered", "notificationOpened", "nseReceived", "preconnectStarted"].includes(e.name))) return "watch";
  return "unknown";
}

function lastBefore(times: number[], limit: number): number | undefined {
  const earlier = times.filter((x) => x <= limit);
  return earlier.length ? earlier.at(-1) : times[0];
}

// A device's whole timeline, for accounts marked for full detail. Free-text "log" lines are
// left out: they can name friends.
export function timelineEntry(upload: MetricsUpload & { deviceId?: string }): TelemetryEntry {
  return {
    kind: "oao.timeline",
    conversationId: upload.conversationId,
    userId: upload.userId,
    ...(upload.deviceId ? { deviceId: upload.deviceId } : {}),
    role: upload.role,
    clockOffsetMs: upload.clockOffsetMs,
    events: (upload.events as MetricEvent[])
      .filter((e) => e.name !== "log")
      .map((e) => ({ name: e.name, t: e.t + (upload.clockOffsetMs || 0), ...(e.detail ? { detail: e.detail } : {}) })),
  };
}

// ---- The metrics store the relay writes to ----

export interface TelemetryStoreOptions {
  // A conversation's record is written this long after the relay forgets it
  // (conversationEnded), so trailing events make it in...
  endedMs?: number;
  // ...or, as a backstop, once no relay event has arrived for this long: longer than a ring
  // (35 s) and a conversation's quiet window (45 s).
  quietMs?: number;
  // How long a written conversation's events are kept, for the devices' uploads after it ends.
  recentMs?: number;
  // Accounts whose devices' whole timelines are logged too (FULL_TIMELINE_USERS).
  fullTimelineUsers?: Iterable<string>;
  // Also keeps everything here (local runs: the JSON store, for GET /admin/metrics).
  inner?: MetricsStore;
  node?: string;
  now?: () => number;
}

export class TelemetryMetricsStore implements MetricsStore {
  private sink: LogSink;
  private opts: Required<Omit<TelemetryStoreOptions, "inner" | "fullTimelineUsers">>;
  private inner: MetricsStore | null;
  private fullUsers: Set<string>;
  private buffered = new Map<string, { events: TimelineEntry[]; timer: NodeJS.Timeout }>();
  private recent = new Map<string, { events: TimelineEntry[]; at: number }>();
  // Devices' uploaded events, kept as long as `recent` for GET /admin/metrics/<id> (tools/report.ts
  // and the bot during a measurement run), never written anywhere.
  private uploaded = new Map<string, { events: TimelineEntry[]; at: number }>();
  // Each device's levels by conversation and user, until the other side's arrive (oao.levels).
  private levels = new Map<string, { byUser: Map<string, Levels>; written: Set<string>; at: number }>();

  constructor(sink: LogSink, options: TelemetryStoreOptions = {}) {
    this.sink = sink;
    this.opts = { endedMs: 2_000, quietMs: 120_000, recentMs: 10 * 60_000, node: hostname(), now: Date.now, ...options };
    this.inner = options.inner ?? null;
    this.fullUsers = new Set(options.fullTimelineUsers ?? []);
  }

  server(conversationId: string, name: string, t: number, detail?: string): void {
    this.inner?.server(conversationId, name, t, detail);
    let pending = this.buffered.get(conversationId);
    if (pending) clearTimeout(pending.timer);
    else pending = { events: [], timer: undefined as unknown as NodeJS.Timeout };
    pending.events.push({ source: "server", name, t, ...(detail ? { detail } : {}) });
    pending.timer = setTimeout(() => this.write(conversationId), name === "conversationEnded" ? this.opts.endedMs : this.opts.quietMs);
    pending.timer.unref();
    this.buffered.set(conversationId, pending);
    // A refused or retried push is its own entry too, so an alert can count them.
    if (name === "pushFailed" || name === "prefetchPushFailed" || (name === "pushAccepted" && detail?.includes("retried after"))) {
      const { kind: pushType, ...push } = parsePushDetail(detail);
      if (pushType === "in-app ring" || pushType === "local ring") return;
      // APNs' entries keep their kind (alerts count them); another provider's, or a stand-in's,
      // are oao.push, so they're never mistaken for APNs.
      const kind = pushType.startsWith("fcm") || push.simulated ? "oao.push" : "oao.apns";
      this.sink.write({ kind, conversationId, event: name, pushType, node: this.opts.node, ...(kind === "oao.push" ? { provider: pushType.split("-")[0] } : {}), ...push, ...(push.status === undefined && detail ? { detail } : {}) }, name === "pushAccepted" ? "INFO" : "WARNING");
    }
  }

  async upload(upload: MetricsUpload & { device?: DeviceInfo; deviceId?: string }): Promise<void> {
    await this.inner?.upload(upload);
    const server = this.buffered.get(upload.conversationId)?.events ?? this.recent.get(upload.conversationId)?.events ?? [];
    const now = this.opts.now();
    const kept = this.uploaded.get(upload.conversationId)?.events ?? [];
    const shifted = (upload.events as MetricEvent[]).map((e): TimelineEntry => ({ source: upload.role, userId: upload.userId, name: e.name, t: e.t + (upload.clockOffsetMs || 0), ...(e.detail ? { detail: e.detail } : {}) }));
    this.uploaded.set(upload.conversationId, { events: [...kept, ...shifted], at: now });
    const summary = deviceSummary(upload, server);
    this.sink.write(summary, Object.keys(summary.problems).length ? "WARNING" : "INFO");
    if (this.fullUsers.has(upload.userId)) this.sink.write(timelineEntry(upload));
    if (summary.levels) this.levelDrops(upload.conversationId, upload.userId, summary.levels, now);
  }

  // Once both sides have uploaded levels: for each direction, how much quieter the listener's
  // device played the talker's bursts than the talker's device sent them. A few dB is the
  // codec; more means audio is getting quieter between the two.
  private levelDrops(conversationId: string, userId: string, levels: Levels, now: number): void {
    let seen = this.levels.get(conversationId);
    if (!seen) this.levels.set(conversationId, (seen = { byUser: new Map(), written: new Set(), at: now }));
    seen.byUser.set(userId, levels);
    seen.at = now;
    for (const [from, a] of seen.byUser) {
      for (const [to, b] of seen.byUser) {
        const key = `${from}>${to}`;
        if (from === to || seen.written.has(key) || a.sentRmsDb === undefined || b.playedRmsDb === undefined) continue;
        seen.written.add(key);
        this.sink.write({
          kind: "oao.levels",
          conversationId,
          from,
          to,
          sentRmsDb: a.sentRmsDb,
          playedRmsDb: b.playedRmsDb,
          levelDropDb: Math.round((a.sentRmsDb - b.playedRmsDb) * 10) / 10,
        });
      }
    }
  }

  async conversations(): Promise<ConversationSummary[]> {
    if (this.inner) return this.inner.conversations();
    const all = new Map<string, TimelineEntry[]>([...[...this.recent].map(([id, r]) => [id, r.events] as const), ...[...this.buffered].map(([id, b]) => [id, b.events] as const)]);
    return [...all].map(([conversationId, events]) => ({ conversationId, startedAt: events.length ? Math.min(...events.map((e) => e.t)) : null, events: events.length }));
  }

  async timeline(conversationId: string): Promise<TimelineEntry[]> {
    if (this.inner) return this.inner.timeline(conversationId);
    return [
      ...(this.buffered.get(conversationId)?.events ?? this.recent.get(conversationId)?.events ?? []),
      ...(this.uploaded.get(conversationId)?.events ?? []),
    ].sort((a, b) => a.t - b.t);
  }

  async flush(): Promise<void> {
    for (const id of [...this.buffered.keys()]) this.write(id);
    await Promise.all([this.inner?.flush(), this.sink.flush()]);
  }

  private write(conversationId: string): void {
    const pending = this.buffered.get(conversationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.buffered.delete(conversationId);
    const record = conversationRecord(conversationId, pending.events);
    const bad = record.outcome === "push-failed" || record.outcome === "unresolved";
    this.sink.write({ ...record, node: this.opts.node }, bad ? "WARNING" : "INFO");
    const now = this.opts.now();
    this.recent.set(conversationId, { events: pending.events, at: now });
    for (const map of [this.recent, this.uploaded, this.levels]) {
      for (const [id, r] of map) if (now - r.at > this.opts.recentMs) map.delete(id);
    }
  }
}

// ---- Device events (POST /v2/events) ----

const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MAX_EVENTS = 50;

// Only short, known-shaped values: names, numbers, booleans and short strings, never free text
// longer than a line.
export function cleanEvents(body: unknown, caller: { userId: string; deviceId: string }): TelemetryEntry[] {
  const b = (body ?? {}) as { events?: unknown; device?: unknown };
  if (!Array.isArray(b.events)) return [];
  const device = cleanFields(b.device, 4);
  return b.events.slice(0, MAX_EVENTS).flatMap((raw): TelemetryEntry[] => {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.name !== "string" || !EVENT_NAME.test(e.name)) return [];
    return [{
      kind: "oao.event",
      name: e.name,
      userId: caller.userId,
      deviceId: caller.deviceId,
      ...(typeof e.t === "number" && Number.isFinite(e.t) ? { at: new Date(e.t).toISOString() } : {}),
      ...device,
      ...cleanFields(e.fields, 12),
    }];
  });
}

const RESERVED = new Set(["kind", "name", "userId", "deviceId", "at", "severity", "message"]);

function cleanFields(value: unknown, max: number): Record<string, string | number | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, v] of Object.entries(value).slice(0, max)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) || RESERVED.has(key)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else if (typeof v === "string") out[key] = v.replace(/[\p{Cc}]/gu, " ").slice(0, 200);
  }
  return out;
}
