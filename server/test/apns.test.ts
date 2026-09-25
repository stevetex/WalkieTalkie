import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { ApnsPusher, ringAlert } from "../src/apns.ts";

test("provider token is an ES256 JWT that verifies with the key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPath = join(mkdtempSync(join(tmpdir(), "apns-")), "AuthKey_TEST.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  const pusher = new ApnsPusher({ keyPath, keyId: "KEY123", teamId: "TEAM456", bundleId: "com.example.walkiespike" });
  const token = (pusher as unknown as { providerToken(): string }).providerToken();
  const [header, claims, signature] = token.split(".");

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(payload.iss, "TEAM456");
  assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5);
  assert.ok(
    verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
  );
  // Cached rather than re-signed on every push.
  assert.equal((pusher as unknown as { providerToken(): string }).providerToken(), token);
  pusher.close();
});

const ring = {
  conversationId: "0b5c7f0e-3c1a-4d8e-9f10-2a3b4c5d6e7f",
  from: "alice",
  fromName: "Alice",
  burstId: "burst-1",
  pushSentAt: 1_790_000_000_000,
};

test("a ring is a time-sensitive alert that carries the ring and expires with it", () => {
  const push = ringAlert(ring, ring.pushSentAt + 35_000);
  assert.deepEqual(push.payload, {
    aps: {
      alert: { title: "Alice", body: "Tap to listen" },
      sound: "default",
      "interruption-level": "time-sensitive",
      "thread-id": ring.conversationId,
    },
    ...ring,
  });
  assert.equal(push.collapseId, ring.conversationId);
  assert.equal(push.expiresAt, ring.pushSentAt + 35_000);
});

test("alert pushes go to the bundle ID topic with alert headers", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyPath = join(mkdtempSync(join(tmpdir(), "apns-")), "AuthKey_TEST.p8");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  const requests: Array<{ headers: Record<string, unknown>; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: { ...req.headers }, body });
      if (req.url?.endsWith("/badtoken")) {
        res.writeHead(400, { "apns-id": "id-2" });
        res.end(JSON.stringify({ reason: "BadDeviceToken" }));
      } else {
        res.writeHead(200, { "apns-id": "id-1" });
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  const pusher = new ApnsPusher(
    { keyPath, keyId: "KEY123", teamId: "TEAM456", bundleId: "com.cypressoakstudios.overandout" },
    { sandbox: origin, production: origin },
  );
  try {
    const push = ringAlert(ring, ring.pushSentAt + 35_000);
    const ok = await pusher.sendAlert("abcdef0123456789", "sandbox", push);
    assert.equal(ok.ok, true);
    assert.equal(ok.apnsId, "id-1");

    const { headers, body } = requests[0];
    assert.equal(headers[":path"], "/3/device/abcdef0123456789");
    assert.equal(headers["apns-push-type"], "alert");
    assert.equal(headers["apns-topic"], "com.cypressoakstudios.overandout");
    assert.equal(headers["apns-priority"], "10");
    assert.equal(headers["apns-expiration"], String(Math.floor((ring.pushSentAt + 35_000) / 1000)));
    assert.equal(headers["apns-collapse-id"], ring.conversationId);
    assert.match(String(headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(JSON.parse(body), push.payload);

    const bad = await pusher.sendAlert("badtoken", "sandbox", push);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
    assert.equal(bad.reason, "BadDeviceToken");
  } finally {
    pusher.close();
    await new Promise((r) => server.close(r));
  }
});
