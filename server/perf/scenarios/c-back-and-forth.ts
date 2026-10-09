// C. Back-and-forth: ten alternating bursts, each reply pressed as soon as the other's
// burst-end arrives (as a person would, after hearing the end). Then both press at once: one
// gets the floor and the other is denied. Once the relay has closed, each conversation's
// telemetry record must count its changes of speaker (turns); a relay from before turns were
// recorded (a PR's base) is skipped.

import { ONE_WAY_MS, checkBurst, liveConversation, opus, proxy, seal, startRelay, talk, type Context, type Recorder, type Talk } from "../harness.ts";
import type { SpikeClient } from "../../tools/client.ts";

export const name = "C. Back-and-forth";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  const key = "C.back_and_forth.ws";
  const expected = new Map<string, number>();
  try {
    const fast = await turns(ctx, relay, 0, 10, key);
    expected.set(fast.conversationId, fast.changes);
    ctx.results.add(`${key}.turn_gap`, fast.gaps, "ms", "time");
    ctx.results.add(`${key}.burst_end_to_grant`, fast.endToGrant, "ms", "time");
    ctx.results.add(`${key}.messages_per_turn`, fast.messages, "messages", "count");
    if (ctx.suite !== "full") return;
    const slow = await turns(ctx, relay, ONE_WAY_MS, 3, key);
    expected.set(slow.conversationId, slow.changes);
    ctx.results.legs(`${key}.turn_gap_legs`, slow.gaps);
  } finally {
    await relay.close();
    ctx.results.fail(`${key}.integrity_failures`, recordedTurns(relay.telemetry(), expected));
  }
}

// Each conversation's oao.conversation record against the changes of speaker the bots made.
function recordedTurns(entries: Array<Record<string, any>>, expected: Map<string, number>): string[] {
  const records = entries.filter((e) => e.kind === "oao.conversation" && expected.has(e.conversationId));
  if (!records.some((r) => "turns" in r)) return [];
  return [...expected].flatMap(([id, changes]) => {
    const record = records.find((r) => r.conversationId === id);
    if (!record) return [`no telemetry record for conversation ${id}`];
    return record.turns === changes ? [] : [`record says ${record.turns} turns, the bots made ${changes}`];
  });
}

async function turns(ctx: Context, relay: Awaited<ReturnType<typeof startRelay>>, delayMs: number, count: number, key: string) {
  const pa = await proxy(relay, delayMs);
  const pb = await proxy(relay, delayMs);
  const { a, b, aHeard, bHeard, names } = await liveConversation(relay, "c", { a: pa.url, b: pb.url });
  const gaps: number[] = [];
  const endToGrant: number[] = [];
  const messages: number[] = [];
  const side = [
    { client: a, heard: aHeard, name: names.a },
    { client: b, heard: bHeard, name: names.b },
  ];
  let changes = 0;
  let conversationId = "";
  try {
    let previous: Talk | null = null;
    for (let turn = 0; turn < count; turn++) {
      const speaker = side[turn % 2];
      const listener = side[(turn + 1) % 2];
      let endAt: number | null = null;
      if (previous) endAt = (await speaker.heard.ended(previous.burstId)).endAt;
      const before = listener.heard.messages.length + speaker.heard.messages.length;
      const sound = opus(5);
      const sent = await talk(speaker.client, listener.name, sound, false);
      conversationId = sent.conversationId;
      if (previous) changes++;
      if (previous) gaps.push(sent.grantedAt - previous.releasedAt);
      if (endAt !== null) endToGrant.push(sent.grantedAt - endAt);
      const burst = await listener.heard.ended(sent.burstId);
      ctx.results.fail(`${key}.integrity_failures`, checkBurst(sound, burst, { replay: false }));
      messages.push(listener.heard.messages.length + speaker.heard.messages.length - before);
      previous = sent;
    }
    await settled(side[0].heard, previous);
    await settled(side[1].heard, previous);
    const both = await bothPress(a, b, names, aHeard, bHeard);
    // The last turn was side[(count - 1) % 2]'s: the other side winning is one more change.
    if (both.winner !== null && both.winner !== side[(count - 1) % 2].client) changes++;
    ctx.results.fail(`${key}.integrity_failures`, [...both.problems, ...aHeard.problems, ...bHeard.problems]);
    return { gaps, endToGrant, messages, changes, conversationId };
  } finally {
    a.close();
    b.close();
    await pa.close();
    await pb.close();
  }
}

// Waits until the last burst has ended for whoever heard it (the other side never hears its own).
async function settled(heard: Recorder, last: Talk | null): Promise<void> {
  if (last && heard.burst(last.burstId)) await heard.ended(last.burstId);
}

// Both press at the same moment: exactly one go-ahead and one floor-denied. Says who won.
async function bothPress(a: SpikeClient, b: SpikeClient, names: { a: string; b: string }, aHeard: Recorder, bHeard: Recorder): Promise<{ problems: string[]; winner: SpikeClient | null }> {
  // Sealed first, so the two talk-starts go out together.
  const [sa, sb] = await Promise.all([seal(a, names.b, opus(1)), seal(b, names.a, opus(1))]);
  const ids = { a: sa.burstId, b: sb.burstId };
  a.send(sa.message);
  b.send(sb.message);
  const decide = (client: SpikeClient, burstId: string) =>
    client.waitForMatch((m) => (m.type === "floor-granted" || m.type === "floor-denied") && m.burstId === burstId, "floor decision");
  const [da, db] = await Promise.all([decide(a, ids.a), decide(b, ids.b)]);
  const granted = [da, db].filter((d) => d.type === "floor-granted").length;
  const denied = [da, db].filter((d) => d.type === "floor-denied").length;
  const problems = granted === 1 && denied === 1 ? [] : [`both pressed: ${granted} granted, ${denied} denied`];
  // Release the floor so nothing is left open.
  if (da.type === "floor-granted") a.send({ type: "talk-end", burstId: ids.a });
  if (db.type === "floor-granted") b.send({ type: "talk-end", burstId: ids.b });
  const winner = da.type === "floor-granted" ? { heard: bHeard, id: ids.a } : { heard: aHeard, id: ids.b };
  if (granted === 1) await winner.heard.ended(winner.id);
  return { problems, winner: granted === 1 ? (da.type === "floor-granted" ? a : b) : null };
}
