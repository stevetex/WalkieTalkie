// The document operations the account API uses, so its logic runs unchanged on Firestore
// (production, and the emulator in tests) and on MemoryDocs (local runs and unit tests).
// Paths are Firestore-style: "users/u_1" is a document, "users/u_1/friends" a collection.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  PreconditionFailed,
  TransactionAborted,
  decodeFields,
  encodeFields,
  splitPath,
  type FirestoreData,
  type FirestoreDocument,
  type Query,
  type TransactionGet,
  type Write,
} from "./firestore.ts";

export interface Docs {
  // Undefined for documents that don't exist, in the order asked for.
  getAll(paths: string[]): Promise<Array<FirestoreData | undefined>>;
  list(collection: string): Promise<FirestoreDocument[]>;
  query(collection: string, query: Query): Promise<FirestoreDocument[]>;
  // All or nothing; PreconditionFailed if an `exists` check fails.
  commit(writes: Write[]): Promise<void>;
  // `fn` reads through `get` and returns writes, which commit only if none of the documents it
  // read changed meanwhile; if one did, `fn` runs again. For checks that a concurrent write
  // must not slip past (a block landing while an invite is accepted).
  transaction<T>(fn: (get: TransactionGet) => Promise<{ writes: Write[]; result: T }>): Promise<T>;
}

// In memory, optionally saved to a JSON file after each commit (Firestore's typed JSON, so
// dates survive).
export class MemoryDocs implements Docs {
  private docs = new Map<string, FirestoreData>();
  // The commit that last wrote each path, so a transaction can tell whether what it read changed.
  private versions = new Map<string, number>();
  private commits = 0;
  private file: string | null;

  constructor(file: string | null = null) {
    this.file = file;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Parameters<typeof decodeFields>[0]>;
      for (const [path, fields] of Object.entries(saved)) this.docs.set(path, decodeFields(fields));
    }
  }

  async getAll(paths: string[]): Promise<Array<FirestoreData | undefined>> {
    return paths.map((p) => {
      checkDocument(p);
      const data = this.docs.get(p);
      return data ? structuredClone(data) : undefined;
    });
  }

  async list(collection: string): Promise<FirestoreDocument[]> {
    checkCollection(collection);
    const prefix = `${collection}/`;
    const found: FirestoreDocument[] = [];
    for (const [path, data] of this.docs) {
      const id = path.slice(prefix.length);
      if (path.startsWith(prefix) && !id.includes("/")) found.push({ id, data: structuredClone(data) });
    }
    return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async query(collection: string, query: Query): Promise<FirestoreDocument[]> {
    let rows = await this.list(collection);
    const where = query.where;
    if (where) {
      rows = rows.filter((r) => {
        const c = compare(r.data[where.field], where.value);
        if (c === null) return false;
        switch (where.op) {
          case "EQUAL": return c === 0;
          case "LESS_THAN": return c < 0;
          case "LESS_THAN_OR_EQUAL": return c <= 0;
          case "GREATER_THAN": return c > 0;
          case "GREATER_THAN_OR_EQUAL": return c >= 0;
        }
      });
    }
    const orderBy = query.orderBy;
    if (orderBy) {
      const sign = orderBy.direction === "DESCENDING" ? -1 : 1;
      rows = rows
        .filter((r) => r.data[orderBy.field] !== undefined)
        .sort((a, b) => sign * (compare(a.data[orderBy.field], b.data[orderBy.field]) ?? 0));
    }
    return query.limit ? rows.slice(0, query.limit) : rows;
  }

  // Optimistic: `fn` runs again if a document it read was written before it commits. The
  // check and the commit run with no await between them, so nothing can land in between.
  async transaction<T>(fn: (get: TransactionGet) => Promise<{ writes: Write[]; result: T }>): Promise<T> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const read = new Map<string, number>();
      const { writes, result } = await fn(async (paths) => {
        for (const p of paths) if (!read.has(p)) read.set(p, this.versions.get(p) ?? 0);
        return this.getAll(paths);
      });
      if ([...read].every(([p, version]) => (this.versions.get(p) ?? 0) === version)) {
        await this.commit(writes);
        return result;
      }
    }
    throw new TransactionAborted("transaction retried too many times");
  }

  async commit(writes: Write[]): Promise<void> {
    const commit = ++this.commits;
    for (const w of writes) {
      const path = "delete" in w ? w.delete : w.set;
      checkDocument(path);
      if (w.exists !== undefined && this.docs.has(path) !== w.exists) {
        throw new PreconditionFailed(`${path} ${w.exists ? "doesn't exist" : "already exists"}`);
      }
    }
    for (const w of writes) {
      this.versions.set("delete" in w ? w.delete : w.set, commit);
      if ("delete" in w) {
        this.docs.delete(w.delete);
      } else if (w.fields) {
        const data = { ...(this.docs.get(w.set) ?? {}) };
        for (const field of w.fields) {
          if (w.data[field] === undefined) delete data[field];
          else data[field] = structuredClone(w.data[field]);
        }
        this.docs.set(w.set, data);
      } else {
        this.docs.set(w.set, structuredClone(stripUndefined(w.data)));
      }
    }
    if (this.file) {
      const saved: Record<string, unknown> = {};
      for (const [path, data] of this.docs) saved[path] = encodeFields(data);
      writeFileSync(this.file, JSON.stringify(saved, null, 2));
    }
  }
}

function checkDocument(path: string): void {
  if (splitPath(path).length % 2 !== 0) throw new Error(`invalid document path ${JSON.stringify(path)}`);
}

function checkCollection(path: string): void {
  if (splitPath(path).length % 2 !== 1) throw new Error(`invalid collection ${JSON.stringify(path)}`);
}

function stripUndefined(data: FirestoreData): FirestoreData {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
}

// Firestore compares values of the same type; different types never match a filter.
function compare(a: unknown, b: unknown): number | null {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return null;
}
