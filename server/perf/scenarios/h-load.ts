// H. Many conversations on one relay: 50 and 200 live pairs, every sender talking for a
// second at once. The relay runs in its own process, so its CPU time, heap and event-loop
// delay are its own. Relay nodes are e2-micro VMs; this shows roughly what one can hold.
// Load numbers only warn: shared runners vary too much to fail a build on them.

import { checkBurst, liveConversation, opus, percentile, sleep, startRelay, talk, type Context, type Relay } from "../harness.ts";

export const name = "H. Many conversations";
export const fullOnly = true;

export async function run(ctx: Context): Promise<void> {
  for (const pairs of [50, 200]) await load(ctx, pairs);
}

async function load(ctx: Context, pairs: number): Promise<void> {
  const key = `H.load.${pairs}_pairs`;
  const relay: Relay = await startRelay(ctx.relayDir);
  const conversations: Awaited<ReturnType<typeof liveConversation>>[] = [];
  try {
    const baseline = await relay.stats();
    for (let i = 0; i < pairs; i++) conversations.push(await liveConversation(relay, `h${pairs}`, { a: relay.url, b: relay.url }));
    const setUp = await relay.stats();
    await relay.resetStats();

    const sounds = conversations.map(() => opus(50));
    const sent = await Promise.all(
      conversations.map(async (c, i) => {
        await sleep(i % 20);
        return talk(c.a, c.names.b, sounds[i], true);
      }),
    );
    const heard = await Promise.all(conversations.map((c, i) => c.bHeard.ended(sent[i].burstId, 30_000)));
    const after = await relay.stats();

    const latencies: number[] = [];
    let problems = 0;
    heard.forEach((burst, i) => {
      for (const f of burst.frames) latencies.push(f.at - sent[i].sentAt[f.frame.readUInt32BE(1)]);
      problems += checkBurst(sounds[i], burst, { replay: false }).length;
    });
    ctx.results.fail(`${key}.integrity_failures`, problems ? [`${problems} problems across ${pairs} bursts`] : []);
    ctx.results.add(`${key}.frame_latency_p95`, percentile(latencies, 95), "ms", "load");
    ctx.results.add(`${key}.event_loop_p99`, after.loopP99Ms, "ms", "load");
    ctx.results.add(`${key}.event_loop_max`, after.loopMaxMs, "ms", "load");
    ctx.results.add(`${key}.cpu_per_1000_frames`, ((after.cpuMs - setUp.cpuMs) / (pairs * 50)) * 1000, "ms", "load");
    ctx.results.add(`${key}.heap_per_conversation`, (setUp.heapUsedBytes - baseline.heapUsedBytes) / pairs, "bytes", "load");
  } finally {
    for (const c of conversations) {
      c.a.close();
      c.b.close();
    }
    await relay.close();
  }
}
