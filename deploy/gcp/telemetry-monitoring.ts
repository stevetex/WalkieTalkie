// The Beta telemetry's log-based metrics, dashboard and alert policies (the "Over&Out Beta
// telemetry spec" Claude Doc), created or updated from here so they live in the repo.
// setup-telemetry.sh runs it; it uses your gcloud credentials.
//
//   node deploy/gcp/telemetry-monitoring.ts apply        create or update everything
//   node deploy/gcp/telemetry-monitoring.ts validate     check the dashboard with Monitoring's
//                                                        validateOnly; creates nothing
//   node deploy/gcp/telemetry-monitoring.ts print        the definitions, as JSON
//
// PROJECT_ID and ALERT_EMAIL come from the environment (setup-telemetry.sh sources config.sh).
//
// Costs (read 2026-09-28): log-based metrics count against the free 150 MiB of chargeable
// metrics a month; the dashboard is free; alerting is free until 1 September 2027, then
// $0.35 a month per condition.

import { execFileSync } from "node:child_process";

const project = process.env.PROJECT_ID || "walkie-talkie-relay";
const alertEmail = process.env.ALERT_EMAIL || "";
const command = process.argv[2];

// ---- Log-based metrics ----

interface LogMetric {
  name: string;
  description: string;
  filter: string;
  labels: Record<string, string>; // label → field extracted from the entry
  value?: string; // a distribution's field; absent = a counter
}

const kind = (k: string) => `jsonPayload.kind="${k}"`;
const LATENCY_BOUNDS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1700, 2000, 2500, 3000, 4000, 6000, 10000];

const metrics: LogMetric[] = [
  {
    name: "oao_conversations",
    description: "Over&Out conversations that rang someone, by outcome and the device kind rung (oao.conversation).",
    filter: `${kind("oao.conversation")} AND jsonPayload.to:*`,
    labels: { outcome: "jsonPayload.outcome", ring_platform: "jsonPayload.ringPlatform" },
  },
  {
    name: "oao_device_outcomes",
    description: "Each device's view of a conversation: answered, missed, declined, sent (oao.device).",
    filter: kind("oao.device"),
    labels: { outcome: "jsonPayload.outcome", platform: "jsonPayload.platform", role: "jsonPayload.role", build: "jsonPayload.build" },
  },
  {
    name: "oao_apns_failures",
    description: "Pushes APNs refused (oao.apns).",
    filter: `${kind("oao.apns")} AND jsonPayload.event!="pushAccepted"`,
    labels: { status: "jsonPayload.status", reason: "jsonPayload.reason", push_type: "jsonPayload.pushType" },
  },
  {
    name: "oao_apns_retries",
    description: "Pushes that went out only on the relay's retry over a fresh APNs connection.",
    filter: `${kind("oao.apns")} AND jsonPayload.event="pushAccepted"`,
    labels: { push_type: "jsonPayload.pushType" },
  },
  {
    name: "oao_device_events",
    description: "Device events outside conversations: PushToTalk leaves, crashes, hangs, unclean exits, failed registrations (oao.event).",
    filter: kind("oao.event"),
    labels: { name: "jsonPayload.name", platform: "jsonPayload.platform", build: "jsonPayload.build" },
  },
  {
    name: "oao_api_errors",
    description: "API requests that ended in a 4xx or 5xx, by route template (oao.api).",
    filter: kind("oao.api"),
    labels: { status: "jsonPayload.status", route: "jsonPayload.route" },
  },
  {
    name: "oao_relay_errors",
    description: "Relay handler failures (oao.relay_error).",
    filter: kind("oao.relay_error"),
    labels: { what: "jsonPayload.what" },
  },
  ...([
    ["oao_ring_delivery_ms", "ringDeliveryMs", "Push sent → notification delivered (watch) or PushToTalk push received (iPhone)."],
    ["oao_tap_to_first_audio_ms", "tapToFirstAudioMs", "Tap on the ring (or Answer) → first audio."],
    ["oao_push_to_first_audio_ms", "pushToFirstAudioMs", "iPhone PushToTalk: push sent → first audio, no tap."],
    ["oao_talk_to_go_ahead_ms", "talkToGoAheadMs", "Sender: Talk pressed → the relay's go-ahead."],
  ] as const).map(([name, field, description]): LogMetric => ({
    name,
    description: `${description} Milliseconds (oao.device).`,
    filter: `${kind("oao.device")} AND jsonPayload.intervals.${field}>=0`,
    labels: { platform: "jsonPayload.platform", build: "jsonPayload.build", user: "jsonPayload.userId" },
    value: `jsonPayload.intervals.${field}`,
  })),
];

