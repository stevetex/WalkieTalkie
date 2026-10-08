// The Ops dashboard's rolling numbers (OPS_DASHBOARD_SPEC.md, "Rolling job"): a Cloud Run job,
// stats-rolling, run every 15 minutes by Cloud Scheduler (deploy/gcp/setup-stats.sh), in the
// API's image as account-api.
//
//   node src/rolling-main.ts
//
// Each run reads today's telemetry (00:00 UTC to now), works out today-so-far totals
// (stats.ts rollingStats), keeps the higher of the relay's peaks and the document's, runs the
// Canary against the Test Bot, and replaces statsLive/{YYYY-MM-DD}: totals only, no account IDs,
// removed by a TTL on expireAt after 14 days. WAU and MAU stay with the daily job.
//
//   STATS_LOCAL_DIR       a local relay's DATA_DIR instead of Google Cloud (job-env.ts)
//   RELAY_NODES           relay base URLs (default https://relay-1.overandout.app); the Canary
//                         uses the first
//   OPS_STATS_TOKEN       the relay's /admin/stats token; OPS_STATS_TOKEN_SECRET names a secret
//   TEST_BOT_USER_ID, CANARY_USER_ID
//                         the bots, left out of the numbers; without both, no Canary
//   SESSION_SIGNING_KEY   signs the Canary's token (SESSION_SIGNING_KEY_SECRET names a secret;
//                         locally, DATA_DIR/session-key.json)
//   MINIMUM_BUILDS        JSON {clientKind: build}, for builds below the minimum
//
// Logs oao.canary (passed, the three times, or the failed step) for a Cloud Monitoring chart.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CANARY_DEVICE, canaryToken, runCanary, type CanaryResult } from "./canary.ts";
import { Accounts, type DeviceRegistration } from "./accounts.ts";
import { createEndpointSecrets, openEndpointSecrets } from "./endpoint-keys.ts";
import { usableKeys } from "./e2ee.ts";
import { parseMinimumBuilds, type MinimumBuilds } from "./contract.ts";
import type { Docs } from "./docs.ts";
import type { FirestoreData, FirestoreDocument } from "./firestore.ts";
import { DAY_MS, jobContext, relayNodes, utcDate, type ReadEntries } from "./job-env.ts";
import { fetchRelayStats, sumRelayStats } from "./ops-relay.ts";
import { ROLLING_KINDS, botsFromEnv, providersOf, rollingStats, type Bots, type RollingStats } from "./stats.ts";
import { StdoutSink, type LogSink } from "./telemetry.ts";

type Peak = { value: number; at: number };

export interface RollingDocument extends RollingStats {
  // Today's highest open conversations and relay streams (the relay's, kept across restarts).
  peaks: { conversations: Peak; streams: Peak };
  // Today's runs, oldest first, and how many passed.
  canary: { runs: number; passes: number; last?: CanaryResult; history: CanaryResult[] };
  // Unresolved user reports, and when the oldest was made.
  openReports: { count: number; oldestAt?: number };
  // Accounts now (the bots left out), and by sign-in provider.
  accounts: { total: number; byProvider: Record<string, number> };
  relayNodes: { total: number; answering: number };
}

export interface RollingRun {
  now: number;
  docs: Docs;
  out: Docs;
  read: ReadEntries;
  bots: Bots;
  minimumBuilds?: MinimumBuilds;
  // The relay's live views (null: couldn't read them).
  relay?: () => Promise<{ total: number; answering: number; peaks: RollingDocument["peaks"] } | null>;
  // Null: no Canary configured.
  canary?: () => Promise<CanaryResult | null>;
  sink?: LogSink;
}

function higher(a: Peak | undefined, b: Peak | undefined, dayStart: number): Peak {
  const today = (p: Peak | undefined) => (p && p.at >= dayStart ? p : { value: 0, at: 0 });
  const [x, y] = [today(a), today(b)];
  return y.value > x.value ? y : x;
}

