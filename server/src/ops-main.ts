// Nowza Ops (OPS_DASHBOARD_SPEC.md, "Ops service"): the product dashboard on Cloud Run, behind
// Identity-Aware Proxy (Google sign-in for the accounts Steve grants). It serves the page
// (server/ops/) and a small JSON API that gathers every number server-side, so no token ever
// reaches the browser. It runs in the API's image as ops-viewer, which can read Firestore and
// Cloud Monitoring but not write, and start only the stats job.
//
//   GET  /                         the page
//   GET  /api/live                 every relay node's /admin/stats, summed (cached 3 s)
//   GET  /api/summary              statsLive (today and yesterday), the last 31 stats/{date}
//                                  documents, today / 7 days / 30 days, and the near-live
//                                  numbers from Cloud Monitoring (cached 60 s)
//   GET  /api/reports              each report: its name, when it was made, and how (60 s)
//   GET  /reports/{id}             a stored report, as a page
//   POST /api/reports/{id}/run     starts the stats job for that report (Regenerate)
//
// The caches mean several people viewing at once cost what one does. Each request is logged with
// who made it (IAP's X-Goog-Authenticated-User-Email): the header is trusted because nothing
// reaches the service except through IAP, and a request without it is refused.
//
//   PORT                   default 8080
//   OPS_LOCAL              1 = no sign-in, Cloud Monitoring panels show sample numbers, and
//                          Regenerate renders in this process. With STATS_LOCAL_DIR=<DATA_DIR>
//                          (job-env.ts) and RELAY_NODES=http://localhost:8080
//   RELAY_NODES            relay base URLs (default https://relay-1.nowza.app)
//   OPS_STATS_TOKEN        the relay's /admin/stats token (OPS_STATS_TOKEN_SECRET names a secret)
//   REGION                 the stats job's region (default us-central1)
//   MONITORING_DASHBOARD   the "Nowza Beta" dashboard's URL, for the header's link
//   TEST_BOT_USER_ID, CANARY_USER_ID, MINIMUM_BUILDS   for Regenerate run locally
//   REVISION               the git commit

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryDocs, type Docs } from "./docs.ts";
import type { FirestoreData } from "./firestore.ts";
import { DAY_MS, jobContext, relayNodes, utcDate, type JobContext } from "./job-env.ts";
import { Monitoring, sampleNearLive, type NearLive } from "./monitoring.ts";
import { fetchRelayStats, sumRelayStats, type LiveSummary } from "./ops-relay.ts";
import { REPORTS, runReports } from "./reports.ts";
import { botsFromEnv, mergeConversationStats, type ConversationStats } from "./stats.ts";
import { parseMinimumBuilds } from "./contract.ts";

const PAGE_DIR = join(import.meta.dirname, "..", "ops");
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/ops.css": { file: "ops.css", type: "text/css; charset=utf-8" },
  "/ops.js": { file: "ops.js", type: "text/javascript; charset=utf-8" },
};
// Bars and meters are sized with style attributes; no inline <style> or script.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// Reports are self-contained pages: their own styles and inline SVG, no scripts.
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; frame-ancestors 'none'; base-uri 'none'";

// A value worked out at most once per `ms`, however many ask meanwhile.
class Cached<T> {
  private value: { at: number; data: Promise<T> } | null = null;
  private ms: number;
  private load: () => Promise<T>;
  constructor(ms: number, load: () => Promise<T>) {
    this.ms = ms;
    this.load = load;
  }
  get(now = Date.now()): Promise<T> {
    if (!this.value || now - this.value.at >= this.ms) {
      const data = this.load();
      this.value = { at: now, data };
      // A failure isn't kept: the next request tries again.
      data.catch(() => {
        if (this.value?.data === data) this.value = null;
      });
    }
    return this.value.data;
  }
}

export interface DayRow {
  date: string;
  dau: number;
  wau: number;
  mau: number;
  conversations: number;
  accounts?: number;
  withTestBot?: { dau: number; wau: number; mau: number; conversations: number };
  // The day's growth numbers, for the 7-day sums.
  activity: { newAccounts: number; invitesCreated: number; invitesAccepted: number; onboardingFinished: number; onboardingWalkieTalkieOn: number };
}

export interface RangeNumbers {
  label: string;
  days: number;
  conversationStats: ConversationStats;
  withTestBot: ConversationStats;
}

export interface Summary {
  generatedAt: number;
  today: FirestoreData | null;
  yesterday: FirestoreData | null;
  // The newest stats/{date} document, whole (the usage snapshot, the day's activity).
  latestDaily: FirestoreData | null;
  // The last 31 days, oldest first, for the sparklines.
  days: DayRow[];
  ranges: { today: RangeNumbers; "7d": RangeNumbers; "30d": RangeNumbers };
  // The nightly storage audit's counts (opsReports/storage-audit), if it has run.
  storage: FirestoreData | null;
  monitoring: NearLive | null;
  links: { monitoring: string | null; alerts: string; uptime: string };
}