function metricBody(m: LogMetric): object {
  return {
    name: m.name,
    description: m.description,
    filter: m.filter,
    metricDescriptor: {
      metricKind: "DELTA",
      valueType: m.value ? "DISTRIBUTION" : "INT64",
      unit: m.value ? "ms" : "1",
      labels: Object.keys(m.labels).map((key) => ({ key, valueType: "STRING" })),
    },
    labelExtractors: Object.fromEntries(Object.entries(m.labels).map(([k, field]) => [k, `EXTRACT(${field})`])),
    ...(m.value ? { valueExtractor: `EXTRACT(${m.value})`, bucketOptions: { explicitBuckets: { bounds: LATENCY_BOUNDS } } } : {}),
  };
}

// ---- The dashboard ----

const userMetric = (name: string) => `metric.type="logging.googleapis.com/user/${name}"`;

function countChart(title: string, filter: string, groupBy: string[], period = "86400s") {
  return {
    title,
    xyChart: {
      dataSets: [{
        plotType: "STACKED_BAR",
        targetAxis: "Y1",
        timeSeriesQuery: {
          timeSeriesFilter: {
            filter,
            aggregation: { alignmentPeriod: period, perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM", groupByFields: groupBy },
          },
        },
      }],
      yAxis: { scale: "LINEAR" },
    },
  };
}

function latencyChart(title: string, metric: string) {
  const dataSet = (p: 50 | 95) => ({
    plotType: "LINE",
    targetAxis: "Y1",
    legendTemplate: `p${p} \${metric.labels.platform}`,
    timeSeriesQuery: {
      timeSeriesFilter: {
        filter: userMetric(metric),
        aggregation: { alignmentPeriod: "86400s", perSeriesAligner: "ALIGN_DELTA", crossSeriesReducer: `REDUCE_PERCENTILE_${p}`, groupByFields: ["metric.label.platform"] },
      },
    },
  });
  return { title, xyChart: { dataSets: [dataSet(50), dataSet(95)], yAxis: { label: "ms", scale: "LINEAR" } } };
}

const charts = [
  countChart("Conversations by outcome (per day)", userMetric("oao_conversations"), ["metric.label.outcome"]),
  countChart("Rings by device kind (per day)", userMetric("oao_conversations"), ["metric.label.ring_platform"]),
  latencyChart("Ring delivery: push sent → on the device (p50, p95)", "oao_ring_delivery_ms"),
  latencyChart("Watch: tap → first audio (p50, p95)", "oao_tap_to_first_audio_ms"),
  latencyChart("iPhone: push sent → first audio (p50, p95)", "oao_push_to_first_audio_ms"),
  latencyChart("Talk → go-ahead (p50, p95)", "oao_talk_to_go_ahead_ms"),
  countChart("Devices' outcomes: answered, missed, declined (per day)", userMetric("oao_device_outcomes"), ["metric.label.outcome", "metric.label.platform"]),
  countChart("Device events: PushToTalk leaves, crashes, unclean exits (per day)", userMetric("oao_device_events"), ["metric.label.name"]),
  countChart("Crashes, hangs and unclean exits by build (per day)", `${userMetric("oao_device_events")} AND metric.label.name=one_of("crash","hang","uncleanExit","extensionUnfinished")`, ["metric.label.build", "metric.label.name"]),
  countChart("APNs failures by reason (per hour)", userMetric("oao_apns_failures"), ["metric.label.reason", "metric.label.push_type"], "3600s"),
  countChart("API errors by route and status (per hour)", userMetric("oao_api_errors"), ["metric.label.route", "metric.label.status"], "3600s"),
  countChart("Relay errors (per hour)", userMetric("oao_relay_errors"), ["metric.label.what"], "3600s"),
];

const dashboard = {
  displayName: "Over&Out Beta",
  mosaicLayout: {
    columns: 12,
    tiles: charts.map((widget, i) => ({ xPos: (i % 2) * 6, yPos: Math.floor(i / 2) * 4, width: 6, height: 4, widget })),
  },
};

// ---- Alert policies ----

function thresholdCondition(displayName: string, filter: string, period: string, above: number) {
  return {
    displayName,
    conditionThreshold: {
      filter,
      aggregations: [{ alignmentPeriod: period, perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
      comparison: "COMPARISON_GT",
      thresholdValue: above,
      duration: "0s",
      trigger: { count: 1 },
    },
  };
}

function logCondition(displayName: string, filter: string) {
  return { displayName, conditionMatchedLog: { filter } };
}

const policies = [
  {
    displayName: "Over&Out: rings failing",
    conditions: [
      thresholdCondition("3+ rings pushed nowhere, unavailable or unresolved in an hour", `${userMetric("oao_conversations")} AND resource.type="global" AND metric.label.outcome=one_of("push-failed","unavailable","unresolved")`, "3600s", 2),
      thresholdCondition("3+ relay errors in an hour", `${userMetric("oao_relay_errors")} AND resource.type="global"`, "3600s", 2),
    ],
    doc: "Rings are failing for testers. Run `node tools/beta.ts summary --days 1` and `beta.ts tester <name>` for the conversations; the relay's log is in HANDOFF.md.",
  },
  {
    displayName: "Over&Out: APNs setup",
    conditions: [logCondition("APNs refused the relay's key, topic or certificate", `${kind("oao.apns")} AND (jsonPayload.status=403 OR jsonPayload.reason=~"BadTopic|TopicDisallowed|InvalidProviderToken|ExpiredProviderToken|MissingProviderToken|BadCertificate|DeviceTokenNotForTopic")`)],
    doc: "APNs refused a push for a setup reason (key, topic or certificate), so rings may not reach anyone. Check the apns-key secret and APNS_* settings; `beta.ts summary` lists APNs failures.",
    rateLimit: "3600s",
  },
  {
    displayName: "Over&Out: API errors",
    conditions: [thresholdCondition("5+ API 5xx in 10 minutes", `metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND metric.labels.response_code_class="5xx"`, "600s", 4)],
    doc: "The account API is failing. `gcloud logging read 'resource.labels.service_name=\"api\" AND severity>=ERROR' --limit=20`.",
  },
  {
    displayName: "Over&Out: app crashed",
    conditions: [logCondition("A crash, hang, unclean exit or unfinished extension run", `${kind("oao.event")} AND (jsonPayload.name="crash" OR jsonPayload.name="hang" OR jsonPayload.name="uncleanExit" OR jsonPayload.name="extensionUnfinished")`)],
    doc: "A tester's app crashed or hung. `node tools/beta.ts tester <account ID from the entry>`; TestFlight's symbolicated report: `node deploy/appstore/asc.ts crashes`.",
    rateLimit: "900s",
  },
  {
    displayName: "Over&Out: dropped conversations",
    conditions: [thresholdCondition("3+ relay connections dropped mid-conversation in an hour", `${userMetric("oao_device_events")} AND resource.type="cloud_run_revision" AND metric.label.name="relayDropped"`, "3600s", 2)],
    doc: "Devices are losing the relay mid-conversation. `node tools/beta.ts summary --days 1`.",
  },
  {
    displayName: "Over&Out: problem report",
    conditions: [logCondition("A tester sent Report a Problem", `resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND textPayload:"[feedback]"`)],
    doc: "A tester sent Report a Problem from the app. `node tools/beta.ts feedback`, then `beta.ts logs <tester>` once their devices upload.",
    rateLimit: "300s",
  },
];

function policyBody(p: (typeof policies)[number], channel: string): object {
  const isLog = p.conditions.some((c) => "conditionMatchedLog" in c);
  return {
    displayName: p.displayName,
    combiner: "OR",
    conditions: p.conditions,
    alertStrategy: isLog ? { notificationRateLimit: { period: p.rateLimit ?? "300s" }, autoClose: "1800s" } : { autoClose: "1800s" },
    notificationChannels: [channel],
    documentation: { content: p.doc, mimeType: "text/markdown" },
  };
}

// ---- Applying ----

const token = () => execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();

async function call(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token()}`, "x-goog-user-project": project, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

const logging = `https://logging.googleapis.com/v2/projects/${project}/metrics`;
const monitoringV1 = `https://monitoring.googleapis.com/v1/projects/${project}/dashboards`;
const monitoringV3 = `https://monitoring.googleapis.com/v3/projects/${project}`;

async function applyMetrics(): Promise<void> {
  const existing = new Set(((await call("GET", `${logging}?pageSize=200`)).metrics ?? []).map((m: any) => m.name));
  for (const m of metrics) {
    if (existing.has(m.name)) await call("PUT", `${logging}/${m.name}`, metricBody(m));
    else await call("POST", logging, metricBody(m));
    console.log(`${existing.has(m.name) ? "Updated" : "Created"} log-based metric ${m.name}`);
  }
}

async function applyDashboard(validateOnly: boolean): Promise<void> {
  const found = ((await call("GET", monitoringV1)).dashboards ?? []).find((d: any) => d.displayName === dashboard.displayName);
  if (found && !validateOnly) {
    await call("PATCH", `https://monitoring.googleapis.com/v1/${found.name}`, { ...dashboard, name: found.name, etag: found.etag });
    console.log(`Updated the dashboard: https://console.cloud.google.com/monitoring/dashboards/builder/${found.name.split("/").pop()}?project=${project}`);
  } else {
    const created = await call("POST", `${monitoringV1}${validateOnly ? "?validateOnly=true" : ""}`, dashboard);
    console.log(validateOnly ? "The dashboard is valid." : `Created the dashboard: https://console.cloud.google.com/monitoring/dashboards/builder/${created.name.split("/").pop()}?project=${project}`);
  }
}

async function emailChannel(): Promise<string> {
  if (!alertEmail) throw new Error("Set ALERT_EMAIL in config.sh.");
  const channels = (await call("GET", `${monitoringV3}/notificationChannels`)).notificationChannels ?? [];
  const found = channels.find((c: any) => c.labels?.email_address === alertEmail);
  if (!found) throw new Error("No email notification channel for ALERT_EMAIL; run setup-uptime.sh first.");
  return found.name;
}

async function applyPolicies(): Promise<void> {
  const channel = await emailChannel();
  const existing = (await call("GET", `${monitoringV3}/alertPolicies?pageSize=200`)).alertPolicies ?? [];
  for (const p of policies) {
    const found = existing.find((e: any) => e.displayName === p.displayName);
    const body = policyBody(p, channel);
    if (found) await call("PATCH", `https://monitoring.googleapis.com/v3/${found.name}`, { ...body, name: found.name });
    else await call("POST", `${monitoringV3}/alertPolicies`, body);
    console.log(`${found ? "Updated" : "Created"} alert policy "${p.displayName}"`);
  }
}

switch (command) {
  case "print":
    console.log(JSON.stringify({ metrics: metrics.map(metricBody), dashboard, policies: policies.map((p) => policyBody(p, "<email channel>")) }, null, 2));
    break;
  case "validate":
    await applyDashboard(true);
    break;
  case "apply":
    // Metrics first: the dashboard and alerts refer to them.
    await applyMetrics();
    await applyDashboard(false);
    await applyPolicies();
    break;
  default:
    console.error("usage: node deploy/gcp/telemetry-monitoring.ts apply | validate | print");
    process.exit(1);
}