export async function rollingRun(run: RollingRun): Promise<RollingDocument> {
  const date = utcDate(run.now);
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const [entries, users, [previous], openReports] = await Promise.all([
    run.read(ROLLING_KINDS, new Date(dayStart), new Date(run.now)),
    // The sign-in provider split (one read per account each run; at Beta volume that's
    // nothing, and past a few hundred accounts it belongs in the daily job).
    run.docs.list("users"),
    run.out.getAll([`statsLive/${date}`]),
    run.docs.query("reports", { where: { field: "status", op: "EQUAL", value: "open" } }),
  ]);
  const stats = rollingStats(date, entries, { bots: run.bots, providers: providersOf(users), minimumBuilds: run.minimumBuilds, now: run.now });
  const before = previous as (FirestoreData & Partial<RollingDocument>) | undefined;
  const [relay, canary] = await Promise.all([
    run.relay?.().catch(() => null) ?? Promise.resolve(null),
    run.canary?.().catch((err: Error) => ({ at: run.now, ok: false, error: err.message.slice(0, 200) })) ?? Promise.resolve(null),
  ]);
  const history = [...(before?.canary?.history ?? []).filter((c) => c.at >= dayStart), ...(canary ? [canary] : [])].slice(-96);
  const oldest = openReports.map((r) => millis(r.data.createdAt)).filter((t) => t > 0).sort((a, b) => a - b)[0];
  const doc: RollingDocument = {
    ...stats,
    peaks: {
      conversations: higher(before?.peaks?.conversations, relay?.peaks.conversations, dayStart),
      streams: higher(before?.peaks?.streams, relay?.peaks.streams, dayStart),
    },
    canary: {
      runs: history.length,
      passes: history.filter((c) => c.ok).length,
      ...(history.length ? { last: history.at(-1)! } : {}),
      history,
    },
    openReports: { count: openReports.length, ...(oldest ? { oldestAt: oldest } : {}) },
    accounts: accountCounts(users, run.bots),
    relayNodes: relay ? { total: relay.total, answering: relay.answering } : (before?.relayNodes ?? { total: 0, answering: 0 }),
  };
  await run.out.commit([{ set: `statsLive/${date}`, data: { ...JSON.parse(JSON.stringify(doc)), expireAt: new Date(dayStart + 14 * DAY_MS) } }]);
  if (canary) {
    const { at: _, ...fields } = canary;
    (run.sink ?? new StdoutSink()).write({ kind: "oao.canary", ...fields }, canary.ok ? "INFO" : "WARNING");
  }
  return doc;
}

function accountCounts(users: FirestoreDocument[], bots: Bots): RollingDocument["accounts"] {
  const people = users.filter((u) => u.id !== bots.testBot && u.id !== bots.canary);
  const byProvider: Record<string, number> = {};
  for (const provider of providersOf(people).values()) byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  return { total: people.length, byProvider };
}

function millis(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value ?? 0);
}

if (import.meta.main) {
  const env = process.env;
  const ctx = await jobContext(env);
  const bots = botsFromEnv(env);
  const nodes = relayNodes(env);
  const opsToken = env.OPS_STATS_TOKEN || null;
  const signingKey = env.SESSION_SIGNING_KEY ?? (ctx.localDir && existsSync(join(ctx.localDir, "session-key.json")) ? readFileSync(join(ctx.localDir, "session-key.json"), "utf8") : undefined);
  const doc = await rollingRun({
    now: Date.now(),
    docs: ctx.docs,
    out: ctx.out,
    read: ctx.read,
    bots,
    minimumBuilds: parseMinimumBuilds(env.MINIMUM_BUILDS),
    relay: async () => {
      const answers = await fetchRelayStats(nodes, opsToken);
      const sum = sumRelayStats(answers);
      return { total: nodes.length, answering: answers.filter((a) => a.ok).length, peaks: sum.peaks };
    },
    canary: async () => {
      if (!bots.canary || !bots.testBot || !signingKey) return null;
      const accounts = new Accounts(ctx.docs);
      const keys = openEndpointSecrets(createEndpointSecrets(bots.canary, CANARY_DEVICE, "ios"), bots.canary, CANARY_DEVICE);
      const registration: DeviceRegistration = {
        clientKind: "ios", delivery: { provider: "relay", mode: "foreground" },
        availability: { enabled: true, notifications: "unknown" },
        capabilities: { relayProtocols: [2], audioFormats: [1, 2], decode: ["opus16k", "pcm16le16k"], encode: ["pcm16le16k"], features: [] },
        e2ee: keys.registration,
      };
      const token = await canaryToken(ctx.docs, bots.canary, signingKey);
      if (ctx.localDir) {
        // The local relay owns accounts.json in memory. Register through its API instead of
        // rewriting that file from this job's separate MemoryDocs instance.
        const response = await fetch(new URL("/v2/me/device", nodes[0]), {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(registration),
        });
        if (!response.ok) throw new Error(`Canary key registration: HTTP ${response.status}`);
      } else {
        await accounts.registerDevice(bots.canary, CANARY_DEVICE, registration);
      }
      const botKeys = await accounts.friendKeys(bots.testBot);
      const encrypted = usableKeys(bots.testBot, botKeys, Date.now()).recipients.length > 0;
      return runCanary({ relayUrl: nodes[0], token, botUserId: bots.testBot,
        ...(encrypted ? { keys, botKeys } : {}) });
    },
  });
  const last = doc.canary.last;
  console.log(`[rolling] ${doc.date}: DAU ${doc.dau} so far, ${doc.conversationStats.conversations} conversations, relay ${doc.relayNodes.answering}/${doc.relayNodes.total}, canary ${last ? (last.ok ? `${last.firstFrameMs} ms` : `failed (${last.error})`) : `off (${CANARY_DEVICE} not set up)`}`);
}
