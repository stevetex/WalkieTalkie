// I. A live format 2 burst: real certificates and HPKE, followed by ciphertext passthrough.
// The runner also tests a base checkout with only format 1; that checkout skips this scenario.
import { randomUUID } from "node:crypto";
import { createEndpointSecrets, openEndpointSecrets } from "../../src/endpoint-keys.ts";
import { sealBundle, usableKeys } from "../../src/e2ee.ts";
import { Codec } from "../../src/protocol.ts";
import { SpikeClient } from "../../tools/client.ts";
import { befriend, bot, ids, opus, signIn, startRelay, type Context } from "../harness.ts";

export const name = "I. Encrypted format 2 passthrough";

export async function run(ctx: Context): Promise<void> {
  const relay = await startRelay(ctx.relayDir);
  try {
    const config = await fetch(new URL("/v2/config", relay.url)).then((r) => r.json()) as { relay: { audioFormats: number[] } };
    if (!config.relay.audioFormats.includes(2)) return;
    const names = ids("e2ee");
    const a = await signIn(relay, names.a, "ios", "connection");
    const b = await signIn(relay, names.b, "ios", "connection");
    await befriend(relay, a, b);
    const ak = openEndpointSecrets(createEndpointSecrets(a.id, `${a.name}-ios`, "ios"), a.id, `${a.name}-ios`);
    const bk = openEndpointSecrets(createEndpointSecrets(b.id, `${b.name}-ios`, "ios"), b.id, `${b.name}-ios`);
    const sender = bot(relay.url, a);
    const listener = bot(relay.url, b);
    const register = async (client: typeof sender, keys: typeof ak) => client.api("PUT", "/v2/me/device", {
      clientKind: "ios", delivery: { provider: "test", mode: "connection" },
      availability: { enabled: true, notifications: "authorized" },
      capabilities: { relayProtocols: [2], audioFormats: [1, 2], decode: ["opus16k", "pcm16le16k"], encode: ["opus16k"], features: [] },
      e2ee: keys.registration,
    });
    await register(sender, ak);
    await register(listener, bk);
    const sa = new SpikeClient({ server: relay.url, userId: a.id, token: a.token, clientKind: "ios", audioFormats: [1, 2] });
    const sb = new SpikeClient({ server: relay.url, userId: b.id, token: b.token, clientKind: "ios", audioFormats: [1, 2],
      e2ee: { keys: bk, directory: async () => ({ phones: [], devices: [] }) } });
    await sa.connect();
    await sb.connect();
    try {
      const conversationId = randomUUID();
      const burstId = randomUUID();
      const directory = await sa.api("GET", "/v2/friends");
      const keys = directory.friends.find((f: { id: string }) => f.id === b.id).keys;
      const { bundle, cipher } = sealBundle({ conversationId, burstId, codec: "opus16k", from: a.id, to: b.id }, ak.sender,
        usableKeys(b.id, keys, Date.now()).recipients, Date.now());
      const sound = opus(50);
      const pressed = performance.now();
      sa.send({ type: "talk-start", to: b.id, burstId, codec: "opus16k", format: 2, conversationId, e2ee: bundle });
      const decision = await sa.waitFor("floor-granted");
      const granted = performance.now();
      if (decision.conversationId !== conversationId) throw new Error("conversation ID changed");
      const ring = await sb.waitFor("ring");
      sb.send({ type: "join", conversationId, ringId: ring.ringId });
      await sb.waitFor("joined");
      const start = await sb.waitFor("burst-start");
      if (start.format !== 2 || JSON.stringify(start.e2ee) !== JSON.stringify(bundle)) throw new Error("bundle changed in transit");
      const sent = performance.now();
      let ciphertextBytes = 0;
      for (let seq = 0; seq < sound.payloads.length; seq++) {
        const frame = cipher.seal(Codec.opus16k, seq, sound.payloads[seq]);
        ciphertextBytes += frame.length;
        sa.sendFrame(Codec.opus16k, seq, frame.subarray(5));
      }
      sa.send({ type: "talk-end", burstId });
      await sb.waitFor("burst-end");
      const received = performance.now();
      const opened = sb.frames.map((frame) => ({ seq: frame.readUInt32BE(1), payload: frame.subarray(5) }));
      const problems = opened.flatMap((frame, i) => frame.seq !== i || !frame.payload.equals(sound.payloads[i]) ? [`frame ${i} changed`] : []);
      if (opened.length !== sound.payloads.length) problems.push(`got ${opened.length} of ${sound.payloads.length} frames`);
      ctx.results.fail("I.format2.integrity_failures", problems);
      ctx.results.add("I.format2.press_to_grant", granted - pressed, "ms", "time");
      ctx.results.add("I.format2.frames_to_end", received - sent, "ms", "time");
      ctx.results.add("I.format2.frames", opened.length, "frames", "count");
      ctx.results.add("I.format2.bundle_bytes", JSON.stringify(bundle).length, "bytes", "count");
      ctx.results.add("I.format2.ciphertext_bytes", ciphertextBytes, "bytes", "count");
    } finally {
      sa.close();
      sb.close();
    }
  } finally {
    await relay.close();
  }
}
