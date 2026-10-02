// The Ops dashboard's near-live numbers from Cloud Monitoring (about a minute old): the API's
// latency, errors and instances, the relay nodes' CPU, the uptime checks, open incidents,
// Firestore's and Logging's usage, and the last hour's conversations and APNs failures from the
// oao_* log-based metrics. Each is read on its own; one that fails is left out, not fatal.

export interface NearLive {
  at: number;
  // OPS_LOCAL: made-up numbers, so the page can be checked without Google Cloud.
  sample?: true;
  api?: { p95Ms?: number; errorShare?: number; requests?: number; instances?: number };
  relayCpu?: Array<{ node: string; utilization: number }>;
  uptime?: Array<{ check: string; passing: boolean }>;
  incidents?: Array<{ policy: string; startedAt?: number }>;
  firestore?: { bytes?: number; readsToday?: number; writesToday?: number };
  loggingBytesMonth?: number;
  lastHour?: { conversations: Record<string, number>; apnsFailures: number };
}

type Point = { interval: { endTime: string }; value: { doubleValue?: number; int64Value?: string; distributionValue?: unknown } };
type Series = { metric?: { labels?: Record<string, string> }; resource?: { labels?: Record<string, string> }; points?: Point[] };

function value(p: Point | undefined): number | undefined {
  if (!p) return undefined;
  const v = p.value.doubleValue ?? (p.value.int64Value !== undefined ? Number(p.value.int64Value) : undefined);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export class Monitoring {
  private projectId: string;
  private accessToken: () => Promise<string>;
  private fetchFn: typeof fetch;

  constructor(projectId: string, accessToken: () => Promise<string>, fetchFn: typeof fetch = fetch) {
    this.projectId = projectId;
    this.accessToken = accessToken;
    this.fetchFn = fetchFn;
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${this.projectId}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // One aligned series per group over [since, now].
  private async series(filter: string, since: number, now: number, aggregation: Record<string, string>): Promise<Series[]> {
    const body = await this.get("timeSeries", {
      filter,
      "interval.startTime": new Date(since).toISOString(),
      "interval.endTime": new Date(now).toISOString(),
      ...Object.fromEntries(Object.entries(aggregation).map(([k, v]) => [`aggregation.${k}`, v])),
    });
    return (body.timeSeries ?? []) as Series[];
  }

  async nearLive(now = Date.now()): Promise<NearLive> {
    const hour = now - 3_600_000;
    const dayStart = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`);
    const out: NearLive = { at: now };
    const window = (since: number) => `${Math.max(60, Math.round((now - since) / 1000))}s`;
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`[ops] Monitoring ${what}: ${(err as Error).message}`);
      }
    };
    const api = (out.api = {} as NonNullable<NearLive["api"]>);
    await Promise.all([
      attempt("API latency", async () => {
        const [s] = await this.series(`metric.type="run.googleapis.com/request_latencies" AND resource.labels.service_name="api"`, hour, now, { alignmentPeriod: window(hour), perSeriesAligner: "ALIGN_PERCENTILE_95", crossSeriesReducer: "REDUCE_MAX" });
        const v = value(s?.points?.[0]);
        if (v !== undefined) api.p95Ms = Math.round(v);
      }),
      attempt("API requests", async () => {
        const rows = await this.series(`metric.type="run.googleapis.com/request_count" AND resource.labels.service_name="api"`, hour, now, { alignmentPeriod: window(hour), perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM", groupByFields: "metric.labels.response_code_class" });
        let total = 0;
        let errors = 0;
        for (const s of rows) {
          const n = value(s.points?.[0]) ?? 0;
          total += n;
          if (s.metric?.labels?.response_code_class === "5xx") errors += n;
        }
        api.requests = total;
        api.errorShare = total ? errors / total : 0;
      }),
      attempt("API instances", async () => {
        const [s] = await this.series(`metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="api"`, now - 600_000, now, { alignmentPeriod: "600s", perSeriesAligner: "ALIGN_MAX", crossSeriesReducer: "REDUCE_SUM" });
        api.instances = value(s?.points?.[0]) ?? 0;
      }),
      attempt("relay CPU", async () => {
        const rows = await this.series(`metric.type="compute.googleapis.com/instance/cpu/utilization" AND metric.labels.instance_name=starts_with("relay")`, now - 600_000, now, { alignmentPeriod: "600s", perSeriesAligner: "ALIGN_MEAN" });
        out.relayCpu = rows.map((s) => ({ node: s.metric?.labels?.instance_name ?? "relay", utilization: value(s.points?.[0]) ?? 0 }));
      }),
      attempt("uptime checks", async () => {
        const rows = await this.series(`metric.type="monitoring.googleapis.com/uptime_check/check_passed"`, now - 600_000, now, { alignmentPeriod: "600s", perSeriesAligner: "ALIGN_FRACTION_TRUE", crossSeriesReducer: "REDUCE_MEAN", groupByFields: "metric.labels.check_id" });
        out.uptime = rows.map((s) => ({ check: s.metric?.labels?.check_id ?? "check", passing: (value(s.points?.[0]) ?? 0) >= 0.5 }));
      }),
      attempt("incidents", async () => {
        const body = await this.get("alerts", { filter: 'state="OPEN"', pageSize: "20" });
        out.incidents = ((body.alerts ?? []) as Array<{ policy?: { displayName?: string }; openTime?: string }>).map((a) => ({
          policy: a.policy?.displayName ?? "an alert policy",
          ...(a.openTime ? { startedAt: Date.parse(a.openTime) } : {}),
        }));
      }),
      attempt("Firestore", async () => {
        const fs = (out.firestore ??= {});
        const [bytes] = await this.series(`metric.type="firestore.googleapis.com/storage/data_and_index_storage_bytes"`, now - 6 * 3_600_000, now, { alignmentPeriod: "21600s", perSeriesAligner: "ALIGN_MAX", crossSeriesReducer: "REDUCE_SUM" });
        const b = value(bytes?.points?.[0]);
        if (b !== undefined) fs.bytes = b;
        for (const [key, metric] of [["readsToday", "document/read_count"], ["writesToday", "document/write_count"]] as const) {
          const [s] = await this.series(`metric.type="firestore.googleapis.com/${metric}"`, dayStart, now, { alignmentPeriod: window(dayStart), perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" });
          fs[key] = value(s?.points?.[0]) ?? 0;
        }
      }),
      attempt("Logging", async () => {
        const [s] = await this.series(`metric.type="logging.googleapis.com/billing/monthly_bytes_ingested"`, now - 6 * 3_600_000, now, { alignmentPeriod: "21600s", perSeriesAligner: "ALIGN_MAX", crossSeriesReducer: "REDUCE_SUM" });
        const v = value(s?.points?.[0]);
        if (v !== undefined) out.loggingBytesMonth = v;
      }),
      attempt("the last hour", async () => {
        const rows = await this.series(`metric.type="logging.googleapis.com/user/oao_conversations"`, hour, now, { alignmentPeriod: window(hour), perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM", groupByFields: "metric.labels.outcome" });
        const [apns] = await this.series(`metric.type="logging.googleapis.com/user/oao_apns_failures"`, hour, now, { alignmentPeriod: window(hour), perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" });
        out.lastHour = {
          conversations: Object.fromEntries(rows.map((s) => [s.metric?.labels?.outcome ?? "unknown", value(s.points?.[0]) ?? 0])),
          apnsFailures: value(apns?.points?.[0]) ?? 0,
        };
      }),
    ]);
    return out;
  }
}

// OPS_LOCAL: plausible numbers, marked as samples.
export function sampleNearLive(now = Date.now()): NearLive {
  return {
    at: now,
    sample: true,
    api: { p95Ms: 182, errorShare: 0.0002, requests: 4200, instances: 1 },
    relayCpu: [{ node: "relay-1", utilization: 0.11 }],
    uptime: [{ check: "relay-https", passing: true }, { check: "api-health", passing: true }],
    incidents: [],
    firestore: { bytes: 62e6, readsToday: 18_200, writesToday: 6_100 },
    loggingBytesMonth: 1.9 * 2 ** 30,
    lastHour: { conversations: { answered: 41, missed: 6 }, apnsFailures: 1 },
  };
}