export interface OpsOptions {
  ctx: Pick<JobContext, "docs" | "out" | "read">;
  // Fresh documents each time (local runs: re-read the files).
  outDocs?: () => Docs;
  live: () => Promise<LiveSummary>;
  nearLive: () => Promise<NearLive | null>;
  // Starts the report job (Google Cloud) or renders it here (local).
  runReport: (id: string) => Promise<void>;
  local: boolean;
  projectId: string | null;
  monitoringDashboard: string | null;
  now?: () => number;
  log?: (line: string) => void;
}

function conversationsOf(stats: ConversationStats | undefined): number {
  return stats?.conversations ?? 0;
}

export async function buildSummary(out: Docs, nearLive: NearLive | null, links: Summary["links"], now: number): Promise<Summary> {
  const today = utcDate(now);
  const yesterday = utcDate(now - DAY_MS);
  const [[todayDoc, yesterdayDoc, storage], dailyDocs] = await Promise.all([
    out.getAll([`statsLive/${today}`, `statsLive/${yesterday}`, "opsReports/storage-audit"]),
    out.query("stats", { orderBy: { field: "date", direction: "DESCENDING" }, limit: 31 }),
  ]);
  const daily = dailyDocs.map((d) => d.data).filter((d) => typeof d.date === "string" && d.date < today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const days: DayRow[] = daily.map((d) => {
    const c = d.conversationStats as ConversationStats | undefined;
    const w = d.withTestBot as { dau: number; wau: number; mau: number; conversationStats: ConversationStats } | undefined;
    return {
      date: String(d.date),
      dau: Number(d.dau ?? 0),
      wau: Number(d.wau ?? 0),
      mau: Number(d.mau ?? 0),
      conversations: c ? c.conversations : Object.values((d.day as { conversations?: Record<string, number> } | undefined)?.conversations ?? {}).reduce((n, v) => n + v, 0),
      ...((d.usage as { accounts?: number } | undefined)?.accounts !== undefined ? { accounts: (d.usage as { accounts: number }).accounts } : {}),
      ...(w ? { withTestBot: { dau: w.dau, wau: w.wau, mau: w.mau, conversations: conversationsOf(w.conversationStats) } } : {}),
      activity: Object.fromEntries((["newAccounts", "invitesCreated", "invitesAccepted", "onboardingFinished", "onboardingWalkieTalkieOn"] as const).map((k) => [k, Number((d.day as Record<string, unknown> | undefined)?.[k] ?? 0)])) as DayRow["activity"],
    };
  });
  const range = (label: string, n: number): RangeNumbers => {
    const earlier = daily.filter((d) => String(d.date) >= utcDate(now - (n - 1) * DAY_MS));
    const people = [todayDoc?.conversationStats, ...earlier.map((d) => d.conversationStats)].filter(Boolean) as ConversationStats[];
    const withBot = [
      (todayDoc?.withTestBot as { conversationStats?: ConversationStats } | undefined)?.conversationStats,
      ...earlier.map((d) => (d.withTestBot as { conversationStats?: ConversationStats } | undefined)?.conversationStats),
    ].filter(Boolean) as ConversationStats[];
    return { label, days: n, conversationStats: mergeConversationStats(people), withTestBot: mergeConversationStats(withBot) };
  };
  return {
    generatedAt: now,
    today: todayDoc ?? null,
    yesterday: yesterdayDoc ?? null,
    latestDaily: daily.at(-1) ?? null,
    days,
    ranges: { today: range("today", 1), "7d": range("last 7 days", 7), "30d": range("last 30 days", 30) },
    storage: (storage?.data as FirestoreData | undefined) ?? null,
    monitoring: nearLive,
    links,
  };
}

export function createOps(options: OpsOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.log(line));
  const out = () => options.outDocs?.() ?? options.ctx.out;
  const project = options.projectId ?? "";
  const links: Summary["links"] = {
    monitoring: options.monitoringDashboard,
    alerts: `https://console.cloud.google.com/monitoring/alerting?project=${project}`,
    uptime: `https://console.cloud.google.com/monitoring/uptime?project=${project}`,
  };
  const live = new Cached(3_000, options.live);
  const nearLive = new Cached(60_000, () => options.nearLive().catch(() => null));
  const summary = new Cached(60_000, async () => buildSummary(out(), await nearLive.get(), links, now()));
  const reports = new Cached(60_000, async () => {
    const stored = await out().getAll(REPORTS.map((r) => `opsReports/${r.id}`));
    return REPORTS.map((r, i) => ({
      id: r.id,
      title: r.title,
      question: r.question,
      ...(stored[i]?.generatedAt ? { generatedAt: (stored[i]!.generatedAt as Date).getTime?.() ?? Number(stored[i]!.generatedAt) } : {}),
      ...(stored[i]?.status ? { status: String(stored[i]!.status) } : {}),
    }));
  });
  const page = (path: string) => readFileSync(join(PAGE_DIR, STATIC[path].file));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const user = headerValue(req, "x-goog-authenticated-user-email")?.replace(/^accounts\.google\.com:/, "");
    log(JSON.stringify({ severity: "INFO", message: `ops ${req.method} ${url.pathname}`, user: user ?? (options.local ? "local" : null), method: req.method, path: url.pathname }));
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true, revision: process.env.REVISION ?? "local" });
      if (!user && !options.local) return json(res, 403, { error: "forbidden", message: "Sign in through Identity-Aware Proxy." });
      if (req.method === "GET" && STATIC[url.pathname]) {
        res.writeHead(200, { "content-type": STATIC[url.pathname].type, "cache-control": "no-cache", "content-security-policy": PAGE_CSP, "x-content-type-options": "nosniff" });
        return void res.end(page(url.pathname));
      }
      if (req.method === "GET" && url.pathname === "/api/live") return json(res, 200, { ...(await live.get()), user: user ?? "local" });
      if (req.method === "GET" && url.pathname === "/api/summary") return json(res, 200, await summary.get());
      if (req.method === "GET" && url.pathname === "/api/reports") return json(res, 200, { reports: await reports.get() });
      const report = url.pathname.match(/^\/reports\/([a-z0-9-]+)$/);
      if (req.method === "GET" && report) {
        const [doc] = await out().getAll([`opsReports/${report[1]}`]);
        if (typeof doc?.html !== "string") return json(res, 404, { error: "not-found", message: "That report hasn't been made yet." });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": REPORT_CSP, "x-content-type-options": "nosniff" });
        return void res.end(doc.html);
      }
      const run = url.pathname.match(/^\/api\/reports\/([a-z0-9-]+)\/run$/);
      if (req.method === "POST" && run) {
        // A custom header a cross-site form can't send.
        if (headerValue(req, "x-ops-request") !== "1") return json(res, 403, { error: "forbidden", message: "missing X-Ops-Request" });
        if (!REPORTS.some((r) => r.id === run[1])) return json(res, 404, { error: "not-found", message: "no such report" });
        await options.runReport(run[1]);
        log(JSON.stringify({ severity: "NOTICE", message: `ops: ${user ?? "local"} asked for report ${run[1]}` }));
        return json(res, 202, { started: run[1], at: now() });
      }
      json(res, 404, { error: "not-found", message: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      log(JSON.stringify({ severity: "ERROR", message: `ops ${req.method} ${url.pathname}: ${(err as Error).message}` }));
      json(res, 500, { error: "internal", message: "Something went wrong; see the ops service's log." });
    }
  };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

