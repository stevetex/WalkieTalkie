// The relay under test, in its own process so its CPU time, heap and event-loop delay are
// its own and not the bots'. Started by perf/relay.ts with fork(); argv[2] is JSON:
// { relayDir, options } where relayDir is the server directory whose src/ is tested (this
// checkout's, or the base commit's worktree) and options are extra ServerOptions.
//
// IPC: sends { port } once listening; answers "stats" with { stats }, "reset" by clearing the
// event-loop histogram.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

const { relayDir, options } = JSON.parse(process.argv[2] ?? "{}") as { relayDir: string; options?: Record<string, unknown> };
const load = (file: string) => import(pathToFileURL(join(relayDir, "src", file)).href);
const { startServer } = await load("main.ts");
const { DryRunPusher } = await load("apns.ts");

// The dry-run pusher logs every push; the relay logs every connection. Neither is wanted here.
console.log = () => {};

const running = await startServer({
  port: 0,
  host: "127.0.0.1",
  dataDir: null,
  token: "perf",
  sharedTokenClients: true,
  pusher: new DryRunPusher(),
  ...options,
});

const loop = monitorEventLoopDelay({ resolution: 5 });
loop.enable();

export interface RelayStats {
  cpuMs: number;
  heapUsedBytes: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
}

process.on("message", (message: unknown) => {
  if (message === "reset") {
    loop.reset();
    process.send!({ reset: true });
  } else if (message === "stats") {
    // CPU first, so the collection below isn't counted as the relay's work.
    const cpu = process.cpuUsage();
    (globalThis as { gc?: () => void }).gc?.();
    const stats: RelayStats = {
      cpuMs: (cpu.user + cpu.system) / 1000,
      heapUsedBytes: getHeapStatistics().used_heap_size,
      loopP50Ms: loop.percentile(50) / 1e6,
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
    };
    process.send!({ stats });
  } else if (message === "close") {
    void running.close().then(() => process.exit(0));
  }
});

process.send!({ port: running.port });
