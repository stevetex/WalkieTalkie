// Reads telemetry entries (src/telemetry.ts) for the tools: from Cloud Logging with your gcloud
// credentials, or from a local relay's DATA_DIR/telemetry.jsonl.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gcloudAccessToken } from "../src/firestore.ts";

export interface Entry {
  timestamp: string;
  severity: string;
  kind: string;
  [field: string]: any;
}

export interface Selection {
  kinds: string[];
  since: Date;
  // Any of these field = value pairs (an OR); none = every entry of those kinds.
  anyOf?: Array<[string, string]>;
  // A local relay's data directory instead of Cloud Logging.
  local?: string;
  project?: string;
  limit?: number;
}

export async function readEntries(sel: Selection): Promise<Entry[]> {
  return sel.local ? readLocal(sel) : readCloud(sel);
}

function matches(e: Entry, sel: Selection): boolean {
  if (!sel.kinds.includes(e.kind)) return false;
  if (Date.parse(e.timestamp) < sel.since.getTime()) return false;
  return !sel.anyOf?.length || sel.anyOf.some(([field, value]) => e[field] === value);
}

function readLocal(sel: Selection): Entry[] {
  const file = join(sel.local!, "telemetry.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => matches(e, sel))
    .slice(-(sel.limit ?? 5000));
}

const quote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

async function readCloud(sel: Selection): Promise<Entry[]> {
  const project = sel.project ?? process.env.GCP_PROJECT ?? "walkie-talkie-relay";
  const token = await gcloudAccessToken()();
  const filter = [
    `(${sel.kinds.map((k) => `jsonPayload.kind=${quote(k)}`).join(" OR ")})`,
    `timestamp>=${quote(sel.since.toISOString())}`,
    ...(sel.anyOf?.length ? [`(${sel.anyOf.map(([f, v]) => `jsonPayload.${f}=${quote(v)}`).join(" OR ")})`] : []),
  ].join(" AND ");
  const out: Entry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-goog-user-project": project },
      body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, orderBy: "timestamp asc", pageSize: 1000, pageToken }),
    });
    if (!res.ok) throw new Error(`entries:list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as { entries?: Array<{ timestamp: string; severity?: string; jsonPayload?: Record<string, unknown> }>; nextPageToken?: string };
    for (const e of page.entries ?? []) {
      if (!e.jsonPayload) continue;
      out.push({ ...(e.jsonPayload as object), timestamp: e.timestamp, severity: e.severity ?? "DEFAULT" } as Entry);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < (sel.limit ?? 5000));
  return out;
}

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
