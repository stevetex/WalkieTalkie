import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDocs } from "../src/docs.ts";
import { PreconditionFailed } from "../src/firestore.ts";
import { Accounts, AccountError, cleanName } from "../src/accounts.ts";
import { accountsSuite, interleaved } from "./accounts-suite.ts";

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

test("memory docs: a transaction runs again when something it read changes before it commits", async () => {
  const docs = new MemoryDocs();
  await docs.commit([{ set: "a/1", data: { n: 1 } }]);
  let runs = 0;
  const result = await docs.transaction(async (get) => {
    runs++;
    const [a] = await get(["a/1", "a/missing"]);
    // A write lands after the first run's reads, to a document it read (and one it found missing).
    if (runs === 1) await docs.commit([{ set: "a/1", data: { n: 5 } }, { set: "a/missing", data: {} }]);
    return { writes: [{ set: "b/1", data: { copy: a!.n } }], result: a!.n };
  });
  assert.equal(runs, 2);
  assert.equal(result, 5);
  assert.deepEqual(await docs.getAll(["b/1"]), [{ copy: 5 }]);
});

test("a block committed between an invite's checks and its commit isn't undone by the friendship", async () => {
  const docs = interleaved(new MemoryDocs());
  const accounts = new Accounts(docs);
  const alice = (await accounts.signInWithApple("001.alice.1", "Alice")).user;
  const bob = (await accounts.signInWithApple("001.bob.1", "Bob")).user;
  const { code } = await accounts.createInvite(alice.id);
  // The block commits in full after the acceptance has read that there's none.
  docs.between = () => accounts.block(alice.id, bob.id);
  await assert.rejects(accounts.acceptInvite(code, bob.id), (err) => err instanceof AccountError && err.code === "invite-not-found");
  assert.deepEqual(await accounts.friends(alice.id), []);
  assert.deepEqual(await accounts.friends(bob.id), []);
  assert.equal(await accounts.canTalk(bob.id, alice.id), false);
});
