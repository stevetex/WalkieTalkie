// Device registry and timing metrics. Both persist to plain JSON files under the data
// directory; this is a spike, not a database.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ApnsEnvironment } from "./apns.ts";
import type { MetricEvent, MetricsUpload } from "./protocol.ts";

export interface Device {
  userId: string;
  name: string;
  voipToken: string;
  apnsEnvironment: ApnsEnvironment;
  updatedAt: number;
}

export class DeviceStore {
  private devices = new Map<string, Device>();
  private file: string | null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "devices.json") : null;
    if (this.file && existsSync(this.file)) {
      for (const d of JSON.parse(readFileSync(this.file, "utf8")) as Device[]) this.devices.set(d.userId, d);
    }
  }

  get(userId: string): Device | undefined {
    return this.devices.get(userId);
  }

  list(): Device[] {
    return [...this.devices.values()];
  }

  upsert(device: Device): void {
    this.devices.set(device.userId, device);
    if (this.file) writeFileSync(this.file, JSON.stringify(this.list(), null, 2));
  }
}

export interface TimelineEntry {
  source: "server" | "sender" | "receiver";
  userId?: string;
  name: string;
  // Server clock, ms since epoch.
  t: number;
  detail?: string;
}

export class MetricsStore {
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

  upload(upload: MetricsUpload): void {
    for (const e of upload.events as MetricEvent[]) {
      this.push(
        upload.conversationId,
        { source: upload.role, userId: upload.userId, name: e.name, t: e.t + upload.clockOffsetMs, detail: e.detail },
        true,
      );
    }
  }

  conversationIds(): string[] {
    return [...this.timelines.keys()];
  }

  timeline(conversationId: string): TimelineEntry[] {
    return [...(this.timelines.get(conversationId) ?? [])].sort((a, b) => a.t - b.t);
  }

  private push(conversationId: string, entry: TimelineEntry, persist: boolean): void {
    let list = this.timelines.get(conversationId);
    if (!list) this.timelines.set(conversationId, (list = []));
    list.push(entry);
    if (persist && this.file) appendFileSync(this.file, JSON.stringify({ conversationId, entry }) + "\n");
  }
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
