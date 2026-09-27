import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDocs } from "../src/docs.ts";
import { PreconditionFailed } from "../src/firestore.ts";
import { cleanName } from "../src/accounts.ts";
import { accountsSuite } from "./accounts-suite.ts";

accountsSuite("memory", () => new MemoryDocs());

test("memory docs: preconditions make a commit all or nothing", async () => {
  const docs = new MemoryDocs();
  await docs.commit([{ set: "a/1", data: { n: 1 }, exists: false }]);
  await assert.rejects(
    docs.commit([{ set: "a/2", data: { n: 2 } }, { set: "a/1", data: { n: 3 }, exists: false }]),
    PreconditionFailed,
  );
  assert.deepEqual(await docs.getAll(["a/1", "a/2"]), [{ n: 1 }, undefined]);
  await assert.rejects(docs.commit([{ delete: "a/9", exists: true }]), PreconditionFailed);
  await docs.commit([{ set: "a/1", data: { m: 2 }, fields: ["m"] }]);
  assert.deepEqual(await docs.getAll(["a/1"]), [{ n: 1, m: 2 }]);
});

test("memory docs: lists only direct children, and queries filter and sort", async () => {
  const docs = new MemoryDocs();
  await docs.commit([
    { set: "users/u1", data: { n: 1 } },
    { set: "users/u1/friends/u2", data: { since: new Date(2) } },
    { set: "users/u2", data: { n: 3 } },
  ]);
  assert.deepEqual((await docs.list("users")).map((d) => d.id), ["u1", "u2"]);
  assert.deepEqual((await docs.list("users/u1/friends")).map((d) => d.id), ["u2"]);
  assert.deepEqual((await docs.query("users", { where: { field: "n", op: "GREATER_THAN", value: 1 } })).map((d) => d.id), ["u2"]);
  assert.deepEqual((await docs.query("users", { orderBy: { field: "n", direction: "DESCENDING" }, limit: 1 })).map((d) => d.id), ["u2"]);
  await assert.rejects(docs.list("users/u1"), /invalid collection/);
});

test("memory docs: saved to a file, dates and all", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "docs-")), "accounts.json");
  const docs = new MemoryDocs(file);
  await docs.commit([{ set: "invites/x", data: { expireAt: new Date(123), from: "u_1" } }]);
  assert.deepEqual(await new MemoryDocs(file).getAll(["invites/x"]), [{ expireAt: new Date(123), from: "u_1" }]);
});

test("names are trimmed, single-spaced and at most 40 characters", () => {
  assert.equal(cleanName("  Steve   T  "), "Steve T");
  assert.equal(cleanName("‮evil​"), "evil");
  assert.equal(cleanName("x".repeat(50))?.length, 40);
  assert.equal(cleanName("   "), undefined);
  assert.equal(cleanName(3), undefined);
});
