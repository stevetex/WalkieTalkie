// A small Firestore client over the REST API, so the server stays free of dependencies.
// It covers what the relay and the account API need: get, set and create documents, read
// several at once, list a collection, run a query, and commit several writes atomically
// with preconditions. Collections can be subcollections ("users/u_1/friends"). On a Google Cloud VM it authenticates with the VM service account's token
// from the metadata server; against the emulator it sends no real credentials.
//
// Firestore's REST API wraps every value in a typed object ({ stringValue: "x" }, and so
// on). encodeFields and decodeFields convert plain objects both ways: numbers become
// integerValue or doubleValue, and Dates become timestampValue (TTL fields must be
// timestamps).

import { execFileSync } from "node:child_process";

export type FirestoreData = Record<string, unknown>;

export interface FirestoreDocument {
  // The last path segment, for example the userId of devices/{userId}.
  id: string;
  data: FirestoreData;
}

export interface FirestoreOptions {
  projectId: string;
  databaseId?: string;
  // host:port of the Firestore emulator. Requests go there over plain HTTP.
  emulatorHost?: string;
  // Returns a bearer token for production requests.
  accessToken?: () => Promise<string>;
  fetch?: typeof fetch;
  // Attempts per request for retryable failures (429, 5xx, network errors).
  attempts?: number;
}

export interface QueryFilter {
  field: string;
  op: "EQUAL" | "LESS_THAN" | "LESS_THAN_OR_EQUAL" | "GREATER_THAN" | "GREATER_THAN_OR_EQUAL";
  value: unknown;
}

// One write in an atomic commit. `exists` is a precondition: false = create only, true =
// the document must already exist. `fields` limits a set to those fields (a merge).
export type Write =
  | { set: string; data: FirestoreData; fields?: string[]; exists?: boolean }
  | { delete: string; exists?: boolean };

export interface Query {
  where?: QueryFilter;
  orderBy?: { field: string; direction?: "ASCENDING" | "DESCENDING" };
  limit?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const REQUEST_TIMEOUT_MS = 10_000;

export class FirestoreError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// A commit's precondition failed: the document existed (or didn't) when it mattered.
export class PreconditionFailed extends Error {}

// A transaction's commit lost to a concurrent write to something it read; run it again.
export class TransactionAborted extends Error {}

// Reads inside a transaction (see Firestore.transaction and Docs.transaction).
export type TransactionGet = (paths: string[]) => Promise<Array<FirestoreData | undefined>>;

const TRANSACTION_ATTEMPTS = 5;

export class Firestore {
  private base: string;
  private documentsPath: string;
  private accessToken: () => Promise<string>;
  private fetch: typeof fetch;
  private attempts: number;

  constructor(options: FirestoreOptions) {
    const database = options.databaseId ?? "(default)";
    this.documentsPath = `projects/${options.projectId}/databases/${database}/documents`;
    this.base = options.emulatorHost ? `http://${options.emulatorHost}/v1` : "https://firestore.googleapis.com/v1";
    // The emulator accepts "owner" as an all-access token.
    this.accessToken = options.emulatorHost ? async () => "owner" : (options.accessToken ?? metadataAccessToken());
    this.fetch = options.fetch ?? fetch;
    this.attempts = options.attempts ?? 3;
  }

  // Undefined when the document doesn't exist.
  async get(collection: string, id: string): Promise<FirestoreData | undefined> {
    const res = await this.request("GET", this.documentPath(collection, id), undefined, [404]);
    if (res.status === 404) return undefined;
    return decodeFields((await res.json()).fields ?? {});
  }

  // Several documents in one request, in the order asked for; undefined for missing ones.
  // Paths are "collection/id" (or deeper).
  async getAll(paths: string[], transaction?: string): Promise<Array<FirestoreData | undefined>> {
    if (!paths.length) return [];
    const names = paths.map((p) => this.fullName(p));
    const res = await this.request("POST", `${this.documentsPath}:batchGet`, { documents: names, ...(transaction ? { transaction } : {}) });
    const rows = (await res.json()) as Array<{ found?: { name: string; fields?: Record<string, FirestoreValue> }; missing?: string }>;
    const byName = new Map<string, FirestoreData>();
    for (const row of rows) if (row.found) byName.set(row.found.name, decodeFields(row.found.fields ?? {}));
    return names.map((n) => byName.get(n));
  }

  // Creates the document, or replaces all of its fields.
  async set(collection: string, id: string, data: FirestoreData): Promise<void> {
    await this.request("PATCH", this.documentPath(collection, id), { fields: encodeFields(data) });
  }

  // Creates a document with a generated ID.
  async add(collection: string, data: FirestoreData): Promise<string> {
    const res = await this.request("POST", this.collectionPath(collection), { fields: encodeFields(data) });
    return lastSegment((await res.json()).name);
  }

