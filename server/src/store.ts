// Device registry and timing metrics. Relay nodes keep nothing durable themselves (option E),
// so in production both live in Firestore. Local runs and tests use the JSON stores, which
// persist to plain files under the data directory (or nowhere, with no data directory).

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ApnsEnvironment } from "./apns.ts";
import type { Firestore } from "./firestore.ts";
import type { MetricEvent, MetricsUpload } from "./protocol.ts";

export interface Device {
  userId: string;
  name: string;
  // An APNs device token, or a "local:" / "poll:" pseudo-token (see relay.ts).
  pushToken: string;
  apnsEnvironment: ApnsEnvironment;
  updatedAt: number;
}

export interface DeviceStore {
  get(userId: string): Promise<Device | undefined>;
  list(): Promise<Device[]>;
  upsert(device: Device): Promise<void>;
}

export interface TimelineEntry {
  source: "server" | "sender" | "receiver";
  userId?: string;
  name: string;
  // Server clock, ms since epoch.
  t: number;
  detail?: string;
}

export interface ConversationSummary {
  conversationId: string;
  startedAt: number | null;
  events: number;
}

export interface MetricsStore {
  // Records a relay event. Never blocks the relay and never throws.
  server(conversationId: string, name: string, t: number, detail?: string): void;
  upload(upload: MetricsUpload): Promise<void>;
  conversations(): Promise<ConversationSummary[]>;
  timeline(conversationId: string): Promise<TimelineEntry[]>;
  // Writes anything still buffered (on shutdown).
  flush(): Promise<void>;
}

export class JsonDeviceStore implements DeviceStore {
  private devices = new Map<string, Device>();
  private file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "devices.json") : null;
    if (this.file && existsSync(this.file)) {
      for (const d of readDevicesFile(this.file)) this.devices.set(d.userId, d);
    }
  }

  async get(userId: string): Promise<Device | undefined> {
    return this.devices.get(userId);
  }

  async list(): Promise<Device[]> {
    return [...this.devices.values()];
  }

  async upsert(device: Device): Promise<void> {
    this.devices.set(device.userId, device);
    if (this.file) writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2));
  }
}

// Files written before the switch to alert pushes call the token voipToken.
export function readDevicesFile(file: string): Device[] {
  return (JSON.parse(readFileSync(file, "utf8")) as Array<Device & { voipToken?: string }>).map(({ voipToken, ...d }) => ({
    ...d,
    pushToken: d.pushToken ?? voipToken ?? "",
  }));
}

export class JsonMetricsStore implements MetricsStore {
  private timelines = new Map<string, TimelineEntry[]>();
  private file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "metrics.jsonl") : null;
    if (this.file && existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const { conversationId, entry } = JSON.parse(line) as { conversationId: string; entry: TimelineEntry };
        this.push(conversationId, entry, false);
      }
    }
  }

  server(conversationId: string, name: string, t: number, detail?: string): void {
    this.push(conversationId, { source: "server", name, t, detail }, true);
  }

  async upload(upload: MetricsUpload): Promise<void> {
    for (const entry of uploadEntries(upload)) this.push(upload.conversationId, entry, true);
  }

  async conversations(): Promise<ConversationSummary[]> {
    return [...this.timelines.entries()].map(([conversationId, entries]) => summarize(conversationId, entries));
  }

  async timeline(conversationId: string): Promise<TimelineEntry[]> {
    return sortByTime(this.timelines.get(conversationId) ?? []);
  }

  async flush(): Promise<void> {}

  private push(conversationId: string, entry: TimelineEntry, persist: boolean): void {
    let list = this.timelines.get(conversationId);
    if (!list) this.timelines.set(conversationId, (list = []));
    list.push(entry);
    if (persist && this.file) appendFileSync(this.file, JSON.stringify({ conversationId, entry }) + "\n");
  }
}

// devices/{userId}
export class FirestoreDeviceStore implements DeviceStore {
  private db: Firestore;

  constructor(db: Firestore) {
    this.db = db;
  }

  async get(userId: string): Promise<Device | undefined> {
    const data = await this.db.get("devices", userId);
    return data ? toDevice(data) : undefined;
  }

  async list(): Promise<Device[]> {
    return (await this.db.list("devices")).map((d) => toDevice(d.data));
  }

  async upsert(device: Device): Promise<void> {
    await this.db.set("devices", device.userId, { ...device });
  }
}

function toDevice(data: Record<string, unknown>): Device {
  return {
    userId: String(data.userId),
    name: String(data.name),
    pushToken: String(data.pushToken),
    apnsEnvironment: data.apnsEnvironment === "production" ? "production" : "sandbox",
    updatedAt: Number(data.updatedAt),
  };
}

