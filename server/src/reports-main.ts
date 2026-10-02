// Renders the Ops dashboard's reports (reports.ts) and stores them in Firestore (opsReports).
// rollup-main.ts runs them all after the nightly rollup; the dashboard's Regenerate button starts
// the stats job with this file and one report's ID instead.
//
//   node src/reports-main.ts [id ...]      default: every report
//
// The same settings as the other stats jobs (job-env.ts): STATS_LOCAL_DIR for a local relay,
// TEST_BOT_USER_ID and CANARY_USER_ID for the bots, MINIMUM_BUILDS. On Google Cloud the Cost and
// quotas report also reads Cloud Monitoring.

import { parseMinimumBuilds } from "./contract.ts";
import { jobContext, type JobContext } from "./job-env.ts";
import { Monitoring } from "./monitoring.ts";
import { runReports } from "./reports.ts";
import { botsFromEnv } from "./stats.ts";

export async function reportsFromEnv(env: NodeJS.ProcessEnv, ids: string[] | null, ctx?: JobContext) {
  const job = ctx ?? (await jobContext(env));
  const monitoring = job.projectId && job.accessToken ? new Monitoring(job.projectId, job.accessToken) : null;
  return runReports(ids, { docs: job.docs, out: job.out, read: job.read, bots: botsFromEnv(env), minimumBuilds: parseMinimumBuilds(env.MINIMUM_BUILDS), now: Date.now(), monitoring });
}

if (import.meta.main) {
  const ids = process.argv.slice(2);
  const results = await reportsFromEnv(process.env, ids.length ? ids : null);
  for (const r of results) console.log(`[reports] ${r.id}: ${r.ok ? `${Math.round(r.bytes! / 1024)} KB` : `failed: ${r.error}`}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}
