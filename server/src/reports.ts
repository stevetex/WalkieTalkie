// The Ops dashboard's reports (OPS_DASHBOARD_SPEC.md, "Reports"): questions that need joins,
// history or a closer look. Each renders to a finished page, plain HTML with inline SVG charts
// and totals only, stored at opsReports/{id} with its last 30 copies at
// opsReports/{id}/history/{date} (a TTL removes older ones). They're made nightly by the stats
// job after its rollup, or on request from the dashboard (reports-main.ts).
//
// None looks back further than Cloud Logging's 30 days. Retention keeps only cohort totals,
// added up night by night, so its table fills in over 30 nights without keeping any account's
// history.

import { isClientKind, platformLabel, type MinimumBuilds } from "./contract.ts";
import type { Docs } from "./docs.ts";
import type { FirestoreData, FirestoreDocument } from "./firestore.ts";
import { DAY_MS, utcDate, type ReadEntries } from "./job-env.ts";
import type { LogEntry } from "./log-reader.ts";
import type { Monitoring } from "./monitoring.ts";
import { SPEED_STEPS, activeAccounts, percentile, type Bots } from "./stats.ts";
import { toDevice } from "./accounts.ts";

export interface ReportContext {
  docs: Docs;
  out: Docs;
  read: ReadEntries;
  bots: Bots;
  minimumBuilds?: MinimumBuilds;
  now: number;
  monitoring: Monitoring | null;
}

interface Inputs {
  ctx: ReportContext;
  since: Date;
  until: Date;
  // The last 30 days' entries, read once for every report.
  entries: () => Promise<LogEntry[]>;
  users: () => Promise<FirestoreDocument[]>;
  // This report's stored document, if any (retention adds to its table).
  previous: FirestoreData | undefined;
}

interface Rendered {
  body: string;
  // Totals kept with the report for the next run or the dashboard (never account IDs).
  data?: FirestoreData;
}

interface Report {
  id: string;
  title: string;
  question: string;
  render(inputs: Inputs): Promise<Rendered>;
}

const READ_KINDS = ["oao.conversation", "oao.device", "oao.apns", "oao.push", "oao.action", "oao.levels", "oao.event"];

// ---- Helpers ----

export function escape(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}

const fmt = (n: number | undefined, digits = 0): string => (n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const pct = (part: number, whole: number): string => (whole ? `${fmt((part / whole) * 100, 1)}%` : "–");
const secs = (ms: number | undefined): string => (ms === undefined ? "–" : `${(ms / 1000).toFixed(2)} s`);

const KIND_NAMES: Record<string, string> = { ios: "iPhone", watchos: "Apple Watch", android: "Android phone", wearos: "Wear OS watch" };
const kindName = (k: string): string => KIND_NAMES[k] ?? k;

function table(head: string[], rows: Array<Array<string | number>>, numeric: number[] = []): string {
  if (!rows.length) return `<p class="empty">Nothing in this window yet.</p>`;
  const cell = (tag: string, v: string | number, i: number) => `<${tag}${numeric.includes(i) ? ' class="n"' : ""}>${typeof v === "number" ? fmt(v) : v}</${tag}>`;
  return `<div class="tbl"><table><thead><tr>${head.map((h, i) => cell("th", escape(h), i)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v, i) => cell("td", v, i)).join("")}</tr>`).join("")}</tbody></table></div>`;
}

// Horizontal bars, one per label.
function bars(items: Array<[string, number]>, unit = ""): string {
  if (!items.length) return "";
  const max = Math.max(...items.map(([, v]) => v), 1);
  const rowH = 24;
  const h = items.length * rowH + 4;
  const rows = items.map(([label, v], i) => {
    const w = Math.max(1, (v / max) * 300);
    return `<text x="0" y="${i * rowH + 16}" class="lbl">${escape(label)}</text><rect x="170" y="${i * rowH + 5}" width="${w.toFixed(1)}" height="14" rx="3" class="bar"/><text x="${(176 + w).toFixed(1)}" y="${i * rowH + 16}" class="val">${fmt(v, unit === "%" ? 1 : 0)}${unit}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 560 ${h}" role="img">${rows.join("")}</svg>`;
}