export interface FirestoreMetricsOptions {
  // A conversation's buffered server events are written once no new event has arrived
  // for this long (a conversation's fixed window is 45 s, and its ring timeout 35 s).
  quietMs?: number;
  // ...or as soon as this many are buffered.
  maxBuffered?: number;
  // Timeline documents are deleted by a Firestore TTL policy on expireAt.
  retentionMs?: number;
  node?: string;
  now?: () => number;
}

// timelines/{auto-id}: one document per writer per conversation. The node's own events
// are one document written once the conversation goes quiet, and each watch upload is
// another. So a conversation costs about 3 writes, not one per event.
export class FirestoreMetricsStore implements MetricsStore {
  private db: Firestore;
  private buffered = new Map<string, { entries: TimelineEntry[]; timer: NodeJS.Timeout }>();
  private writes = new Set<Promise<void>>();
  private opts: Required<FirestoreMetricsOptions>;

  constructor(db: Firestore, options: FirestoreMetricsOptions = {}) {
    this.db = db;
    this.opts = {
      quietMs: 15_000,
      maxBuffered: 500,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      node: hostname(),
      now: Date.now,
      ...options,
    };
  }

  server(conversationId: string, name: string, t: number, detail?: string): void {
    let pending = this.buffered.get(conversationId);
    if (pending) clearTimeout(pending.timer);
    else pending = { entries: [], timer: undefined as unknown as NodeJS.Timeout };
    pending.entries.push({ source: "server", name, t, detail });
    pending.timer = setTimeout(() => this.write(conversationId), this.opts.quietMs);
    pending.timer.unref();
    this.buffered.set(conversationId, pending);
    if (pending.entries.length >= this.opts.maxBuffered) this.write(conversationId);
  }

  async upload(upload: MetricsUpload): Promise<void> {
    const entries = uploadEntries(upload);
    if (entries.length) await this.db.add("timelines", this.document(upload.conversationId, upload.role, upload.userId, entries));
  }

  // The newest 500 timeline documents, grouped by conversation. A diagnostics view, not
  // something clients call.
  async conversations(): Promise<ConversationSummary[]> {
    const docs = await this.db.query("timelines", { orderBy: { field: "createdAt", direction: "DESCENDING" }, limit: 500 });
    const byId = new Map<string, TimelineEntry[]>();
    for (const doc of docs) {
      const id = String(doc.data.conversationId);
      byId.set(id, [...(byId.get(id) ?? []), ...(doc.data.entries as TimelineEntry[])]);
    }
    for (const [id, { entries }] of this.buffered) byId.set(id, [...(byId.get(id) ?? []), ...entries]);
    return [...byId.entries()].map(([id, entries]) => summarize(id, entries));
  }

  async timeline(conversationId: string): Promise<TimelineEntry[]> {
    const docs = await this.db.query("timelines", { where: { field: "conversationId", op: "EQUAL", value: conversationId } });
    const entries = docs.flatMap((d) => d.data.entries as TimelineEntry[]);
    return sortByTime([...entries, ...(this.buffered.get(conversationId)?.entries ?? [])]);
  }

  async flush(): Promise<void> {
    for (const conversationId of [...this.buffered.keys()]) this.write(conversationId);
    await Promise.all(this.writes);
  }

  private write(conversationId: string): void {
    const pending = this.buffered.get(conversationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.buffered.delete(conversationId);
    const write = this.db
      .add("timelines", this.document(conversationId, "server", this.opts.node, pending.entries))
      .then(
        () => {},
        (err: Error) => console.error(`[metrics] couldn't write ${pending.entries.length} events for ${conversationId}: ${err.message}`),
      )
      .finally(() => this.writes.delete(write));
    this.writes.add(write);
  }

  private document(conversationId: string, source: TimelineEntry["source"], writer: string, entries: TimelineEntry[]) {
    const now = this.opts.now();
    return {
      conversationId,
      source,
      // The node's hostname for server documents, the user for watch uploads.
      writer,
      startedAt: Math.min(...entries.map((e) => e.t)),
      entries,
      createdAt: new Date(now),
      expireAt: new Date(now + this.opts.retentionMs),
    };
  }
}

function uploadEntries(upload: MetricsUpload): TimelineEntry[] {
  return (upload.events as MetricEvent[]).map((e) => ({
    source: upload.role,
    userId: upload.userId,
    name: e.name,
    t: e.t + upload.clockOffsetMs,
    detail: e.detail,
  }));
}

function summarize(conversationId: string, entries: TimelineEntry[]): ConversationSummary {
  const startedAt = entries.length ? Math.min(...entries.map((e) => e.t)) : null;
  return { conversationId, startedAt, events: entries.length };
}

function sortByTime(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => a.t - b.t);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
