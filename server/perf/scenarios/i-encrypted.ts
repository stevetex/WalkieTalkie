// I. A live format 2 burst: what encryption adds on the wire (the key bundle, the frames'
// ciphertext and tags), and that the relay passes both through untouched: the listener gets the
// bundle exactly as sealed, and every frame opens (a changed byte wouldn't). Every scenario
// talks format 2; this one measures the encryption itself.
import { Codec, FRAME_HEADER_BYTES } from "../../src/protocol.ts";
import { befriend, bot, ids, opus, seal, signIn, startRelay, type Context } from "../harness.ts";

export const name = "I. Encrypted format 2 passthrough";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    const names = ids("e2ee");
    const a = await signIn(relay, names.a, "ios", "connection");
    const b = await signIn(relay, names.b, "ios", "connection");
    await befriend(relay, a, b);
    const sender = bot(relay.url, a);
    const listener = bot(relay.url, b);
    await sender.connect();
    await listener.connect();
    try {
      const sound = opus(50);
      const sealed = await seal(sender, b.id, sound);
      if (sealed.message.type !== "talk-start") throw new Error("not a talk-start");
      const { burstId, conversationId, e2ee: bundle } = sealed.message;
      const pressed = performance.now();
      sender.send(sealed.message);
      const decision = await sender.waitFor("floor-granted", (m) => m.burstId === burstId);
      const granted = performance.now();
      if (decision.conversationId !== conversationId) throw new Error("conversation ID changed");
      // Rung over its connection, the listener joins; the burst is then live.
      const ring = await listener.waitFor("ring");
      listener.send({ type: "join", conversationId, ringId: ring.ringId });
      await listener.waitFor("joined");
      const start = await listener.waitFor("burst-start");
      const problems: string[] = [];
      if (start.format !== 2 || JSON.stringify(start.e2ee) !== JSON.stringify(bundle)) problems.push("bundle changed in transit");
      const sent = performance.now();
      for (const [seq, frame] of sealed.frames.entries()) sender.sendFrame(Codec.opus16k, seq, frame);
      sender.send({ type: "talk-end", burstId });
      await listener.waitFor("burst-end");
      const received = performance.now();
      // The listener's client keeps only frames that opened, as header and plaintext.
      const opened = listener.frames.map((frame) => ({ seq: frame.readUInt32BE(1), payload: frame.subarray(FRAME_HEADER_BYTES) }));
      problems.push(...opened.flatMap((frame, i) => frame.seq !== i || !frame.payload.equals(sound.payloads[i]) ? [`frame ${i} changed`] : []));
      if (opened.length !== sound.payloads.length) problems.push(`got ${opened.length} of ${sound.payloads.length} frames`);
      ctx.results.fail("I.format2.integrity_failures", problems);
      ctx.results.add("I.format2.press_to_grant", granted - pressed, "ms", "time");
      ctx.results.add("I.format2.frames_to_end", received - sent, "ms", "time");
      ctx.results.add("I.format2.frames", opened.length, "frames", "count");
      ctx.results.add("I.format2.bundle_bytes", JSON.stringify(bundle).length, "bytes", "count");
      // On the wire: each frame's header, ciphertext and tag.
      ctx.results.add("I.format2.ciphertext_bytes", sealed.frames.reduce((n, frame) => n + FRAME_HEADER_BYTES + frame.length, 0), "bytes", "count");
    } finally {
      sender.close();
      listener.close();
    }
  } finally {
    await relay.close();
  }
}
