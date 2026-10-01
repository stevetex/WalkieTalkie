import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryDocs } from "../src/docs.ts";
import { Accounts, AccountError } from "../src/accounts.ts";
import { nameAllowed, parseBlocklist } from "../src/name-filter.ts";

test("name filter: listed words are refused, also disguised", () => {
  for (const name of ["shit", "Shit Head", "sh1t", "S.H.I.T", "s h i t", "Bitches", "MotherFucker99", "Grandma 🖕", "Ünal Anal"]) {
    assert.equal(nameAllowed(name), false, name);
  }
});

test("name filter: whole words only, and real names pass", () => {
  for (const name of ["Scunthorpe", "Cassandra", "Glass Bass", "Ana L", "S M Jones", "Dick Van Dyke", "Mohammed Butt", "Bob!", "Steve", "Test Bot", "Zoë"]) {
    assert.equal(nameAllowed(name), true, name);
  }
});

test("name filter: no common first name is refused", () => {
  // macOS's list of proper names, where present (CI on Linux skips it).
  let names: string[];
  try {
    names = readFileSync("/usr/share/dict/propernames", "utf8").split("\n").filter(Boolean);
  } catch {
    return;
  }
  assert.deepEqual(names.filter((name) => !nameAllowed(name)), []);
});

test("name filter: phrases match the same words in a row", () => {
  const list = parseBlocklist("# a comment\nbad word\nbad\n");
  assert.equal(nameAllowed("A Bad Word Here", list), false);
  assert.equal(nameAllowed("Word Bad", list), false); // "bad" alone
  assert.equal(nameAllowed("Words", list), true);
});

test("name filter: renames are refused, and a disallowed Apple name becomes Friend", async () => {
  const accounts = new Accounts(new MemoryDocs());
  const { user } = await accounts.signInWithApple("apple-sub-1", "Shit Head");
  assert.equal(user.name, "Friend");
  await assert.rejects(accounts.rename(user.id, "sh1t"), (err: unknown) => err instanceof AccountError && err.code === "name-not-allowed");
  assert.equal((await accounts.rename(user.id, "Steve")).name, "Steve");
});
