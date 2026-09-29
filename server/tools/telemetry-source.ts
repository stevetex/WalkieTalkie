// Reads telemetry entries (src/telemetry.ts) for the tools: from Cloud Logging with your gcloud
// credentials, or from a local relay's DATA_DIR/telemetry.jsonl.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gcloudAccessToken } from "../src/firestore.ts";
import { matchesQuery, readCloudLogging, type LogEntry, type LogQuery } from "../src/log-reader.ts";

export type Entry = LogEntry;
export { percentile } from "../src/stats.ts";

export interface Selection extends LogQuery {
  // A local relay's data directory instead of Cloud Logging.
  local?: string;
  project?: string;
}

export async function readEntries(sel: Selection): Promise<Entry[]> {
  if (sel.local) return readLocal(sel.local, sel);
  return readCloudLogging(sel, sel.project ?? process.env.GCP_PROJECT ?? "walkie-talkie-relay", gcloudAccessToken());
}

export function readLocal(dataDir: string, q: LogQuery): Entry[] {
  const file = join(dataDir, "telemetry.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Entry)
    .filter((e) => matchesQuery(e, q))
    .slice(-(q.limit ?? 200_000));
}
