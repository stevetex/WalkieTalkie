// The Phase 0 cutover's data (ANDROID_WEAR_OS_PLAN.md, section 7; deploy/gcp/PHASE0_ROLLOUT.md
// is the runbook; src/migration.ts says what each pass writes). Rehearse on a copy first:
// snapshot, restore into a local store or the emulator, plan, apply, verify, cleanup.
//
//   node tools/migrate-v2.ts plan       <target>          what apply would change (writes nothing)
//   node tools/migrate-v2.ts apply      <target> [--batch 50] [--checkpoint <file>]
//                                                         the additive pass: before the v2 deploy,
//                                                         and again after it
//   node tools/migrate-v2.ts verify     <target>          what isn't v2 yet, anything inconsistent,
//                                                         and the v1 data cleanup would remove
//   node tools/migrate-v2.ts cleanup    <target> [--apply]
//                                                         after the v2 deploy: removes the v1 fields,
//                                                         appleSubs and v1 pointers (refuses unless
//                                                         verify finds no problems)
//   node tools/migrate-v2.ts snapshot   <target> --out <file>
//                                                         every account document, as Firestore's typed
//                                                         JSON, to a file outside the repository (mode 600)
//   node tools/migrate-v2.ts restore    <target> --from <file> [--exact]
//                                                         writes the snapshot's documents back;
//                                                         --exact also deletes account documents
//                                                         the snapshot doesn't have (the cutover's
//                                                         rollback: everything since is lost)
//   node tools/migrate-v2.ts retire-watch-sessions <target> --before <ISO date> [--apply]
//                                                         once the testers' iPhones are updated:
//                                                         watch sessions no phone made end (the
//                                                         watch asks its iPhone again)
//
// Targets:
//   --local <DATA_DIR>                     a local relay's accounts (DATA_DIR/accounts.json)
//   --emulator <host:port>                 the Firestore emulator (project demo-overandout)
//   --firestore --project <id>             the real database, with gcloud's credentials. apply,
//                                          cleanup, restore and retire need --production too; ask
//                                          first.
//
// A checkpoint file names the last user migrated; apply resumes after it. The run stops, writing
// nothing more, on ambiguous ownership (an identity or Apple mapping naming another account).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MemoryDocs, type Docs } from "../src/docs.ts";
import { Firestore, decodeFields, encodeFields, gcloudAccessToken, type FirestoreData } from "../src/firestore.ts";
import { MigrationStopped, cleanupV1, migrateToV2, retireLegacyWatchSessions, verifyV2, type CleanupCounts, type MigrationCounts } from "../src/migration.ts";

