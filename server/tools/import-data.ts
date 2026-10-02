// Copies a JSON-store data directory's metrics.jsonl into Firestore.
// Used once, to move the hand-built VM's data to option E's Firestore database.
//
//   node tools/import-data.ts <data dir> [--project walkie-talkie-relay]
//
// Authenticates as the gcloud CLI's signed-in account. With FIRESTORE_EMULATOR_HOST set,
// it writes to the emulator instead. Imported timelines don't expire: they're the
// prototype's measurements.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Firestore, gcloudAccessToken } from "../src/firestore.ts";
import type { TimelineEntry } from "../src/store.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { project: { type: "string", default: "walkie-talkie-relay" } },
});
const dir = positionals[0];
if (!dir) {
  console.error("usage: node tools/import-data.ts <data dir> [--project ID]");
  process.exit(2);
}

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || undefined;
const db = new Firestore({
  projectId: values.project!,
  emulatorHost,
  accessToken: gcloudAccessToken(),
});

const metricsFile = join(dir, "metrics.jsonl");
if (existsSync(metricsFile)) {
  // One document per conversation and writer, as FirestoreMetricsStore writes them.
  const groups = new Map<string, { conversationId: string; entry: TimelineEntry }[]>();
  for (const line of readFileSync(metricsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { conversationId: string; entry: TimelineEntry };
    const key = `${row.conversationId}|${row.entry.source}|${row.entry.userId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const rows of groups.values()) {
    const { conversationId, entry } = rows[0];
    const entries = rows.map((r) => r.entry);
    await db.add("timelines", {
      conversationId,
      source: entry.source,
      writer: entry.source === "server" ? "walkie-relay" : (entry.userId ?? "unknown"),
      startedAt: Math.min(...entries.map((e) => e.t)),
      entries,
      createdAt: new Date(Math.max(...entries.map((e) => e.t))),
    });
  }
  console.log(`${groups.size} timeline documents from ${metricsFile}`);
}