function page(report: Report, generatedAt: number, since: Date, until: Date, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(report.title)} · Over&amp;Out Ops</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&family=Barlow:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#f6efdd;--panel:#fffcf3;--ink:#10161b;--muted:#56607a;--line:#e4d9bd;--accent:#a64700;--fill:#ff8b1a;--s2:#4252a3;--warn:#a8660b;--warn-bg:#f8ead0;--indigo:#252a51;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1b1f3b;--panel:#252b4d;--ink:#fff6df;--muted:#b3c6d3;--line:#3a426b;--accent:#ff9d3f;--s2:#9fb0ff;--warn:#f3bd55;--warn-bg:#44391f;--indigo:#141833;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Barlow,system-ui,sans-serif}
header{background:var(--indigo);color:#fff6df;padding:14px 16px}header a{color:#ffb36b;font-weight:600;text-decoration:none}
main{max-width:1100px;margin:0 auto;padding:20px 16px 64px;display:flex;flex-direction:column;gap:22px}
h1,h2{font-family:"Barlow Semi Condensed",system-ui,sans-serif;margin:0}h1{font-size:26px}h2{font-size:19px;border-bottom:1px solid var(--line);padding-bottom:6px}
.meta{color:var(--muted);font-size:13px}.q{font-size:16px;margin:0}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.tbl{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13.5px}th{text-align:left;font:600 11.5px Barlow,sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}td.n,th.n{text-align:right;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}
.flag{background:var(--warn-bg);color:var(--warn);font-weight:600;border-radius:999px;padding:1px 8px;font-size:12px}
.empty,.note{color:var(--muted);font-size:13.5px;margin:0}
.chart{width:100%;max-width:640px;height:auto}.chart .lbl{font:12px Barlow,sans-serif;fill:var(--muted)}.chart .val{font:11.5px "IBM Plex Mono",monospace;fill:var(--ink)}.chart .bar{fill:var(--s2)}
.heat rect{stroke:var(--panel);stroke-width:2}
</style></head><body>
<header><a href="/">← Over&amp;Out Ops</a></header>
<main>
<div><h1>${escape(report.title)}</h1><p class="q">${escape(report.question)}</p>
<p class="meta">Generated ${new Date(generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC from ${since.toISOString().slice(0, 10)} to ${until.toISOString().slice(0, 10)} (UTC). Totals only: no names or account IDs.</p></div>
${body}
</main></body></html>`;
}

// The conversations usage numbers count (the bots' left out).
function conversations(entries: LogEntry[], bots: Bots): LogEntry[] {
  return entries.filter((e) => {
    if (e.kind !== "oao.conversation" || !e.to) return false;
    if (bots.canary && (e.from === bots.canary || e.to === bots.canary)) return false;
    return !(e.testBot === true || (bots.testBot && (e.from === bots.testBot || e.to === bots.testBot)));
  });
}

function kindOf(e: LogEntry): string {
  if (isClientKind(e.clientKind)) return e.clientKind;
  return e.platform === "iphone" ? "ios" : e.platform === "watch" ? "watchos" : String(e.platform ?? "unknown");
}

const ecosystem = (k: unknown): string => (k === "ios" || k === "watchos" ? "Apple" : k === "android" || k === "wearos" ? "Android" : "unknown");
const ecoPair = (e: LogEntry): string => {
  if (!e.fromClientKind || !e.toClientKind) return "unknown";
  return [ecosystem(e.fromClientKind), ecosystem(e.toClientKind)].sort().join("–");
};

// The Monday of a date's ISO week, as the cohort's name.
function weekOf(ms: number): string {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return utcDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

function depthRows(groups: Map<string, LogEntry[]>): Array<Array<string | number>> {
  return [...groups].sort((a, b) => b[1].length - a[1].length).map(([key, list]) => {
    const known = list.filter((e) => typeof e.turns === "number");
    const gaps = known.flatMap((e) => (e.replyGapsMs ?? []) as number[]);
    return [
      escape(key),
      list.length,
      known.length ? fmt(known.reduce((n, e) => n + e.turns, 0) / known.length, 1) : "–",
      pct(known.filter((e) => e.turns >= 1).length, known.length),
      secs(median(gaps)),
    ];
  });
}

// ---- The reports ----

export const REPORTS: Report[] = [
  {
    id: "retention-cohorts",
    title: "Retention cohorts",
    question: "Of the people who signed up in a week, how many came back on day 1, 7 and 30? By sign-in provider and by the devices they use.",
    async render({ ctx, entries, users, previous }) {
      // The day this run counts: yesterday (UTC), the day the rollup just closed.
      const date = utcDate(ctx.now - DAY_MS);
      const prior = (previous?.data ?? {}) as { table?: Record<string, Record<string, { eligible: number; active: number }>>; processed?: string[] };
      const table = structuredClone(prior.table ?? {});
      const processed = prior.processed ?? [];
      const all = await users();
      const people = all.filter((u) => u.id !== ctx.bots.testBot && u.id !== ctx.bots.canary);
      const sizes: Record<string, number> = {};
      for (const u of people) bump(sizes, weekOf(millis(u.data.createdAt)));
      if (!processed.includes(date)) {
        const dayStart = Date.parse(`${date}T00:00:00Z`);
        const active = activeAccounts((await entries()).filter((e) => Date.parse(e.timestamp) >= dayStart && Date.parse(e.timestamp) < dayStart + DAY_MS), ctx.bots);
        for (const u of people) {
          const created = millis(u.data.createdAt);
          const age = Math.round((dayStart - Date.parse(`${utcDate(created)}T00:00:00Z`)) / DAY_MS);
          if (![1, 7, 30].includes(age)) continue;
          const provider = String((u.data.identity as { provider?: string } | undefined)?.provider ?? "unknown");
          const devices = await ctx.docs.list(`users/${u.id}/devices`);
          const kinds = new Set(devices.flatMap((d) => toDevice(d.id, d.data) ?? []).map((d) => platformLabel(d.clientKind)));
          const deviceLabel = kinds.size ? [...kinds].sort().join("+").replace("iphone+watch", "both") : "none";
          for (const split of ["all", `provider:${provider}`, `devices:${deviceLabel}`]) {
            const key = `${weekOf(created)}|${split}`;
            const cell = ((table[key] ??= {})[`d${age}`] ??= { eligible: 0, active: 0 });
            cell.eligible++;
            if (active.has(u.id)) cell.active++;
          }
        }
        processed.push(date);
      }
      const show = (split: string) => {
        const weeks = Object.keys(sizes).sort().reverse().slice(0, 12);
        return weeks.map((w) => {
          const row = table[`${w}|${split}`] ?? {};
          const cell = (d: string) => (row[d] ? `${pct(row[d].active, row[d].eligible)} <span class="meta">of ${row[d].eligible}</span>` : "–");
          return [w, split === "all" ? sizes[w] : "", cell("d1"), cell("d7"), cell("d30")];
        }).filter((r) => split === "all" || r.slice(2).some((c) => c !== "–"));
      };
      const splits = [...new Set(Object.keys(table).map((k) => k.split("|")[1]).filter((s) => s !== "all"))].sort();
      const body = [
        `<section><h2>All sign-ups</h2>${tableFor(show("all"))}<p class="note">Each cell: the share of that week's sign-ups who talked or listened to a friend on day 1, 7 or 30 after signing up, counted on the night they reached it. The table fills in over 30 nights; runs before then leave cells empty.</p></section>`,
        ...splits.map((s) => `<section><h2>${escape(s.replace("provider:", "Signed in with ").replace("devices:", "Devices: "))}</h2>${tableFor(show(s))}</section>`),
      ].join("");
      return { body, data: { table, processed: processed.slice(-45) } };
    },
  },
  {
    id: "conversation-depth",
    title: "Conversation depth",
    question: "Who has longer conversations: which device pairs, hours and friend tenures?",
    async render({ ctx, entries }) {
      const list = conversations(await entries(), ctx.bots);
      const byPair = new Map<string, LogEntry[]>();
      const byHour = new Map<string, LogEntry[]>();
      const byTenure = new Map<string, LogEntry[]>();
      const sinceCache = new Map<string, number>();
      for (const e of list) {
        const pair = e.fromClientKind && e.toClientKind ? `${kindName(e.fromClientKind)} → ${kindName(e.toClientKind)}` : "unknown";
        (byPair.get(pair) ?? byPair.set(pair, []).get(pair)!).push(e);
        const hour = `${String(new Date(e.timestamp).getUTCHours()).padStart(2, "0")}:00`;
        (byHour.get(hour) ?? byHour.set(hour, []).get(hour)!).push(e);
        const key = [e.from, e.to].sort().join("|");
        if (!sinceCache.has(key) && sinceCache.size < 500) {
          const [friend] = await ctx.docs.getAll([`users/${e.from}/friends/${e.to}`]);
          sinceCache.set(key, millis(friend?.since));
        }
        const since = sinceCache.get(key) ?? 0;
        const days = since ? (Date.parse(e.timestamp) - since) / DAY_MS : NaN;
        const tenure = !Number.isFinite(days) ? "not friends now" : days < 7 ? "under a week" : days < 28 ? "1–4 weeks" : days < 91 ? "1–3 months" : "3 months or more";
        (byTenure.get(tenure) ?? byTenure.set(tenure, []).get(tenure)!).push(e);
      }
      const head = ["", "Conversations", "Back-and-forths (mean)", "Got a reply", "Median reply gap"];
      const hours = new Map([...byHour].sort((a, b) => a[0].localeCompare(b[0])));
      return {
        body: [
          `<section><h2>By device pair (caller → other side)</h2>${table(head, depthRows(byPair), [1, 2, 3, 4])}</section>`,
          `<section><h2>By friend tenure</h2>${table(head, depthRows(byTenure), [1, 2, 3, 4])}<p class="note">How long the two had been friends when they talked (friends.since).</p></section>`,
          `<section><h2>By hour of day (UTC)</h2>${table(head, depthRows(hours).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [1, 2, 3, 4])}</section>`,
          `<p class="note">Records from relays before back-and-forths were recorded count as conversations but not in the means.</p>`,
        ].join(""),
      };
    },
  },
  {
    id: "cross-platform",
    title: "Cross-platform conversations",
    question: "Do Apple–Android conversations go as well as Apple–Apple ones?",
    async render({ ctx, entries }) {
      const all = await entries();
      const list = conversations(all, ctx.bots);
      const pairOf = new Map(list.map((e) => [e.conversationId, ecoPair(e)]));
      const speed = new Map<string, number[]>();
      for (const e of all) {
        if (e.kind !== "oao.device" || e.role !== "receiver") continue;
        const pair = pairOf.get(e.conversationId);
        const ms = e.intervals?.tapToFirstAudioMs ?? e.intervals?.pushToFirstAudioMs;
        if (pair && typeof ms === "number") (speed.get(pair) ?? speed.set(pair, []).get(pair)!).push(ms);
      }
      const groups = new Map<string, LogEntry[]>();
      for (const e of list) (groups.get(ecoPair(e)) ?? groups.set(ecoPair(e), []).get(ecoPair(e))!).push(e);
      const rows = [...groups].map(([pair, l]) => {
        const accepted = l.filter((e) => e.delivered && !e.simulatedDelivery);
        const refusals = l.reduce((n, e) => n + ((e.events ?? []) as Array<{ name: string }>).filter((ev) => ev.name === "codecRefused" || ev.name === "burstUndecodable").length, 0);
        const known = l.filter((e) => typeof e.turns === "number");
        return [
          escape(pair),
          l.length,
          pct(accepted.filter((e) => e.outcome === "answered").length, accepted.length),
          known.length ? fmt(known.reduce((n, e) => n + e.turns, 0) / known.length, 1) : "–",
          secs(median(speed.get(pair) ?? [])),
          refusals,
          l.filter((e) => e.simulatedDelivery).length,
        ];
      });
      const outcomes = [...groups].map(([pair, l]) => {
        const counts: Record<string, number> = {};
        for (const e of l) bump(counts, e.outcome);
        return [escape(pair), ...["answered", "missed", "unavailable", "push-failed", "refused", "live"].map((o) => counts[o] ?? 0)];
      });
      return {
        body: [
          `<section><h2>By ecosystem pair</h2>${table(["Pair", "Conversations", "Answer rate", "Back-and-forths", "Median tap or push → audio", "Codec refusals", "Simulated rings"], rows, [1, 2, 3, 4, 5, 6])}<p class="note">Answer rate: answered ÷ rings a provider accepted (simulated deliveries, from the FCM stub, never count). "unknown": records from before each side's kind was recorded.</p></section>`,
          `<section><h2>Outcomes</h2>${table(["Pair", "Answered", "Missed", "Unavailable", "Push failed", "Refused", "Live"], outcomes, [1, 2, 3, 4, 5, 6])}</section>`,
        ].join(""),
      };
    },
  },
  {
    id: "speed-by-build",
    title: "Speed by build",
    question: "Did a build make any step slower?",
    async render({ ctx, entries }) {
      const devices = (await entries()).filter((e) => e.kind === "oao.device" && e.userId !== ctx.bots.testBot && e.userId !== ctx.bots.canary);
      const sections: string[] = [];
      for (const step of SPEED_STEPS) {
        const rows: Array<Array<string | number>> = [];
        for (const kind of step.kinds) {
          const byBuild = new Map<number, number[]>();
          for (const e of devices) {
            if (e.role !== step.role || kindOf(e) !== kind || ("via" in step && e.via !== step.via)) continue;
            const v = e.intervals?.[step.interval];
            const build = Number(e.build);
            if (typeof v !== "number" || !Number.isFinite(build)) continue;
            (byBuild.get(build) ?? byBuild.set(build, []).get(build)!).push(v);
          }
          let previous: number | undefined;
          for (const [build, values] of [...byBuild].sort((a, b) => a[0] - b[0])) {
            const p50 = percentile(values, 50)!;
            const worse = previous !== undefined && values.length >= 3 && (p50 > previous * 1.1 || p50 - previous >= 100);
            rows.push([kindName(kind), build, values.length, secs(p50), secs(percentile(values, 95)), worse ? `<span class="flag">slower than ${secs(previous)}</span>` : ""]);
            if (values.length >= 3) previous = p50;
          }
        }
        sections.push(`<section><h2>${escape(step.label)}</h2><p class="note">${escape(step.detail)}</p>${table(["Device", "Build", "Samples", "p50", "p95", ""], rows, [1, 2, 3, 4])}</section>`);
      }
      return { body: sections.join("") + `<p class="note">Flagged: a build's p50 is 10% or 100 ms worse than the previous build of that kind with at least 3 samples.</p>` };
    },
  },
  {
    id: "ring-delivery",
    title: "Ring delivery",
    question: "Why are rings missed or failing?",
    async render({ ctx, entries, users }) {
      const all = await entries();
      const list = conversations(all, ctx.bots);
      const failures: Record<string, number> = {};
      const simulated: Record<string, number> = {};
      for (const e of all) {
        if (e.kind !== "oao.apns" && e.kind !== "oao.push") continue;
        const key = `${e.kind === "oao.apns" ? "APNs" : String(e.provider ?? "push")} ${e.pushType ?? ""}: ${e.reason ?? (e.status ? `status ${e.status}` : e.event)}`;
        if (e.simulated) bump(simulated, key);
        else if (e.event !== "pushAccepted") bump(failures, key);
      }
      const prefs = new Map((await users()).map((u) => [u.id, { ringOn: String(u.data.preferredFormFactor ?? "automatic"), rollOver: u.data.rollOver === true }]));
      const by = (label: (e: LogEntry) => string) => {
        const groups: Record<string, Record<string, number>> = {};
        for (const e of list.filter((x) => (x.rings ?? []).length)) bump((groups[label(e)] ??= {}), e.outcome);
        return Object.entries(groups).sort().map(([k, c]) => {
          const total = Object.values(c).reduce((n, v) => n + v, 0);
          return [escape(k), total, pct(c.answered ?? 0, total), c.missed ?? 0, c["push-failed"] ?? 0, c.unavailable ?? 0];
        });
      };
      const head = ["", "Rings", "Answered", "Missed", "Push failed", "Unavailable"];
      const stale = all.filter((e) => e.kind === "oao.apns" && (e.status === 410 || /Unregistered|BadDeviceToken/.test(String(e.reason ?? "")))).length;
      return {
        body: [
          `<section><h2>Failures by provider and reason</h2>${bars(Object.entries(failures).sort((a, b) => b[1] - a[1]))}${Object.keys(failures).length ? "" : `<p class="empty">No failed pushes in this window.</p>`}<p class="note">${fmt(stale)} pushes found a token gone for good (the relay removes those registrations).</p></section>`,
          `<section><h2>By Ring Me On</h2>${table(head, by((e) => (prefs.get(e.to) ? prefs.get(e.to)!.ringOn : "account gone")), [1, 2, 3, 4, 5])}</section>`,
          `<section><h2>By Roll Over</h2>${table(head, by((e) => (prefs.get(e.to)?.rollOver ? "Roll Over on" : "Roll Over off")), [1, 2, 3, 4, 5])}</section>`,
          `<section><h2>By the first ring's device</h2>${table(head, by((e) => kindName(String(e.ringClientKind ?? (e.ringPlatform === "iphone" ? "ios" : "watchos")))), [1, 2, 3, 4, 5])}</section>`,
          `<section><h2>By hour (UTC)</h2>${table(head, by((e) => `${String(new Date(e.timestamp).getUTCHours()).padStart(2, "0")}:00`), [1, 2, 3, 4, 5])}</section>`,
          `<section><h2>Simulated deliveries</h2>${Object.keys(simulated).length ? bars(Object.entries(simulated)) : `<p class="empty">None: there should be none in production.</p>`}<p class="note">The FCM stub and dry runs: never counted as accepted or delivered.</p></section>`,
        ].join(""),
      };
    },
  },
  {
    id: "invite-funnel",
    title: "Invite and activation funnel",
    question: "Where do new people drop off?",
    async render({ ctx, entries, users }) {
      const all = await entries();
      const created = new Map<string, { at: number; provider: string }>();
      for (const u of await users()) {
        if (u.id === ctx.bots.testBot || u.id === ctx.bots.canary) continue;
        created.set(u.id, { at: millis(u.data.createdAt), provider: String((u.data.identity as { provider?: string } | undefined)?.provider ?? "unknown") });
      }
      const weeks: Record<string, { invites: number; accepted: number; signUps: number; firstConversation: number; day7: number; day7Due: number }> = {};
      const week = (w: string) => (weeks[w] ??= { invites: 0, accepted: 0, signUps: 0, firstConversation: 0, day7: 0, day7Due: 0 });
      for (const e of all) {
        if (e.kind !== "oao.action") continue;
        if (e.action === "invite_created") week(weekOf(Date.parse(e.timestamp))).invites++;
        if (e.action === "invite_accepted") week(weekOf(Date.parse(e.timestamp))).accepted++;
      }
      const list = conversations(all, ctx.bots);
      const firstTalk = new Map<string, number>();
      for (const e of list) for (const id of activeAccounts([e], ctx.bots)) if (!firstTalk.has(id)) firstTalk.set(id, Date.parse(e.timestamp));
      const windowStart = ctx.now - 30 * DAY_MS;
      const byProvider: Record<string, { signUps: number; talked: number }> = {};
      for (const [id, { at, provider }] of created) {
        if (at < windowStart) continue;
        const w = week(weekOf(at));
        w.signUps++;
        const p = (byProvider[provider] ??= { signUps: 0, talked: 0 });
        p.signUps++;
        if (firstTalk.has(id)) {
          w.firstConversation++;
          p.talked++;
        }
        const day7 = Date.parse(`${utcDate(at + 7 * DAY_MS)}T00:00:00Z`);
        if (day7 + DAY_MS <= ctx.now) {
          w.day7Due++;
          const that = all.filter((e) => Date.parse(e.timestamp) >= day7 && Date.parse(e.timestamp) < day7 + DAY_MS);
          if (activeAccounts(that, ctx.bots).has(id)) w.day7++;
        }
      }
      const rows = Object.entries(weeks).sort().reverse().map(([w, v]) => [w, v.invites, `${fmt(v.accepted)} <span class="meta">${pct(v.accepted, v.invites)}</span>`, v.signUps, `${fmt(v.firstConversation)} <span class="meta">${pct(v.firstConversation, v.signUps)}</span>`, v.day7Due ? `${fmt(v.day7)} <span class="meta">${pct(v.day7, v.day7Due)}</span>` : "–"]);
      return {
        body: [
          `<section><h2>By week (UTC, from Monday)</h2>${table(["Week", "Invites created", "Accepted", "Sign-ups", "Talked to a friend", "Active on day 7"], rows, [1, 2, 3, 4, 5])}<p class="note">Sign-ups in the last 30 days; "talked to a friend" within the window; day 7 counted once it has passed.</p></section>`,
          `<section><h2>By sign-in provider</h2>${table(["Provider", "Sign-ups", "Talked to a friend"], Object.entries(byProvider).map(([p, v]) => [escape(p), v.signUps, `${fmt(v.talked)} <span class="meta">${pct(v.talked, v.signUps)}</span>`]), [1, 2])}</section>`,
        ].join(""),
      };
    },
  },
  {
    id: "audio-quality",
    title: "Audio quality",
    question: "Are some microphones or routes too quiet or clipping?",
    async render({ ctx, entries }) {
      const all = (await entries()).filter((e) => e.userId !== ctx.bots.testBot && e.userId !== ctx.bots.canary);
      const groups = new Map<string, LogEntry[]>();
      for (const e of all) {
        if (e.kind !== "oao.device") continue;
        const key = `${kindName(kindOf(e))} · ${e.route ?? "route unknown"}`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
      }
      const rows = [...groups].sort((a, b) => b[1].length - a[1].length).map(([key, l]) => {
        const sent = l.map((e) => e.levels?.sentRmsDb).filter((v): v is number => typeof v === "number");
        const played = l.map((e) => e.levels?.playedRmsDb).filter((v): v is number => typeof v === "number");
        const n = (name: string) => l.reduce((s, e) => s + (e.problems?.[name] ?? 0), 0);
        return [escape(key), l.length, fmt(median(sent), 1), fmt(median(played), 1), n("silentBurstSent"), n("clippedBurstSent"), n("silentBurstPlayed"), n("audioRestarted")];
      });
      const drops = all.filter((e) => e.kind === "oao.levels" && typeof e.levelDropDb === "number").map((e) => e.levelDropDb as number);
      const bucket = (d: number) => (d < 3 ? "under 3 dB" : d < 6 ? "3–6 dB" : d < 10 ? "6–10 dB" : "10 dB or more");
      const dropCounts: Record<string, number> = {};
      for (const d of drops) bump(dropCounts, bucket(d));
      return {
        body: [
          `<section><h2>By device and audio route</h2>${table(["Device · route", "Conversations", "Sent RMS (dBFS, median)", "Played RMS", "Silent sends", "Clipped sends", "Silent plays", "Engine restarts"], rows, [1, 2, 3, 4, 5, 6, 7])}<p class="note">The route is the output port when the conversation's audio started (built-in speaker, Bluetooth, hearing aids); it never names a device.</p></section>`,
          `<section><h2>Played quieter than sent</h2>${bars(["under 3 dB", "3–6 dB", "6–10 dB", "10 dB or more"].map((k) => [k, dropCounts[k] ?? 0] as [string, number]))}<p class="note">Each direction of a conversation where both devices uploaded levels (oao.levels). A few dB is the codec; more means audio is getting quieter between the two. Median ${fmt(median(drops), 1)} dB over ${fmt(drops.length)}.</p></section>`,
        ].join(""),
      };
    },
  },
  {
    id: "cost-quotas",
    title: "Cost and quotas",
    question: "What will this cost at 2× and 10× the users, and when is a second relay node due?",
    async render({ ctx, users }) {
      const accounts = (await users()).length;
      const monthStart = Date.parse(`${utcDate(ctx.now).slice(0, 8)}01T00:00:00Z`);
      const near = ctx.monitoring ? await ctx.monitoring.nearLive(ctx.now) : null;
      const live = await ctx.out.query("statsLive", { orderBy: { field: "date", direction: "DESCENDING" }, limit: 14 });
      const peak = Math.max(0, ...live.map((d) => Number((d.data.peaks as { streams?: { value?: number } } | undefined)?.streams?.value ?? 0)));
      const usage = [
        ["Firestore reads today", near?.firestore?.readsToday, 50_000, ""],
        ["Firestore writes today", near?.firestore?.writesToday, 20_000, ""],
        ["Firestore stored", near?.firestore?.bytes, 2 ** 30, "bytes"],
        ["Logging this month", near?.loggingBytesMonth, 50 * 2 ** 30, "bytes"],
      ] as const;
      const shown = (v: number | undefined, unit: string) => (v === undefined ? "–" : unit === "bytes" ? `${fmt(v / 2 ** 20, 1)} MiB` : fmt(v));
      const rows = usage.map(([name, v, limit, unit]) => [name, shown(v, unit), shown(limit, unit), v === undefined ? "–" : pct(v, limit), v === undefined ? "–" : pct(v * 2, limit), v === undefined ? "–" : pct(v * 10, limit)]);
      return {
        body: [
          `<section><h2>Free-tier headroom, now and scaled</h2>${table(["Measure", "Now", "Free limit", "Used", "At 2× users", "At 10× users"], rows, [1, 2, 3, 4, 5])}<p class="note">${fmt(accounts)} accounts. Scaling assumes usage grows with accounts. ${near ? "From Cloud Monitoring" : "Cloud Monitoring wasn't available for this run"}; Firestore's quota resets at midnight Pacific, so "today" here is from midnight UTC. Logging month since ${utcDate(monthStart)}.</p></section>`,
          `<section><h2>Relay capacity</h2>${table(["", "Value"], [["Peak streams, last 14 days", fmt(peak)], ["At 2× users", fmt(peak * 2)], ["At 10× users", fmt(peak * 10)], ["One e2-micro node's ceiling", "not measured yet"]], [1])}<p class="note">A second node is due when the peak nears one node's ceiling; the perf suite's scenario H (200 pairs) is the closest measurement so far.</p></section>`,
          `<section><h2>Spend</h2><p class="note">No Cloud Billing budget or billing export is connected, so spend isn't read here. A $25 monthly budget with email alerts would back this section (a billing-account change: Steve's call).</p></section>`,
        ].join(""),
      };
    },
  },
  {
    id: "storage-audit",
    title: "Storage audit",
    question: "What's growing, and is anything orphaned?",
    async render({ ctx, previous }) {
      const docs = ctx.docs;
      const top = ["users", "identities", "pushTokens", "invites", "reports", "photos", "diagnostics", "feedback", "stats", "statsLive", "opsReports"];
      const nested = ["friends", "devices", "sessions", "blocks", "history"];
      const counts: Record<string, number> = {};
      for (const c of top) counts[c] = await docs.count(c);
      for (const c of nested) counts[`${c} (all)`] = await docs.count(c, { allDescendants: true });
      const expired: Record<string, number> = {};
      for (const c of ["invites", "diagnostics", "feedback", "statsLive"]) {
        expired[c] = await docs.count(c, { where: { field: "expireAt", op: "LESS_THAN", value: new Date(ctx.now - DAY_MS) } });
      }
      // Orphans, by listing (fine at Beta volume; past a few thousand documents, sample instead).
      const [tokens, photos, users] = await Promise.all([docs.list("pushTokens"), docs.list("photos"), docs.list("users")]);
      const userIds = new Set(users.map((u) => u.id));
      const devicePaths = tokens.map((t) => `users/${t.data.userId}/devices/${t.data.deviceId}`).filter((p) => !p.includes("undefined"));
      const devices = devicePaths.length ? await docs.getAll(devicePaths) : [];
      let companions = 0;
      let orphanCompanions = 0;
      for (const u of users) {
        const sessions = await docs.list(`users/${u.id}/sessions`);
        const ids = new Set(sessions.map((s) => s.id));
        for (const s of sessions) {
          if (typeof s.data.parentDeviceId !== "string") continue;
          companions++;
          if (!ids.has(s.data.parentDeviceId)) orphanCompanions++;
        }
      }
      const orphans = {
        pushTokensWithoutDevice: devices.filter((d) => !d).length + (tokens.length - devicePaths.length),
        photosWithoutAccount: photos.filter((p) => !userIds.has(p.id)).length,
        companionSessionsWithoutParent: orphanCompanions,
      };
      const before = ((previous?.data ?? {}) as { counts?: Record<string, number>; countsAt?: number }).counts ?? {};
      const rows = Object.entries(counts).map(([c, n]) => [escape(c), n, before[c] === undefined ? "–" : `${n - before[c] >= 0 ? "+" : ""}${fmt(n - before[c])}`]);
      return {
        body: [
          `<section><h2>Documents by collection</h2>${table(["Collection", "Documents", "Since last audit"], rows, [1, 2])}<p class="note">Firestore count() queries (about one read per 1,000 documents). "(all)": that subcollection under every parent.</p></section>`,
          `<section><h2>Expiry backlog</h2>${table(["Collection", "Past expireAt by more than a day"], Object.entries(expired).map(([c, n]) => [c, n]), [1])}<p class="note">Firestore's TTL usually deletes within a day of expiry; anything older is a stuck policy.</p></section>`,
          `<section><h2>Orphans</h2>${table(["", "Count"], [["Push tokens with no device", orphans.pushTokensWithoutDevice], ["Photos with no account", orphans.photosWithoutAccount], [`Companion sessions with no parent (of ${fmt(companions)})`, orphans.companionSessionsWithoutParent]], [1])}<p class="note">The Test Bot's watch session has no parent by design.</p></section>`,
        ].join(""),
        data: { counts, expired, orphans, countsAt: ctx.now },
      };
    },
  },
  {
    id: "when-people-talk",
    title: "When people talk",
    question: "Which hours are quiet enough for deploys and node replacement?",
    async render({ ctx, entries }) {
      const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
      for (const e of conversations(await entries(), ctx.bots)) {
        const d = new Date(e.timestamp);
        grid[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
      }
      const max = Math.max(1, ...grid.flat());
      const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const cells = grid.flatMap((row, d) => row.map((n, h) => `<rect x="${40 + h * 22}" y="${20 + d * 22}" width="22" height="22" rx="3" fill="var(--s2)" fill-opacity="${n ? (0.12 + 0.88 * (n / max)).toFixed(2) : 0.04}"><title>${days[d]} ${String(h).padStart(2, "0")}:00 UTC: ${n}</title></rect>`));
      const labels = [
        ...days.map((d, i) => `<text x="0" y="${36 + i * 22}" class="lbl">${d}</text>`),
        ...[0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<text x="${40 + h * 22}" y="12" class="lbl">${String(h).padStart(2, "0")}</text>`),
      ];
      const byHour = new Array<number>(24).fill(0);
      for (const row of grid) row.forEach((n, h) => (byHour[h] += n));
      const quiet = byHour.map((n, h) => [h, n] as const).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([h]) => `${String(h).padStart(2, "0")}:00`);
      return {
        body: [
          `<section><h2>Conversations by weekday and hour (UTC)</h2><svg class="chart heat" viewBox="0 0 572 180" role="img">${labels.join("")}${cells.join("")}</svg><p class="note">Darker is busier (the busiest hour: ${fmt(max)}). Hover a cell for its count.</p></section>`,
          `<section><h2>Quietest hours</h2><p>${quiet.join(", ")} UTC, over the last 30 days.</p><p class="note">The monthly node replacement runs at 09:00 UTC on the 1st (about 2 minutes without the relay while there's one node).</p></section>`,
        ].join(""),
      };
    },
  },
];

function tableFor(rows: Array<Array<string | number>>): string {
  return table(["Week", "Signed up", "Day 1", "Day 7", "Day 30"], rows, [1, 2, 3, 4]);
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}

// Renders these reports (all of them if null), stores each with its history, and says how each
// went. A report that fails is stored as failed, and the rest still run.
export async function runReports(ids: string[] | null, ctx: ReportContext): Promise<Array<{ id: string; ok: boolean; error?: string; bytes?: number }>> {
  const chosen = ids ? REPORTS.filter((r) => ids.includes(r.id)) : REPORTS;
  const unknown = (ids ?? []).filter((id) => !REPORTS.some((r) => r.id === id));
  if (unknown.length) throw new Error(`no such report: ${unknown.join(", ")} (reports: ${REPORTS.map((r) => r.id).join(", ")})`);
  const until = new Date(ctx.now);
  const since = new Date(ctx.now - 30 * DAY_MS);
  let entries: Promise<LogEntry[]> | null = null;
  let users: Promise<FirestoreDocument[]> | null = null;
  const results: Array<{ id: string; ok: boolean; error?: string; bytes?: number }> = [];
  const date = utcDate(ctx.now);
  for (const report of chosen) {
    const [previous] = await ctx.out.getAll([`opsReports/${report.id}`]);
    try {
      const rendered = await report.render({
        ctx,
        since,
        until,
        entries: () => (entries ??= ctx.read(READ_KINDS, since, until)),
        users: () => (users ??= ctx.docs.list("users")),
        previous,
      });
      const html = page(report, ctx.now, since, until, rendered.body);
      if (Buffer.byteLength(html) > 900_000) throw new Error(`the page is ${Buffer.byteLength(html)} bytes, over Firestore's limit`);
      const doc = { id: report.id, title: report.title, html, status: "ok", generatedAt: new Date(ctx.now), since, until, ...(rendered.data ? { data: rendered.data } : {}) };
      await ctx.out.commit([
        { set: `opsReports/${report.id}`, data: doc },
        { set: `opsReports/${report.id}/history/${date}`, data: { ...doc, data: null, expireAt: new Date(ctx.now + 30 * DAY_MS) } },
      ]);
      results.push({ id: report.id, ok: true, bytes: Buffer.byteLength(html) });
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      console.error(`[reports] ${report.id}: ${(err as Error).stack ?? error}`);
      // Keep the last good page; say this run failed.
      await ctx.out.commit([{ set: `opsReports/${report.id}`, data: { ...(previous ?? { id: report.id, title: report.title }), status: "failed", error, failedAt: new Date(ctx.now) } }]).catch(() => {});
      results.push({ id: report.id, ok: false, error });
    }
  }
  return results;
}

