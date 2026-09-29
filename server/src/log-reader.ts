// Reads telemetry entries (telemetry.ts) back from Cloud Logging: for the daily rollup
// (rollup-main.ts, with its service account) and the tools (with your gcloud credentials).

export interface LogEntry {
  timestamp: string;
  severity: string;
  kind: string;
  [field: string]: any;
}

export interface LogQuery {
  kinds: string[];
  since: Date;
  until?: Date;
  // Any of these field = value pairs (an OR); none = every entry of those kinds.
  anyOf?: Array<[string, string]>;
  limit?: number;
}

export function matchesQuery(e: LogEntry, q: LogQuery): boolean {
  if (!q.kinds.includes(e.kind)) return false;
  const t = Date.parse(e.timestamp);
  if (t < q.since.getTime() || (q.until && t >= q.until.getTime())) return false;
  return !q.anyOf?.length || q.anyOf.some(([field, value]) => e[field] === value);
}

const quote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

export async function readCloudLogging(
  q: LogQuery,
  project: string,
  accessToken: () => Promise<string>,
  fetchFn: typeof fetch = fetch,
): Promise<LogEntry[]> {
  const filter = [
    `(${q.kinds.map((k) => `jsonPayload.kind=${quote(k)}`).join(" OR ")})`,
    `timestamp>=${quote(q.since.toISOString())}`,
    ...(q.until ? [`timestamp<${quote(q.until.toISOString())}`] : []),
    ...(q.anyOf?.length ? [`(${q.anyOf.map(([f, v]) => `jsonPayload.${f}=${quote(v)}`).join(" OR ")})`] : []),
  ].join(" AND ");
  const limit = q.limit ?? 200_000;
  const out: LogEntry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await fetchFn("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", "x-goog-user-project": project },
      body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, orderBy: "timestamp asc", pageSize: 1000, pageToken }),
    });
    if (!res.ok) throw new Error(`entries:list ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as { entries?: Array<{ timestamp: string; severity?: string; jsonPayload?: Record<string, unknown> }>; nextPageToken?: string };
    for (const e of page.entries ?? []) {
      if (!e.jsonPayload) continue;
      out.push({ ...(e.jsonPayload as object), timestamp: e.timestamp, severity: e.severity ?? "DEFAULT" } as LogEntry);
    }
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < limit);
  return out;
}