// Starts the stats job with one report's ID (Cloud Run's run-with-overrides).
async function startReportJob(projectId: string, region: string, accessToken: () => Promise<string>, id: string): Promise<void> {
  const res = await fetch(`https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/jobs/stats:run`, {
    method: "POST",
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ overrides: { containerOverrides: [{ args: ["src/reports-main.ts", id] }] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`starting the stats job: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

if (import.meta.main) {
  const env = process.env;
  const local = env.OPS_LOCAL === "1";
  if (!local && env.STATS_LOCAL_DIR) throw new Error("STATS_LOCAL_DIR needs OPS_LOCAL=1");
  const ctx = await jobContext(env);
  const nodes = relayNodes(env);
  const token = env.OPS_STATS_TOKEN || null;
  const monitoring = ctx.projectId && ctx.accessToken ? new Monitoring(ctx.projectId, ctx.accessToken) : null;
  const region = env.REGION || "us-central1";
  const handler = createOps({
    ctx,
    // Locally the jobs write a file; read it afresh each time.
    ...(ctx.localDir ? { outDocs: () => new MemoryDocs(join(ctx.localDir!, "ops-docs.json")) } : {}),
    live: async () => sumRelayStats(await fetchRelayStats(nodes, token)),
    nearLive: async () => (local ? sampleNearLive() : (await monitoring?.nearLive()) ?? null),
    runReport: async (id) => {
      if (local) {
        await runReports([id], { docs: ctx.docs, out: ctx.out, read: ctx.read, bots: botsFromEnv(env), minimumBuilds: parseMinimumBuilds(env.MINIMUM_BUILDS), now: Date.now(), monitoring: null });
        return;
      }
      if (!ctx.projectId || !ctx.accessToken) throw new Error("no project to start the job in");
      await startReportJob(ctx.projectId, region, ctx.accessToken, id);
    },
    local,
    projectId: ctx.projectId,
    monitoringDashboard: env.MONITORING_DASHBOARD || null,
  });
  const port = Number(env.PORT ?? 8080);
  createServer((req, res) => void handler(req, res)).listen(port, () => {
    console.log(`[ops] listening on :${port}${local ? " (local: no sign-in, sample Monitoring numbers)" : ""}, relay nodes ${nodes.join(", ")}`);
  });
}
