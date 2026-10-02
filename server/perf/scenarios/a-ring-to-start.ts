// A. Ring-to-start: Alice talks to Bob, who isn't connected; the relay buffers and rings.
// Bob answers, connects and joins, and hears the replay. Bob runs on the WebSocket and on
// the HTTP stream the watch uses (which joins in the request that opens the stream).

import { ONE_WAY_MS, Recorder, bot, checkBurst, opus, pair, proxy, ringFor, sleep, startRelay, talk, type Context } from "../harness.ts";

export const name = "A. Ring-to-start";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    for (const transport of ["ws", "http"] as const) {
      const key = `A.ring_to_start.${transport}`;
      const fast: Sample[] = [];
      for (let i = 0; i < 8; i++) fast.push(await once(ctx, relay, transport, 0, key));
      ctx.results.add(`${key}.press_to_grant`, fast.map((s) => s.pressToGrant), "ms", "time");
      ctx.results.add(`${key}.answer_to_joined`, fast.map((s) => s.answerToJoined), "ms", "time");
      ctx.results.add(`${key}.answer_to_first_frame`, fast.map((s) => s.answerToFirstFrame), "ms", "time");
      ctx.results.add(`${key}.answer_to_replay_done`, fast.map((s) => s.answerToReplayDone), "ms", "time");
      ctx.results.add(`${key}.receiver_messages`, fast.map((s) => s.messages), "messages", "count");
      ctx.results.add(`${key}.receiver_bytes_down`, fast.map((s) => s.bytesDown), "bytes", "count");
      ctx.results.add(`${key}.receiver_bytes_up`, fast.map((s) => s.bytesUp), "bytes", "count");
      ctx.results.add(`${key}.receiver_connections`, fast.map((s) => s.connections), "connections", "count");
      if (ctx.suite !== "full") continue;
      const slow: Sample[] = [];
      for (let i = 0; i < 2; i++) slow.push(await once(ctx, relay, transport, ONE_WAY_MS, key));
      ctx.results.legs(`${key}.press_to_grant_legs`, slow.map((s) => s.pressToGrant));
      ctx.results.legs(`${key}.answer_to_first_frame_legs`, slow.map((s) => s.answerToFirstFrame));
      ctx.results.legs(`${key}.answer_to_replay_done_legs`, slow.map((s) => s.answerToReplayDone));
    }
  } finally {
    await relay.close();
  }
}

interface Sample {
  pressToGrant: number;
  answerToJoined: number;
  answerToFirstFrame: number;
  answerToReplayDone: number;
  messages: number;
  bytesDown: number;
  bytesUp: number;
  connections: number;
}

async function once(ctx: Context, relay: Awaited<ReturnType<typeof startRelay>>, transport: "ws" | "http", delayMs: number, key: string): Promise<Sample> {
  const people = await pair(relay, "a", { a: "ws", b: transport });
  const up = await proxy(relay, delayMs);
  const down = await proxy(relay, delayMs);
  const alice = bot(up.url, people.a);
  const bob = bot(down.url, people.b, transport);
  const heard = new Recorder(bob);
  try {
    await alice.connect();
    const sound = opus(50);
    const sent = await talk(alice, people.b.id, sound, false);
    // The ring Bob's push carries.
    const { ringId } = await ringFor(relay, people.b, sent.conversationId);
    // Bob answers later; by then everything Alice sent has reached the relay.
    await sleep(2 * delayMs + 50);
    const answerAt = performance.now();
    if (transport === "http") {
      await bob.connect(sent.conversationId, undefined, ringId);
    } else {
      await bob.connect();
      bob.send({ type: "join", conversationId: sent.conversationId, ringId });
    }
    const burst = await heard.ended(sent.burstId);
    const problems = [...checkBurst(sound, burst, { replay: true }), ...heard.problems];
    if (!sent.pushed) problems.push("the Talk didn't ring");
    ctx.results.fail(`${key}.integrity_failures`, problems);
    return {
      pressToGrant: sent.grantedAt - sent.pressedAt,
      answerToJoined: (heard.at("joined") ?? NaN) - answerAt,
      answerToFirstFrame: (burst.frames[0]?.at ?? NaN) - answerAt,
      answerToReplayDone: (burst.endAt ?? NaN) - answerAt,
      messages: heard.messages.length,
      bytesDown: down.counters.bytesDown,
      bytesUp: down.counters.bytesUp,
      connections: down.counters.connections,
    };
  } finally {
    alice.close();
    bob.close();
    await up.close();
    await down.close();
  }
}
