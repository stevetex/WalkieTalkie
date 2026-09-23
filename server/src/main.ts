// Spike server: HTTP API for device registration and metrics, plus the relay WebSocket.
//
//   PORT              listen port (default 8080)
//   DATA_DIR          where devices.json and metrics.jsonl live (default ./data)
//   SPIKE_TOKEN       shared bearer token clients must present (unset = no auth, local only)
//   APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID
//                     APNs token auth; if any is missing, pushes are logged (dry run)

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { resolve } from "node:path";
import { acceptUpgrade, rejectUpgrade } from "./ws.ts";
import { ApnsPusher, DryRunPusher, apnsConfigFromEnv, type VoipPusher } from "./apns.ts";
import { DeviceStore, MetricsStore, ensureDir } from "./store.ts";
import { Relay, type Peer } from "./relay.ts";
import { summarizeAttempts } from "./report.ts";
import type { ClientMessage, MetricsUpload } from "./protocol.ts";

export interface ServerOptions {
  port: number;
  dataDir: string | null;
  token: string | null;
  pusher: VoipPusher;
  ringTimeoutMs?: number;
}

export interface RunningServer {
  server: Server;
  relay: Relay;
  devices: DeviceStore;
  metrics: MetricsStore;
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const devices = new DeviceStore(options.dataDir);
  const metrics = new MetricsStore(options.dataDir);
  const relay = new Relay({
    devices,
    pusher: options.pusher,
    metrics,
    ...(options.ringTimeoutMs ? { ringTimeoutMs: options.ringTimeoutMs } : {}),
  });

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!options.token) return true;
    return req.headers.authorization === `Bearer ${options.token}` || url.searchParams.get("token") === options.token;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (!authorized(req, url)) return send(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && url.pathname === "/v1/devices") {
        const body = await readJSON(req);
        const { userId, name, voipToken, apnsEnvironment } = body as Record<string, unknown>;
        if (typeof userId !== "string" || !userId || typeof voipToken !== "string" || !voipToken) {
          return send(res, 400, { error: "userId and voipToken are required" });
        }
        devices.upsert({
          userId,
          name: typeof name === "string" && name ? name : userId,
          voipToken,
          apnsEnvironment: apnsEnvironment === "production" ? "production" : "sandbox",
          updatedAt: Date.now(),
        });
        console.log(`[api] registered ${userId} (${apnsEnvironment ?? "sandbox"})`);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/users") {
        return send(res, 200, devices.list().map((d) => ({ userId: d.userId, name: d.name })));
      }
      if (req.method === "POST" && url.pathname === "/v1/metrics") {
        const upload = (await readJSON(req)) as MetricsUpload;
        if (!upload?.conversationId || !Array.isArray(upload.events)) return send(res, 400, { error: "bad metrics" });
        metrics.upload(upload);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/metrics") {
        return send(
          res,
          200,
          metrics.conversationIds().map((id) => {
            const timeline = metrics.timeline(id);
            return { conversationId: id, startedAt: timeline[0]?.t ?? null, events: timeline.length };
          }),
        );
      }
      const match = url.pathname.match(/^\/v1\/metrics\/([\w-]+)$/);
      if (req.method === "GET" && match) {
        const timeline = metrics.timeline(match[1]);
        return send(res, 200, { conversationId: match[1], timeline, attempts: summarizeAttempts(timeline) });
      }
      if (req.method === "GET" && url.pathname === "/v1/status") return send(res, 200, relay.snapshot());
      // For devices registered with a "poll:" token (no VoIP push): collect pending rings.
      if (req.method === "GET" && url.pathname === "/v1/rings/poll") {
        return send(res, 200, relay.takePolledRings(url.searchParams.get("userId") ?? ""));
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const userId = url.searchParams.get("userId");
    if (url.pathname !== "/v1/relay" || !userId) return rejectUpgrade(socket, 404, "Not Found");
    if (!authorized(req, url)) return rejectUpgrade(socket, 401, "Unauthorized");
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;

    const peer: Peer = { userId, sendJSON: (m) => ws.sendJSON(m), sendBinary: (b) => ws.sendBinary(b) };
    relay.connect(peer);
    console.log(`[relay] ${userId} connected`);
    ws.on("text", (text: string) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(text);
      } catch {
        return ws.sendJSON({ type: "error", message: "invalid JSON" });
      }
      relay.handleMessage(peer, message);
    });
    ws.on("binary", (frame: Buffer) => relay.handleAudio(peer, frame));
    ws.on("close", () => {
      relay.disconnect(peer);
      console.log(`[relay] ${userId} disconnected`);
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(options.port, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      resolvePromise({
        server,
        relay,
        devices,
        metrics,
        port,
        close: () =>
          new Promise<void>((done) => {
            relay.close();
            options.pusher.close();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1 << 20) throw new Error("body too large");
  }
  return JSON.parse(raw || "{}");
}

if (import.meta.main) {
  const apnsConfig = apnsConfigFromEnv(process.env);
  const pusher = apnsConfig ? new ApnsPusher(apnsConfig) : new DryRunPusher();
  const dataDir = ensureDir(resolve(process.env.DATA_DIR ?? "data"));
  const token = process.env.SPIKE_TOKEN || null;
  const running = await startServer({ port: Number(process.env.PORT ?? 8080), dataDir, token, pusher });
  console.log(`[server] listening on :${running.port}, data in ${dataDir}`);
  console.log(apnsConfig ? `[server] APNs topic ${apnsConfig.bundleId}.voip` : "[server] APNs not configured: dry-run pushes");
  if (!token) console.warn("[server] SPIKE_TOKEN not set: API and relay are unauthenticated");
}
