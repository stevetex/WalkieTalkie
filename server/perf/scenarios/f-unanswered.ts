// F. A ring nobody answers: the sender must hear ring-timeout on time (measured from the ring's
// own deadline, its expiresAt), the unheard audio must be dropped (nothing left buffered), and
// the next Talk must ring again rather than replay stale audio.
//
// The relay's ring timeout is cut to 500 ms (RING_TIMEOUT_MS), so the scenario takes a moment
// rather than the deployed 35 s.

import { ADMIN_TOKEN, bot, opus, pair, ringFor, startRelay, talk, type Context, type Relay } from "../harness.ts";

export const name = "F. Ring nobody answers";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir, { RING_TIMEOUT_MS: "500" });
  try {
    const key = "F.unanswered";
    const lateness = await Promise.all([0, 1, 2].map(() => once(ctx, relay, key)));
    ctx.results.add(`${key}.timeout_lateness`, lateness, "ms", "time");
  } finally {
    await relay.close();
  }
}

async function once(ctx: Context, relay: Relay, key: string): Promise<number> {
  const people = await pair(relay, "f");
  const alice = bot(relay.url, people.a);
  const problems: string[] = [];
  try {
    await alice.connect();
    const sent = await talk(alice, people.b.id, opus(10), false);
    const ring = await ringFor(relay, people.b, sent.conversationId);
    const timeout = await alice.waitFor("ring-timeout", (m) => m.conversationId === sent.conversationId, ring.expiresAt - Date.now() + 5_000);
    // The relay's clock, which set the deadline (the same machine's).
    const at = Date.now();
    if (timeout.droppedBursts !== 1) problems.push(`ring-timeout dropped ${timeout.droppedBursts} bursts, expected 1`);
    const status = (await (await fetch(`${relay.url}/admin/status`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).json()) as Array<{ id: string; bufferedBytes: number; bufferedBursts: number }>;
    const left = status.find((c) => c.id === sent.conversationId);
    if (left && (left.bufferedBytes || left.bufferedBursts)) problems.push(`${left.bufferedBytes} bytes still buffered after the timeout`);
    const again = await talk(alice, people.b.id, opus(10), false);
    if (!again.pushed) problems.push("the next Talk didn't ring again");
    ctx.results.fail(`${key}.integrity_failures`, problems);
    return at - ring.expiresAt;
  } finally {
    alice.close();
  }
}
