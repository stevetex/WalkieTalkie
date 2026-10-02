// E. First press, cold vs pre-connected: pressing Talk to a friend who isn't in a
// conversation, with no connection yet (the connection opens after the press) or with one the
// Talk screen already opened. Over the WebSocket and the watch's HTTP stream.

import { ONE_WAY_MS, bot, opus, pair, proxy, startRelay, talk, type Context } from "../harness.ts";

export const name = "E. First press";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    for (const transport of ["ws", "http"] as const) {
      for (const warm of [false, true]) {
        const key = `E.first_press.${transport}.${warm ? "preconnected" : "cold"}`;
        const fast: number[] = [];
        for (let i = 0; i < 5; i++) fast.push(await press(ctx, relay, transport, warm, 0, key));
        ctx.results.add(`${key}.press_to_grant`, fast, "ms", "time");
        if (ctx.suite !== "full") continue;
        const slow: number[] = [];
        for (let i = 0; i < 2; i++) slow.push(await press(ctx, relay, transport, warm, ONE_WAY_MS, key));
        ctx.results.legs(`${key}.press_to_grant_legs`, slow);
      }
    }
  } finally {
    await relay.close();
  }
}

async function press(ctx: Context, relay: Awaited<ReturnType<typeof startRelay>>, transport: "ws" | "http", warm: boolean, delayMs: number, key: string): Promise<number> {
  // A friend whose watch isn't connected: the press rings it.
  const people = await pair(relay, "e", { a: transport, b: "http" });
  const link = await proxy(relay, delayMs);
  const alice = bot(link.url, people.a, transport);
  try {
    if (warm) await alice.connect();
    const pressedAt = performance.now();
    if (!warm) await alice.connect();
    const sent = await talk(alice, people.b.id, opus(5), false, pressedAt);
    ctx.results.fail(`${key}.integrity_failures`, sent.pushed ? [] : ["the first press didn't ring"]);
    return sent.grantedAt - pressedAt;
  } finally {
    alice.close();
    await link.close();
  }
}
