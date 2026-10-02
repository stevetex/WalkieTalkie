// The relay nodes' live views (GET /admin/stats, relay.ts), read with the Ops token and summed
// across nodes (option E): for the Ops service's /api/live and the rolling job's peaks.

import type { ClientKind } from "./contract.ts";
import type { LiveRow, RelayLiveStats } from "./relay.ts";

export interface NodeStats extends RelayLiveStats {
  node: string;
  revision: string;
  startedAt: number;
  now: number;
}

export interface NodeAnswer {
  url: string;
  ok: boolean;
  // Healthy, with its revision and uptime, when it answered.
  stats?: NodeStats;
  error?: string;
}

export interface LiveSummary extends RelayLiveStats {
  now: number;
  nodes: Array<{ url: string; ok: boolean; node?: string; revision?: string; startedAt?: number; error?: string }>;
}

// Each node's answer; one that doesn't answer in `timeoutMs` is marked down.
export async function fetchRelayStats(nodes: string[], token: string | null, timeoutMs = 2000, fetchFn: typeof fetch = fetch): Promise<NodeAnswer[]> {
  return Promise.all(nodes.map(async (url): Promise<NodeAnswer> => {
    try {
      const res = await fetchFn(`${url}/admin/stats`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };
      return { url, ok: true, stats: (await res.json()) as NodeStats };
    } catch (err) {
      return { url, ok: false, error: (err as Error).name === "TimeoutError" ? `no answer in ${timeoutMs} ms` : (err as Error).message.slice(0, 120) };
    }
  }));
}

// All nodes as one: totals added, rows merged newest first (50 at most), peaks the highest of
// any node's (a conversation lives on one node, so this is the floor of the true total peak).
export function sumRelayStats(answers: NodeAnswer[], now = Date.now()): LiveSummary {
  const streams: Record<ClientKind, number> = { ios: 0, watchos: 0, android: 0, wearos: 0 };
  const out: LiveSummary = {
    now,
    nodes: [],
    conversations: { open: 0, talking: 0, ringing: 0, waiting: 0 },
    streams,
    pcmOnly: 0,
    held: { bursts: 0, bytes: 0 },
    peaks: { conversations: { value: 0, at: 0 }, streams: { value: 0, at: 0 } },
    live: [],
  };
  const rows: LiveRow[] = [];
  for (const a of answers) {
    const s = a.stats;
    out.nodes.push({ url: a.url, ok: a.ok, ...(s ? { node: s.node, revision: s.revision, startedAt: s.startedAt } : {}), ...(a.error ? { error: a.error } : {}) });
    if (!s) continue;
    for (const k of ["open", "talking", "ringing", "waiting"] as const) out.conversations[k] += s.conversations?.[k] ?? 0;
    for (const k of Object.keys(streams) as ClientKind[]) streams[k] += s.streams?.[k] ?? 0;
    out.pcmOnly += s.pcmOnly ?? 0;
    out.held.bursts += s.held?.bursts ?? 0;
    out.held.bytes += s.held?.bytes ?? 0;
    for (const k of ["conversations", "streams"] as const) {
      const p = s.peaks?.[k];
      if (p && p.value > out.peaks[k].value) out.peaks[k] = { ...p };
    }
    rows.push(...(s.live ?? []));
  }
  out.live = rows.sort((a, b) => a.ageMs - b.ageMs).slice(0, 50);
  return out;
}
