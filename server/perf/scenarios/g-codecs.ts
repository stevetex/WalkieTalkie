// G. Opus-sized vs PCM frames: three seconds buffered for a watch that isn't connected, then
// replayed over the HTTP stream. The relay doesn't decode, so stand-in packets of the right
// size (60 bytes for 24 kbps Opus, 640 for PCM) test the same thing. With the full suite the
// replay also runs through a simulated 1 Mbit/s link with the usual delay, where the bytes
// show up as time (the Opus bot cut a device's replay from 1.44 s to 0.89 s).

import { Codec } from "../../src/protocol.ts";
import { ONE_WAY_MS, Recorder, audio, bot, checkBurst, pair, proxy, ringFor, sleep, startRelay, talk, type Context, type Relay } from "../harness.ts";

export const name = "G. Opus vs PCM";

const FRAMES = 150;
const LINK_KBPS = 1000;

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    for (const [label, codec] of [["opus", Codec.opus16k], ["pcm", Codec.pcm16le16k]] as const) {
      const key = `G.codecs.${label}`;
      const fast = await replay(ctx, relay, codec, 0, undefined, key);
      ctx.results.add(`${key}.replay_bytes_down`, fast.bytes, "bytes", "count");
      ctx.results.add(`${key}.join_to_replay_done`, fast.ms, "ms", "time");
      if (ctx.suite !== "full") continue;
      const slow = await replay(ctx, relay, codec, ONE_WAY_MS, LINK_KBPS, key);
      ctx.results.add(`${key}.join_to_replay_done_1mbps`, slow.ms, "ms", "sim");
    }
  } finally {
    await relay.close();
  }
}

async function replay(ctx: Context, relay: Relay, codec: number, delayMs: number, kbps: number | undefined, key: string) {
  const people = await pair(relay, "g", { a: "ws", b: "http" });
  const alice = bot(relay.url, people.a);
  const link = await proxy(relay, delayMs, kbps);
  const bob = bot(link.url, people.b, "http");
  const heard = new Recorder(bob);
  try {
    await alice.connect();
    const sound = audio(codec, FRAMES, 7);
    const sent = await talk(alice, people.b.id, sound, false);
    const { ringId } = await ringFor(relay, people.b, sent.conversationId);
    await sleep(50);
    const joinAt = performance.now();
    await bob.connect(sent.conversationId, undefined, ringId);
    const burst = await heard.ended(sent.burstId, 30_000);
    ctx.results.fail(`${key}.integrity_failures`, [...checkBurst(sound, burst, { replay: true }), ...heard.problems]);
    return { bytes: link.counters.bytesDown, ms: (burst.endAt ?? NaN) - joinAt };
  } finally {
    alice.close();
    bob.close();
    await link.close();
  }
}
