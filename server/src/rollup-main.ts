// The daily usage rollup (the Beta telemetry spec's "Usage analytics"): a Cloud Run job, run at
// 00:30 UTC by Cloud Scheduler (deploy/gcp/setup-stats.sh), in the API's image.
//
//   node src/rollup-main.ts [YYYY-MM-DD]      default: yesterday (UTC)
//
// Reads the 30 days of telemetry entries up to the end of that day from Cloud Logging and the
// accounts from Firestore, writes stats/{date} (totals only, no account IDs), and logs oao.daily
// entries (dau, wau, mau, talkers, conversations) for the dashboard. Safe to run again: the
// document is replaced.
//
//   FIRESTORE_PROJECT, FIRESTORE_EMULATOR_HOST, FIRESTORE_AUTH   as in main.ts
//   STATS_LOCAL_DIR   read DATA_DIR/telemetry.jsonl and accounts.json instead (local runs)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryDocs, type Docs } from "./docs.ts";
import { Firestore, gcloudAccessToken, metadataAccessToken, metadataProjectId } from "./firestore.ts";
import { matchesQuery, readCloudLogging, type LogEntry } from "./log-reader.ts";
import { ACTIVITY_KINDS, dailyStats, usageSnapshot } from "./stats.ts";
import { StdoutSink } from "./telemetry.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function rollup(date: string, docs: Docs, readEntries: (since: Date, until: Date) => Promise<LogEntry[]>, sink = new StdoutSink()) {
  const until = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
  const since = new Date(until.getTime() - 30 * DAY_MS);
  const [entries, usage] = await Promise.all([readEntries(since, until), usageSnapshot(docs, until.getTime())]);
  const stats = dailyStats(date, entries, usage);
  await docs.commit([{ set: `stats/${date}`, data: { ...JSON.parse(JSON.stringify(stats)), createdAt: new Date() } }]);
  const conversations = Object.values(stats.day.conversations).reduce((n, c) => n + c, 0);
  for (const [measure, value] of Object.entries({ dau: stats.dau, wau: stats.wau, mau: stats.mau, talkers: stats.day.talkers, conversations })) {
    sink.write({ kind: "oao.daily", date, measure, value });
  }
  return stats;
}

if (import.meta.main) {
  const env = process.env;
  const date = process.argv[2] ?? new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a date: ${date}`);
  let docs: Docs;
  let read: (since: Date, until: Date) => Promise<LogEntry[]>;
  if (env.STATS_LOCAL_DIR) {
    const dir = env.STATS_LOCAL_DIR;
    docs = new MemoryDocs(join(dir, "accounts.json"));
    const file = join(dir, "telemetry.jsonl");
    read = async (since, until) => existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogEntry)
        .filter((e) => matchesQuery(e, { kinds: ACTIVITY_KINDS, since, until }))
      : [];
  } else {
    const emulatorHost = env.FIRESTORE_EMULATOR_HOST || undefined;
    const accessToken = env.FIRESTORE_AUTH === "gcloud" ? gcloudAccessToken() : metadataAccessToken();
    const projectId = env.FIRESTORE_PROJECT || (emulatorHost ? "demo-overandout" : await metadataProjectId());
    docs = new Firestore({ projectId, emulatorHost, accessToken });
    read = (since, until) => readCloudLogging({ kinds: ACTIVITY_KINDS, since, until }, projectId, accessToken);
  }
  const stats = await rollup(date, docs, read);
  console.log(`[stats] ${date}: DAU ${stats.dau}, WAU ${stats.wau}, MAU ${stats.mau}, ${stats.day.talkers} talkers, ${stats.usage.accounts} accounts`);
}
