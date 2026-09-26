import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSecrets } from "../src/secrets.ts";

test("NAME_SECRET variables are replaced by the secret's latest version", async () => {
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    const value = url.includes("/relay-token/") ? "tok" : "-----BEGIN PRIVATE KEY-----\nabc\n";
    return new Response(JSON.stringify({ payload: { data: Buffer.from(value).toString("base64") } }), { status: 200 });
  }) as unknown as typeof fetch;
  const env: NodeJS.ProcessEnv = { SPIKE_TOKEN_SECRET: "relay-token", APNS_KEY_SECRET: "apns-key", OTHER: "x" };
  const loaded = await loadSecrets(env, "proj", async () => "t", fetchFn);
  assert.deepEqual(loaded.sort(), ["APNS_KEY", "SPIKE_TOKEN"]);
  assert.equal(env.SPIKE_TOKEN, "tok");
  assert.match(env.APNS_KEY!, /BEGIN PRIVATE KEY/);
  assert.ok(urls.includes("https://secretmanager.googleapis.com/v1/projects/proj/secrets/relay-token/versions/latest:access"));
});

test("a missing secret stops startup", async () => {
  const fetchFn = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(loadSecrets({ SPIKE_TOKEN_SECRET: "nope" }, "proj", async () => "t", fetchFn), /secret nope for SPIKE_TOKEN: 404/);
});
