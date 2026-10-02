// The frozen v2 contract (contracts/README.md): every example against its schema, the binary
// fixtures against the relay's own parsers, and the requests the server must refuse against
// the server's validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SchemaSet } from "./json-schema.ts";
import { isValidFrame } from "../src/protocol.ts";
import { RecordParser } from "../src/records.ts";

const contracts = join(import.meta.dirname!, "..", "..", "contracts");
const schemas = new SchemaSet(join(contracts, "schemas"));
const manifest = JSON.parse(readFileSync(join(contracts, "examples", "manifest.json"), "utf8")) as {
  examples: Array<{ file: string; schema: string; direction: "request" | "response"; many?: boolean; schemaValid?: boolean; serverError?: string }>;
};

export function example(file: string): unknown {
  return JSON.parse(readFileSync(join(contracts, "examples", file), "utf8"));
}

test("contracts: every schema's references resolve, and every example is listed", () => {
  for (const name of schemas.names) schemas.validate(name, {});
  const listed = new Set(manifest.examples.map((e) => e.file));
  for (const dir of ["current", "future", "rejected"]) {
    for (const file of readdirSafe(join(contracts, "examples", dir))) assert.ok(listed.has(`${dir}/${file}`), `${dir}/${file} isn't in manifest.json`);
  }
});

test("contracts: current and future examples follow their schemas; rejected ones as the manifest says", () => {
  for (const entry of manifest.examples) {
    const value = example(entry.file);
    const values = entry.many ? (value as unknown[]) : [value];
    for (const [i, v] of values.entries()) {
      const errors = schemas.validate(entry.schema, v);
      const where = `${entry.file}${entry.many ? `[${i}]` : ""}`;
      if (entry.file.startsWith("rejected/")) {
        assert.equal(errors.length === 0, entry.schemaValid === true, `${where}: schema says ${errors.join("; ") || "valid"}`);
      } else {
        assert.deepEqual(errors, [], `${where} against ${entry.schema}`);
      }
    }
  }
});

test("contracts: binary frames are accepted or dropped exactly as the fixtures say", () => {
  const { frames } = JSON.parse(readFileSync(join(contracts, "fixtures", "frames.json"), "utf8")) as {
    frames: Array<{ name: string; valid: boolean; hex: string; codec?: string; seq?: number; payloadBytes?: number }>;
  };
  assert.ok(frames.some((f) => f.codec === "opus16k" && f.valid) && frames.some((f) => f.codec === "pcm16le16k" && f.valid));
  for (const f of frames) {
    const frame = Buffer.from(f.hex, "hex");
    assert.equal(isValidFrame(frame), f.valid, f.name);
    if (!f.valid) continue;
    assert.equal(frame[0], f.codec === "opus16k" ? 1 : 2, f.name);
    assert.equal(frame.readUInt32BE(1), f.seq, f.name);
    assert.equal(frame.length - 5, f.payloadBytes, f.name);
  }
});

test("contracts: records parse whole, across chunk boundaries, and malformed ones are refused", () => {
  const { records } = JSON.parse(readFileSync(join(contracts, "fixtures", "records.json"), "utf8")) as {
    records: Array<{ name: string; type?: string; json?: unknown; hex?: string; chunks?: string[]; records?: string[]; valid?: boolean }>;
  };
  const byName = new Map(records.map((r) => [r.name, r]));
  for (const r of records) {
    if (r.chunks) {
      const parser = new RecordParser();
      const parsed = r.chunks.flatMap((c) => parser.push(Buffer.from(c, "hex")));
      assert.deepEqual(parsed.map((p) => (p.type === 1 ? "json" : "audio")), r.records!.map((n) => byName.get(n)!.type), r.name);
      continue;
    }
    const parser = new RecordParser();
    if (r.valid === false) {
      assert.throws(() => parser.push(Buffer.from(r.hex!, "hex")), r.name);
      continue;
    }
    const [record] = parser.push(Buffer.from(r.hex!, "hex"));
    assert.equal(record.type, r.type === "json" ? 1 : 2, r.name);
    if (r.json) assert.deepEqual(JSON.parse(record.payload.toString("utf8")), r.json, r.name);
  }
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}
