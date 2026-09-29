// Beta telemetry (the "Over&Out Beta telemetry spec" Claude Doc, design decision 2026-09-28):
// short structured entries in Cloud Logging, kept 30 days, instead of whole timelines in
// Firestore. Every entry has a `kind`:
//
//   oao.conversation  the relay's record of one conversation: who, each ring and its APNs
//                     results, the outcome, a few intervals, and the relay's own events
//   oao.device        one device's summary of a conversation, worked out here from the timeline
//                     it uploads (which isn't kept): outcome, how it answered, latencies
//   oao.timeline      a device's whole timeline, only for accounts in FULL_TIMELINE_USERS
//   oao.apns          a push APNs refused, or that went out only on a retry
//   oao.event         a device event outside conversations (the API's POST /v1/events)
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
  platform: string;
  devices: number;
  results: Array<{ kind: string; ok: boolean; status?: number; reason?: string; ms?: number; retried?: boolean }>;
}

export interface ConversationRecord extends TelemetryEntry {
  kind: "oao.conversation";
  conversationId: string;
  from?: string;
  to?: string;
  outcome: ConversationOutcome;
  delivered: boolean;
  moved: boolean;
  // The first ring's device kind, for log-based metric labels (which can't index arrays).
  ringPlatform?: string;
  rings: Ring[];
  bursts: number;
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
    if (e.name === "pushSent") {
      const [platform, count] = (e.detail ?? "").split(", ");
      rings.push({ at: e.t, platform: platform || "unknown", devices: count ? parseInt(count, 10) || 1 : 1, results: [] });
    } else if ((e.name === "pushAccepted" || e.name === "pushFailed") && rings.length) {
      rings.at(-1)!.results.push({ ok: e.name === "pushAccepted", ...parsePushDetail(e.detail) });
    }
  }
  const delivered = rings.some((r) => r.results.some((x) => x.ok));
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
    ...(rings.length ? { ringPlatform: rings[0].platform } : {}),
    rings,
    bursts: sorted.filter((e) => e.name === "talkStart").length,
    intervals,
    events: sorted.map((e) => ({ name: e.name, t: e.t, ...(e.detail ? { detail: e.detail } : {}) })),
  };
}

// "alert: status 410 Unregistered in 52 ms", "pushtotalk: status 200 retried after ECONNRESET
// in 80 ms (dry run)", "in-app ring", "device lookup: …".
export function parsePushDetail(detail: string | undefined): { kind: string; status?: number; reason?: string; ms?: number; retried?: boolean } {
  const match = detail?.match(/^([\w-]+): status (\d+)(?: (.*?))? in (\d+) ms/);
  if (!match) return { kind: detail?.split(":")[0] || "unknown" };
  const reason = match[3] || undefined;
  return {
    kind: match[1],
    status: Number(match[2]),
    ...(reason ? { reason } : {}),
    ms: Number(match[4]),
    ...(reason?.startsWith("retried after") ? { retried: true } : {}),
  };
}

// ---- A device's summary of a conversation ----

export interface DeviceInfo {
  platform?: string;
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
  outcome: string;
  via?: string;
  route?: string;
  intervals: Record<string, number>;
  problems: Record<string, number>;
}

// Events that mean something went wrong or was slow, counted in the summary.
const PROBLEMS = ["relayClosed", "relayDropped", "ringTimedOut", "nseFetchFailed", "mainStall", "processPaused", "pttLeft", "transmitFailed", "audioRestarted", "joinFailed"];

// From the timeline a device uploads (device clock, shifted by its clock offset) and the relay's
// events for the same conversation, when it still has them.
export function deviceSummary(upload: MetricsUpload & { device?: DeviceInfo; deviceId?: string }, serverEvents: TimelineEntry[]): DeviceSummary {
  const events = (upload.events as MetricEvent[]).map((e) => ({ ...e, t: e.t + (upload.clockOffsetMs || 0) })).sort((a, b) => a.t - b.t);
  const at = (name: string) => events.find((e) => e.name === name);
  const t = (name: string) => at(name)?.t;
  const platform = upload.device?.platform ?? inferPlatform(events);
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
  // Output ports only ("BluetoothHFP", "Speaker"); the route never names a device.
  const route = at("audioActivated")?.detail?.split(",")[0];
  return {
    kind: "oao.device",
    conversationId: upload.conversationId,
    userId: upload.userId,
    ...(upload.deviceId ? { deviceId: upload.deviceId } : {}),
    role: upload.role,
    platform,
    ...(upload.device?.model ? { model: upload.device.model } : {}),
    ...(upload.device?.os ? { os: upload.device.os } : {}),
    ...(upload.device?.build ? { build: upload.device.build } : {}),
    outcome,
    ...(via ? { via } : {}),
    ...(route ? { route } : {}),
    intervals,
    problems,
  };
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
  // Also keeps everything here (local runs: the JSON store, for GET /v1/metrics).
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
  // Devices' uploaded events, kept as long as `recent` for GET /v1/metrics/<id> (tools/report.ts
  // and the bot during a measurement run), never written anywhere.
  private uploaded = new Map<string, { events: TimelineEntry[]; at: number }>();

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
      this.sink.write({ kind: "oao.apns", conversationId, event: name, pushType, node: this.opts.node, ...push, ...(push.status === undefined && detail ? { detail } : {}) }, name === "pushAccepted" ? "INFO" : "WARNING");
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
    for (const map of [this.recent, this.uploaded]) {
      for (const [id, r] of map) if (now - r.at > this.opts.recentMs) map.delete(id);
    }
  }
}

// ---- Device events (POST /v1/events) ----

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
