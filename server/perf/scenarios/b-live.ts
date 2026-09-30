// B. Live conversation: both bots are in the conversation, so bursts are forwarded as they
// arrive. Measures the go-ahead, how long each frame takes through the relay, and the end.

import { ONE_WAY_MS, checkBurst, liveConversation, opus, percentile, proxy, startRelay, talk, type Context } from "../harness.ts";

export const name = "B. Live conversation";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    const key = "B.live.ws";
    const fast = await bursts(ctx, relay, 0, 3, key);
    ctx.results.add(`${key}.press_to_grant`, fast.map((s) => s.pressToGrant), "ms", "time");
    ctx.results.add(`${key}.first_frame_latency`, fast.map((s) => s.firstFrame), "ms", "time");
    ctx.results.add(`${key}.frame_latency`, fast.flatMap((s) => s.frames), "ms", "time");
    ctx.results.add(`${key}.release_to_burst_end`, fast.map((s) => s.releaseToEnd), "ms", "time");
    ctx.results.add(`${key}.receiver_messages_per_burst`, fast.map((s) => s.messages), "messages", "count");
    ctx.results.add(`${key}.receiver_bytes_per_burst`, fast.map((s) => s.bytesDown), "bytes", "count");
    ctx.results.add(`${key}.sender_bytes_per_burst`, fast.map((s) => s.bytesUp), "bytes", "count");
    if (ctx.suite !== "full") return;
    const slow = await bursts(ctx, relay, ONE_WAY_MS, 1, key);
    ctx.results.legs(`${key}.press_to_grant_legs`, slow.map((s) => s.pressToGrant));
    ctx.results.legs(`${key}.first_frame_latency_legs`, slow.map((s) => s.firstFrame));
    ctx.results.legs(`${key}.release_to_burst_end_legs`, slow.map((s) => s.releaseToEnd));
  } finally {
    await relay.close();
  }
}

interface Sample {
  pressToGrant: number;
  firstFrame: number;
  frames: number[];
  releaseToEnd: number;
  messages: number;
  bytesDown: number;
  bytesUp: number;
}

async function bursts(ctx: Context, relay: Awaited<ReturnType<typeof startRelay>>, delayMs: number, count: number, key: string): Promise<Sample[]> {
  const up = await proxy(relay, delayMs);
  const down = await proxy(relay, delayMs);
  const { a, b, bHeard, names } = await liveConversation(relay, "b", { a: up.url, b: down.url });
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < count; i++) {
      up.resetCounters();
      down.resetCounters();
      const before = bHeard.messages.length;
      const sound = opus(50);
      const sent = await talk(a, names.b, sound, true);
      const burst = await bHeard.ended(sent.burstId);
      ctx.results.fail(`${key}.integrity_failures`, [...checkBurst(sound, burst, { replay: false }), ...bHeard.problems.splice(0)]);
      const latencies = burst.frames.map((f) => f.at - sent.sentAt[f.frame.readUInt32BE(1)]);
      samples.push({
        pressToGrant: sent.grantedAt - sent.pressedAt,
        firstFrame: latencies[0] ?? NaN,
        frames: latencies,
        releaseToEnd: (burst.endAt ?? NaN) - sent.releasedAt,
        messages: bHeard.messages.length - before,
        bytesDown: down.counters.bytesDown,
        bytesUp: up.counters.bytesUp,
      });
    }
    // One percentile over this run's frames, for the delayed legs.
    if (delayMs) samples.forEach((s) => (s.firstFrame = percentile(s.frames, 50)));
    return samples;
  } finally {
    a.close();
    b.close();
    await up.close();
    await down.close();
  }
}
