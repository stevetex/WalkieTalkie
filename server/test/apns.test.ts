import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApnsPusher } from "../src/apns.ts";

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