  // Every document in a collection, following page tokens.
  async list(collection: string): Promise<FirestoreDocument[]> {
    const documents: FirestoreDocument[] = [];
    let pageToken = "";
    do {
      const query = `pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const body = await (await this.request("GET", `${this.collectionPath(collection)}?${query}`)).json();
      for (const doc of body.documents ?? []) documents.push({ id: lastSegment(doc.name), data: decodeFields(doc.fields ?? {}) });
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return documents;
  }

  async query(collection: string, query: Query): Promise<FirestoreDocument[]> {
    const segments = splitPath(collection);
    if (segments.length % 2 !== 1) throw new Error(`invalid collection ${JSON.stringify(collection)}`);
    const collectionId = segments.pop()!;
    const structuredQuery: Record<string, unknown> = { from: [{ collectionId }] };
    if (query.where) {
      structuredQuery.where = {
        fieldFilter: { field: { fieldPath: query.where.field }, op: query.where.op, value: encodeValue(query.where.value) },
      };
    }
    if (query.orderBy) {
      structuredQuery.orderBy = [{ field: { fieldPath: query.orderBy.field }, direction: query.orderBy.direction ?? "ASCENDING" }];
    }
    if (query.limit) structuredQuery.limit = query.limit;
    // A subcollection is queried under its parent document.
    const parent = segments.length ? `${this.documentsPath}/${segments.map(encodeURIComponent).join("/")}` : this.documentsPath;
    const res = await this.request("POST", `${parent}:runQuery`, { structuredQuery });
    const rows = (await res.json()) as Array<{ document?: { name: string; fields?: Record<string, FirestoreValue> } }>;
    return rows.flatMap((row) =>
      row.document ? [{ id: lastSegment(row.document.name), data: decodeFields(row.document.fields ?? {}) }] : [],
    );
  }

  // How many documents a collection has (Firestore's count(): about one read per 1,000), or,
  // with allDescendants, every collection of that ID anywhere ("friends" under every user).
  async count(collection: string, options: { allDescendants?: boolean; where?: QueryFilter } = {}): Promise<number> {
    const segments = splitPath(collection);
    if (segments.length % 2 !== 1) throw new Error(`invalid collection ${JSON.stringify(collection)}`);
    const collectionId = segments.pop()!;
    const structuredQuery: Record<string, unknown> = { from: [{ collectionId, ...(options.allDescendants ? { allDescendants: true } : {}) }] };
    if (options.where) {
      structuredQuery.where = { fieldFilter: { field: { fieldPath: options.where.field }, op: options.where.op, value: encodeValue(options.where.value) } };
    }
    const parent = segments.length ? `${this.documentsPath}/${segments.map(encodeURIComponent).join("/")}` : this.documentsPath;
    const res = await this.request("POST", `${parent}:runAggregationQuery`, { structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: "n", count: {} }] } });
    const rows = (await res.json()) as Array<{ result?: { aggregateFields?: { n?: { integerValue?: string } } } }>;
    return Number(rows.find((r) => r.result)?.result?.aggregateFields?.n?.integerValue ?? 0);
  }

  // A read-write transaction: `fn` reads through `get` (Firestore locks what it reads) and
  // returns the writes, which commit only if nothing it read has changed. If a concurrent
  // write wins, `fn` runs again.
  async transaction<T>(fn: (get: TransactionGet) => Promise<{ writes: Write[]; result: T }>): Promise<T> {
    let retryTransaction: string | undefined;
    for (let attempt = 1; ; attempt++) {
      const begin = await this.request("POST", `${this.documentsPath}:beginTransaction`, {
        options: { readWrite: retryTransaction ? { retryTransaction } : {} },
      });
      const { transaction } = (await begin.json()) as { transaction: string };
      let outcome: { writes: Write[]; result: T };
      try {
        outcome = await fn((paths) => this.getAll(paths, transaction));
      } catch (err) {
        // Release the locks now rather than when the transaction times out.
        await this.request("POST", `${this.documentsPath}:rollback`, { transaction }).catch(() => {});
        throw err;
      }
      try {
        await this.commit(outcome.writes, transaction);
        return outcome.result;
      } catch (err) {
        if (!(err instanceof TransactionAborted) || attempt >= TRANSACTION_ATTEMPTS) throw err;
        retryTransaction = transaction;
      }
    }
  }

  // Applies all the writes or none. Throws PreconditionFailed if an `exists` check fails.
  // In a transaction, TransactionAborted if something it read changed.
  async commit(writes: Write[], transaction?: string): Promise<void> {
    if (!writes.length && !transaction) return;
    const body = {
      ...(transaction ? { transaction } : {}),
      writes: writes.map((w) => {
        const precondition = w.exists === undefined ? {} : { currentDocument: { exists: w.exists } };
        if ("delete" in w) return { delete: this.fullName(w.delete), ...precondition };
        const fields = encodeFields(w.data);
        return {
          update: { name: this.fullName(w.set), fields },
          ...(w.fields ? { updateMask: { fieldPaths: w.fields } } : {}),
          ...precondition,
        };
      }),
    };
    // A commit isn't retried: a retry after a lost response could fail its own precondition.
    const res = await this.request("POST", `${this.documentsPath}:commit`, body, [400, 404, 409], 1);
    if (res.ok) return;
    const text = await res.text();
    if (transaction && text.includes("ABORTED")) throw new TransactionAborted(`Firestore commit aborted: ${text.slice(0, 200)}`);
    if (res.status === 409 || res.status === 404 || text.includes("FAILED_PRECONDITION")) {
      throw new PreconditionFailed(`Firestore commit precondition failed: ${text.slice(0, 200)}`);
    }
    throw new FirestoreError(`Firestore commit: ${res.status} ${text.slice(0, 300)}`, res.status);
  }

  // Firestore document IDs can't contain "/", or be "." or "..".
  private documentPath(collection: string, id: string): string {
    if (!id || id.includes("/") || id === "." || id === "..") throw new Error(`invalid document ID ${JSON.stringify(id)}`);
    return `${this.collectionPath(collection)}/${encodeURIComponent(id)}`;
  }

  private collectionPath(collection: string): string {
    const segments = splitPath(collection);
    if (segments.length % 2 !== 1) throw new Error(`invalid collection ${JSON.stringify(collection)}`);
    return `${this.documentsPath}/${segments.map(encodeURIComponent).join("/")}`;
  }

  // The resource name batchGet and commit take in their JSON bodies (not URL-encoded):
  // projects/…/documents/users/u_1.
  private fullName(path: string): string {
    const segments = splitPath(path);
    if (segments.length % 2 !== 0) throw new Error(`invalid document path ${JSON.stringify(path)}`);
    return `${this.documentsPath}/${segments.join("/")}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
    attempts = this.attempts,
  ): Promise<Response> {
    let lastError: Error = new Error("no attempts");
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await sleep(200 * 2 ** (attempt - 2) + Math.random() * 100);
      let res: Response;
      try {
        res = await this.fetch(`${this.base}/${path}`, {
          method,
          headers: {
            authorization: `Bearer ${await this.accessToken()}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err as Error;
        continue;
      }
      if (res.ok || okStatuses.includes(res.status)) return res;
      const text = await res.text();
      lastError = new FirestoreError(`Firestore ${method} ${path}: ${res.status} ${text.slice(0, 300)}`, res.status);
      if (!RETRYABLE.has(res.status)) break;
    }
    throw lastError;
  }
}

// The VM service account's token, cached until a minute before it expires.
export function metadataAccessToken(fetchFn: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const res = await fetchFn("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
      headers: { "metadata-flavor": "Google" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`metadata token: ${res.status}`);
    const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
    return access_token;
  };
}

// The gcloud CLI's signed-in account, for tools and local runs against the real database.
// Tokens last an hour; this refreshes after 45 minutes.
export function gcloudAccessToken(): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
    cached = { token, expiresAt: Date.now() + 45 * 60 * 1000 };
    return token;
  };
}

export async function metadataProjectId(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn("http://metadata.google.internal/computeMetadata/v1/project/project-id", {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`metadata project-id: ${res.status}`);
  return (await res.text()).trim();
}

type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { bytesValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export function encodeFields(data: FirestoreData): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(data)) {
    // Like JSON.stringify, leave out undefined fields.
    if (value !== undefined) fields[key] = encodeValue(value);
  }
  return fields;
}

export function encodeValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value instanceof Uint8Array) return { bytesValue: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "object") return { mapValue: { fields: encodeFields(value as FirestoreData) } };
  throw new TypeError(`can't store a ${typeof value} in Firestore`);
}

export function decodeFields(fields: Record<string, FirestoreValue>): FirestoreData {
  const data: FirestoreData = {};
  for (const [key, value] of Object.entries(fields)) data[key] = decodeValue(value);
  return data;
}

export function decodeValue(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return new Date(value.timestampValue);
  if ("bytesValue" in value) return Buffer.from(value.bytesValue, "base64");
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  throw new TypeError(`unsupported Firestore value ${JSON.stringify(value)}`);
}

// "users/u_1/friends" → ["users", "u_1", "friends"], rejecting empty, "." and ".." segments.
export function splitPath(path: string): string[] {
  const segments = path.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) throw new Error(`invalid path ${JSON.stringify(path)}`);
  return segments;
}

function lastSegment(name: string): string {
  return decodeURIComponent(name.slice(name.lastIndexOf("/") + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
