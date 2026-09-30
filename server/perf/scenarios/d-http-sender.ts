// D. The watch sending over HTTP: the sender uses the stream + POST transport, whose outbox
// batches whatever queued while the previous POST was in flight. Measures the batching and how
// long the end of a burst takes to arrive after the sender lets go.

import { ONE_WAY_MS, checkBurst, liveConversation, opus, proxy, sendPosts, sleep, startRelay, talk, type Context } from "../harness.ts";

export const name = "D. Watch sending over HTTP";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    const key = "D.http_sender";
    const fast = await bursts(ctx, relay, 0, 2, key);
    ctx.results.add(`${key}.posts_per_burst`, fast.map((s) => s.posts), "POSTs", "approx");
    ctx.results.add(`${key}.first_frame_latency`, fast.map((s) => s.firstFrame), "ms", "time");
    ctx.results.add(`${key}.last_frame_latency`, fast.map((s) => s.lastFrame), "ms", "time");
    ctx.results.add(`${key}.release_to_burst_end`, fast.map((s) => s.releaseToEnd), "ms", "time");
    if (ctx.suite !== "full") return;
    const slow = await bursts(ctx, relay, ONE_WAY_MS, 1, key);
    ctx.results.add(`${key}.posts_per_burst_delayed`, slow.map((s) => s.posts), "POSTs", "approx");
    ctx.results.add(`${key}.frames_per_post_delayed`, slow.map((s) => 50 / s.posts), "frames", "info");
    ctx.results.legs(`${key}.first_frame_latency_legs`, slow.map((s) => s.firstFrame));
    ctx.results.legs(`${key}.release_to_burst_end_legs`, slow.map((s) => s.releaseToEnd));
  } finally {
    await relay.close();
  }
}

interface Sample {
  posts: number;
  firstFrame: number;
  lastFrame: number;
  releaseToEnd: number;
}

async function bursts(ctx: Context, relay: Awaited<ReturnType<typeof startRelay>>, delayMs: number, count: number, key: string): Promise<Sample[]> {
  const up = await proxy(relay, delayMs);
  const down = await proxy(relay, delayMs);
  const { a, b, bHeard, names } = await liveConversation(relay, "d", { a: up.url, b: down.url }, { a: "http", b: "ws" });
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < count; i++) {
      sendPosts.set(names.a, 0);
      const sound = opus(50);
      const sent = await talk(a, names.b, sound, true);
      const burst = await bHeard.ended(sent.burstId);
      ctx.results.fail(`${key}.integrity_failures`, [...checkBurst(sound, burst, { replay: false }), ...bHeard.problems.splice(0)]);
      samples.push({
        // The talk-start and talk-end go in POSTs too.
        posts: sendPosts.get(names.a) ?? 0,
        firstFrame: (burst.frames[0]?.at ?? NaN) - sent.sentAt[0],
        lastFrame: (burst.frames.at(-1)?.at ?? NaN) - sent.sentAt[sound.payloads.length - 1],
        releaseToEnd: (burst.endAt ?? NaN) - sent.releasedAt,
      });
    }
    // Let the last POST (the talk-end) finish before the proxy goes.
    await sleep(2 * delayMs + 50);
    return samples;
  } finally {
    a.close();
    b.close();
    await up.close();
    await down.close();
  }
}
