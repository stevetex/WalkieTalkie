// The relay under test, in its own process so its CPU time, heap and event-loop delay are its
// own and not the bots'. harness.ts forks the tested checkout's src/main.ts as it runs locally
// (SERVE_API=1 with dev sign-ins and test deliveries, a temporary DATA_DIR, no APNs key so pushes
// are dry runs) and preloads this file with --import, so any relay that speaks the v2 contract
// and reads those variables can be measured, the base commit's included.
//
// IPC: sends { port } once listening; answers "stats" with { stats }, "reset" by clearing the
// event-loop histogram, and "close" by stopping the relay as a deploy does (SIGTERM).

import { Server } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

// The dry-run pusher logs every push; the relay logs every connection. Neither is wanted here.
console.log = () => {};

// The port, from the relay's own server, whatever its log lines say.
const listen = Server.prototype.listen;
let reported = false;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  this.once("listening", () => {
    const address = this.address();
    if (reported || typeof address !== "object" || !address) return;
    reported = true;
    process.send!({ port: address.port });
  });
  return listen.apply(this, args as Parameters<typeof listen>);
} as typeof listen;

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
    process.kill(process.pid, "SIGTERM");
  }
});