const USER_COLLECTIONS = ["friends", "blocks", "devices", "sessions"];
const TOP_COLLECTIONS = ["users", "identities", "appleSubs", "pushTokens", "invites", "reports", "photos"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function target(): { docs: Docs; description: string; production: boolean } {
  const local = arg("--local");
  if (local) return { docs: new MemoryDocs(join(resolve(local), "accounts.json")), description: `local ${local}`, production: false };
  const emulator = arg("--emulator");
  if (emulator) return { docs: new Firestore({ projectId: arg("--project") ?? "demo-overandout", emulatorHost: emulator }), description: `emulator ${emulator}`, production: false };
  if (flag("--firestore")) {
    const projectId = arg("--project");
    if (!projectId) throw new Error("--firestore needs --project");
    return { docs: new Firestore({ projectId, accessToken: gcloudAccessToken() }), description: `Firestore project ${projectId}`, production: true };
  }
  throw new Error("name a target: --local <DATA_DIR>, --emulator <host:port> or --firestore --project <id>");
}

function print(counts: MigrationCounts | CleanupCounts | Record<string, number>): void {
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)} ${v}`);
}

// Every account document: the top-level collections and each user's subcollections.
async function readAll(docs: Docs): Promise<Record<string, FirestoreData>> {
  const all: Record<string, FirestoreData> = {};
  for (const collection of TOP_COLLECTIONS) {
    for (const doc of await docs.list(collection)) all[`${collection}/${doc.id}`] = doc.data;
  }
  for (const path of Object.keys(all).filter((p) => p.startsWith("users/"))) {
    for (const sub of USER_COLLECTIONS) {
      for (const doc of await docs.list(`${path}/${sub}`)) all[`${path}/${sub}/${doc.id}`] = doc.data;
    }
  }
  return all;
}

// Snapshots hold tokens and identities: never inside the repository.
function outsideRepository(file: string): string {
  const path = resolve(file);
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  for (let d = realpathSync(dir); d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, ".git"))) throw new Error(`${file} is inside a git repository; keep snapshots out of Git`);
  }
  return path;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const { docs, description, production } = target();
  const writes = ["apply", "restore"].includes(command) || (["cleanup", "retire-watch-sessions"].includes(command) && flag("--apply"));
  if (production && writes && !flag("--production")) throw new Error(`${command} on ${description} needs --production (and Steve's OK)`);
  console.log(`${command} on ${description}`);
  switch (command) {
    case "plan":
    case "apply": {
      const checkpoint = arg("--checkpoint");
      const after = checkpoint && existsSync(checkpoint) ? (JSON.parse(readFileSync(checkpoint, "utf8")) as { lastUserId: string }).lastUserId : undefined;
      if (after) console.log(`  resuming after ${after}`);
      try {
        const counts = await migrateToV2(docs, {
          dryRun: command === "plan",
          batchSize: Number(arg("--batch") ?? 50),
          after,
          log: (line) => console.log(line),
          onCheckpoint: (lastUserId, counts) => {
            if (checkpoint && command === "apply") writeFileSync(checkpoint, JSON.stringify({ lastUserId, counts, at: new Date().toISOString() }, null, 2));
          },
        });
        console.log(command === "plan" ? "Would change:" : "Changed:");
        print(counts);
      } catch (err) {
        if (err instanceof MigrationStopped) {
          console.error(`Stopped, nothing more written. Resolve these by hand, then run again:`);
          for (const p of err.problems) console.error(`  ${p.userId}: ${p.what}`);
          process.exitCode = 2;
          return;
        }
        throw err;
      }
      break;
    }
    case "verify": {
      const { counts, problems } = await verifyV2(docs);
      print(counts);
      if (problems.length) {
        console.log(`${problems.length} problems:`);
        for (const p of problems) console.log(`  ${p.userId}: ${p.what}`);
        process.exitCode = 1;
      } else {
        console.log(counts.v1Records || counts.appleSubs || counts.v1Pointers ? "All v2; the v1 data is still there (cleanup removes it)." : "All v2, and no v1 data left.");
      }
      break;
    }
    case "cleanup": {
      try {
        const counts = await cleanupV1(docs, !flag("--apply"), (line) => console.log(line));
        console.log(flag("--apply") ? "Removed v1 data from:" : "Would remove v1 data from (add --apply):");
        print(counts);
      } catch (err) {
        if (err instanceof MigrationStopped) {
          console.error("Not everything is v2 yet, so nothing was removed. Run apply, then verify:");
          for (const p of err.problems) console.error(`  ${p.userId}: ${p.what}`);
          process.exitCode = 2;
          return;
        }
        throw err;
      }
      break;
    }
    case "snapshot": {
      const out = arg("--out");
      if (!out) throw new Error("snapshot needs --out <file>");
      const path = outsideRepository(out);
      const all = await readAll(docs);
      const encoded = Object.fromEntries(Object.entries(all).map(([p, d]) => [p, encodeFields(d)]));
      writeFileSync(path, JSON.stringify({ takenAt: new Date().toISOString(), source: description, documents: encoded }), { mode: 0o600 });
      console.log(`  ${Object.keys(all).length} documents to ${path}`);
      break;
    }
    case "restore": {
      const from = arg("--from");
      if (!from) throw new Error("restore needs --from <file>");
      const { documents } = JSON.parse(readFileSync(from, "utf8")) as { documents: Record<string, Parameters<typeof decodeFields>[0]> };
      const entries = Object.entries(documents);
      // --exact: the account documents written since the snapshot go too, so the data is
      // exactly what the server the snapshot was taken under wrote.
      const extra = flag("--exact") ? Object.keys(await readAll(docs)).filter((path) => !(path in documents)) : [];
      for (let i = 0; i < extra.length; i += 400) await docs.commit(extra.slice(i, i + 400).map((path) => ({ delete: path })));
      for (let i = 0; i < entries.length; i += 400) {
        await docs.commit(entries.slice(i, i + 400).map(([path, fields]) => ({ set: path, data: decodeFields(fields) })));
      }
      console.log(`  ${entries.length} documents restored${flag("--exact") ? `, ${extra.length} written since deleted` : ""}`);
      break;
    }
    case "retire-watch-sessions": {
      const before = Date.parse(arg("--before") ?? "");
      if (!Number.isFinite(before)) throw new Error("retire-watch-sessions needs --before <ISO date>");
      const retired = await retireLegacyWatchSessions(docs, before, !flag("--apply"), (line) => console.log(line));
      console.log(`  ${retired} watch sessions ${flag("--apply") ? "retired" : "would be retired (add --apply)"}`);
      break;
    }
    default:
      throw new Error("commands: plan, apply, verify, cleanup, snapshot, restore, retire-watch-sessions");
  }
}

await main();
