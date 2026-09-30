// F. A ring nobody answers: with the relay's ring timeout cut to 500 ms, the sender must hear
// ring-timeout on time, the unheard audio must be dropped (nothing left buffered), and the next
// Talk must ring again rather than replay stale audio.

import { bot, ids, opus, register, startRelay, talk, type Context, type Relay } from "../harness.ts";
import { TOKEN } from "../harness.ts";

export const name = "F. Ring nobody answers";

const RING_TIMEOUT_MS = 500;

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir, { ringTimeoutMs: RING_TIMEOUT_MS });
  try {
    const key = "F.unanswered";
    const lateness: number[] = [];
    for (let i = 0; i < 3; i++) lateness.push(await once(ctx, relay, key));
    ctx.results.add(`${key}.timeout_lateness`, lateness, "ms", "time");
  } finally {
    await relay.close();
  }
}

async function once(ctx: Context, relay: Relay, key: string): Promise<number> {
  const names = ids("f");
  await register(relay, names.a, `local:${names.a}`);
  await register(relay, names.b, `poll:${names.b}`);
  const alice = bot(relay.url, names.a);
  const problems: string[] = [];
  try {
    await alice.connect();
    const sent = await talk(alice, names.b, opus(10), false);
    const timeout = await alice.waitFor("ring-timeout", (m) => m.conversationId === sent.conversationId, RING_TIMEOUT_MS + 5_000);
    const at = performance.now();
    if (timeout.droppedBursts !== 1) problems.push(`ring-timeout dropped ${timeout.droppedBursts} bursts, expected 1`);
    const status = (await (await fetch(`${relay.url}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<{ id: string; bufferedBytes: number; bufferedBursts: number }>;
    const left = status.find((c) => c.id === sent.conversationId);
    if (left && (left.bufferedBytes || left.bufferedBursts)) problems.push(`${left.bufferedBytes} bytes still buffered after the timeout`);
    const again = await talk(alice, names.b, opus(10), false);
    if (!again.pushed) problems.push("the next Talk didn't ring again");
    ctx.results.fail(`${key}.integrity_failures`, problems);
    return at - sent.grantedAt - RING_TIMEOUT_MS;
  } finally {
    alice.close();
  }
}
