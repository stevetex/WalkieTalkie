import { test } from "node:test";
import assert from "node:assert/strict";
import { Firestore, decodeFields, encodeFields, metadataAccessToken } from "../src/firestore.ts";

test("values encode to Firestore's typed JSON and back", () => {
  const data = {
    s: "x",
    i: 1_790_000_000_123,
    d: 0.5,
    b: true,
    n: null,
    when: new Date("2026-09-26T00:00:00.000Z"),
    list: [1, { k: "v" }],
    skipped: undefined,
  };
  const fields = encodeFields(data);
  assert.deepEqual(fields.i, { integerValue: "1790000000123" });
  assert.deepEqual(fields.d, { doubleValue: 0.5 });
  assert.deepEqual(fields.when, { timestampValue: "2026-09-26T00:00:00.000Z" });
  assert.equal("skipped" in fields, false);
  const { skipped, ...rest } = data;
  assert.deepEqual(decodeFields(JSON.parse(JSON.stringify(fields))), rest);
});

// A fetch that answers from a queue of responses and records the requests.
function fakeFetch(responses: Array<Response | Error>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, requests };
}

test("get returns undefined for a missing document without retrying", async () => {
  const { fn, requests } = fakeFetch([new Response("{}", { status: 404 })]);
  const db = new Firestore({ projectId: "p", accessToken: async () => "t", fetch: fn });
  assert.equal(await db.get("devices", "nobody"), undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/devices/nobody");
  assert.equal((requests[0].init?.headers as Record<string, string>).authorization, "Bearer t");
});

test("retryable failures are retried, others aren't", async () => {
  const ok = () => new Response(JSON.stringify({ fields: { name: { stringValue: "W" } } }), { status: 200 });
  const retried = fakeFetch([new Response("busy", { status: 503 }), new TypeError("fetch failed"), ok()]);
  const db = new Firestore({ projectId: "p", accessToken: async () => "t", fetch: retried.fn });
  assert.deepEqual(await db.get("devices", "w"), { name: "W" });
  assert.equal(retried.requests.length, 3);

  const denied = fakeFetch([new Response("no", { status: 403 }), ok()]);
  const db2 = new Firestore({ projectId: "p", accessToken: async () => "t", fetch: denied.fn });
  await assert.rejects(db2.get("devices", "w"), /403/);
  assert.equal(denied.requests.length, 1);
});

test("the metadata token is cached until shortly before it expires", async () => {
  const token = (t: string) => new Response(JSON.stringify({ access_token: t, expires_in: 3599 }), { status: 200 });
  const { fn, requests } = fakeFetch([token("one"), token("two")]);
  const get = metadataAccessToken(fn);
  assert.equal(await get(), "one");
  assert.equal(await get(), "one");
  assert.equal(requests.length, 1);
  assert.equal((requests[0].init?.headers as Record<string, string>)["metadata-flavor"], "Google");
});
