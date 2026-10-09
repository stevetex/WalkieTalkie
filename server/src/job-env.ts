// What the stats jobs (rollup-main.ts, rolling-main.ts, reports-main.ts) and the Ops service
// (ops-main.ts) read and write, from their environment:
//
//   Google Cloud: Firestore and Cloud Logging with the service account's token (or, with
//   FIRESTORE_AUTH=gcloud, your gcloud account), and secrets named by NAME_SECRET variables.
//   STATS_LOCAL_DIR=<DATA_DIR>: a local relay's data directory. Accounts and telemetry are read
//   from its accounts.json and telemetry.jsonl; what the jobs write (stats, statsLive,
//   opsReports) goes to ops-docs.json beside them, so a job never rewrites the relay's file.
//
//   FIRESTORE_PROJECT, FIRESTORE_EMULATOR_HOST, FIRESTORE_AUTH   as in main.ts

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryDocs, type Docs } from "./docs.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { matchesQuery, readCloudLogging, type LogEntry } from "./log-reader.ts";
import { loadSecrets } from "./secrets.ts";

export type ReadEntries = (kinds: string[], since: Date, until: Date) => Promise<LogEntry[]>;

export interface JobContext {
  // Accounts and the rest of the database (read).
  docs: Docs;
  // Where summaries and reports are written, and read back by the dashboard. The same
  // database on Google Cloud.
  out: Docs;
  read: ReadEntries;
  // Google Cloud only.
  projectId: string | null;
  accessToken: (() => Promise<string>) | null;
  // STATS_LOCAL_DIR, when local.
  localDir: string | null;
}

export async function jobContext(env: NodeJS.ProcessEnv): Promise<JobContext> {
  if (env.STATS_LOCAL_DIR) {
    const dir = env.STATS_LOCAL_DIR;
    const file = join(dir, "telemetry.jsonl");
    const read: ReadEntries = async (kinds, since, until) => existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry)
        .filter((e) => matchesQuery(e, { kinds, since, until }))
      : [];
    return { docs: new MemoryDocs(join(dir, "accounts.json")), out: new MemoryDocs(join(dir, "ops-docs.json")), read, projectId: null, accessToken: null, localDir: dir };
  }
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST || undefined;
  const accessToken = env.FIRESTORE_AUTH === "gcloud" ? gcloudAccessToken() : metadataAccessToken();
  const projectId = env.FIRESTORE_PROJECT || (emulatorHost ? "demo-overandout" : await metadataProjectId());
  if (!emulatorHost) await loadSecrets(env, projectId, accessToken);
  const docs = new Firestore({ projectId, emulatorHost, accessToken });
  const read: ReadEntries = (kinds, since, until) => readCloudLogging({ kinds, since, until }, projectId, accessToken);
  return { docs, out: docs, read, projectId, accessToken, localDir: null };
}

// RELAY_NODES: comma-separated base URLs (default the one relay node).
export function relayNodes(env: NodeJS.ProcessEnv): string[] {
  const nodes = (env.RELAY_NODES || "https://relay-1.nowza.app").split(",").map((n) => n.trim().replace(/\/+$/, "")).filter(Boolean);
  for (const node of nodes) if (!/^https?:\/\//.test(node)) throw new Error(`RELAY_NODES: not a URL: ${node}`);
  return nodes;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
