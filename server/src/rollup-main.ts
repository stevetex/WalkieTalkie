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
//   STATS_LOCAL_DIR   read DATA_DIR/telemetry.jsonl and accounts.json instead, and write to
//                     ops-docs.json beside them (local runs; job-env.ts)
//   TEST_BOT_USER_ID, CANARY_USER_ID
//                     the bots, left out of usage numbers (stats.ts)
//
// Then it renders the Ops dashboard's reports (reports-main.ts), unless OPS_REPORTS=0.

import type { Docs } from "./docs.ts";
import { jobContext } from "./job-env.ts";
import type { LogEntry } from "./log-reader.ts";
import { ACTIVITY_KINDS, botsFromEnv, dailyStats, providersOf, usageSnapshot, type Bots } from "./stats.ts";
import { StdoutSink } from "./telemetry.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// `out` is where stats/{date} goes (the same database, except in local runs: job-env.ts).
export async function rollup(date: string, docs: Docs, readEntries: (since: Date, until: Date) => Promise<LogEntry[]>, sink = new StdoutSink(), bots: Bots = {}, out: Docs = docs) {
  const until = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
  const since = new Date(until.getTime() - 30 * DAY_MS);
  const [entries, users] = await Promise.all([readEntries(since, until), docs.list("users")]);
  const usage = await usageSnapshot(docs, until.getTime(), users, bots);
  const stats = dailyStats(date, entries, usage, bots, providersOf(users));
  await out.commit([{ set: `stats/${date}`, data: { ...JSON.parse(JSON.stringify(stats)), createdAt: new Date() } }]);
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
  const ctx = await jobContext(env);
  const stats = await rollup(date, ctx.docs, (since, until) => ctx.read(ACTIVITY_KINDS, since, until), undefined, botsFromEnv(env), ctx.out);
  console.log(`[stats] ${date}: DAU ${stats.dau}, WAU ${stats.wau}, MAU ${stats.mau}, ${stats.day.talkers} talkers, ${stats.usage.accounts} accounts`);
}
