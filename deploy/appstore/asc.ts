// A small App Store Connect API client for internal TestFlight, with the API key in config.sh.
// No dependencies: the key signs an ES256 token with node:crypto.
//
//   node deploy/appstore/asc.ts status
//       The app, its internal groups and testers, and the latest builds.
//
//   node deploy/appstore/asc.ts release <build> [--notes "What to test"]
//       Waits for Apple to finish processing the build (testflight.sh runs this), sets its
//       What to Test notes, and makes sure the internal group (ASC_GROUP) has it.
//
//   node deploy/appstore/asc.ts beta-review <build> [--group "Early Testers"]
//       External TestFlight: adds a processed build to the external group (ASC_EXTERNAL_GROUP,
//       default "Early Testers") and submits it for Beta App Review, after printing what review
//       sees (What to Test, the beta description and feedback email, the review contact). Run
//       again to see the review's state. Apple emails when the review is done; then the group's
//       testers (and its public link) get the build.
//
//   node deploy/appstore/asc.ts withdraw <build> [--group "Early Testers"]
//       Takes a build back from the external group, approved or not (the API can't cancel a
//       Beta App Review submission). Its testers keep the group's other builds.
//
//   node deploy/appstore/asc.ts add-tester <email> [first name] [last name]
//       Adds someone to the internal group. Internal testers must already be users on the
//       App Store Connect team (Users and Access), with any role.
//
//   node deploy/appstore/asc.ts feedback [--days 14]
//       TestFlight screenshot feedback: when, which build, device and OS, the tester, the comment.
//
//   node deploy/appstore/asc.ts crashes [--days 14] [--log <id>]
//       Crashes testers sent from TestFlight (iPhone, watch and extension); --log prints one's
//       crash log.
//
//   node deploy/appstore/asc.ts diagnostics [build]
//       Hang, launch and disk-write signatures Apple collected for a build (default: the newest).
//
//   node deploy/appstore/asc.ts listing
//       The App Store version being prepared and its screenshots, by display type.
//
//   node deploy/appstore/asc.ts screenshots [dir] [--replace]
//       Uploads screenshots/out (or dir) to that version's en-US listing: iphone-*.png as the
//       6.9" iPhone set, watch-*.png as the Series 10–12 watch set, in file-name order.
//       --replace deletes a set's current screenshots first.
//
// These print testers' comments and emails, so they stay on this Mac (the Beta telemetry spec).

import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const BUNDLE_ID = "com.cypressoakstudios.overandout";
const API = "https://api.appstoreconnect.apple.com";

const config = readConfig(join(import.meta.dirname, "config.sh"));
const keyId = required("ASC_KEY_ID");
const issuerId = required("ASC_ISSUER_ID");
const keyPath = config.ASC_KEY_PATH || join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
if (!existsSync(keyPath)) fail(`No API key at ${keyPath}`);
const privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
const groupName = config.ASC_GROUP || "House";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    notes: { type: "string" },
    days: { type: "string" },
    log: { type: "string" },
    replace: { type: "boolean" },
    group: { type: "string" },
  },
});
const [command, ...args] = positionals;

// Tokens last at most 20 minutes; a fresh one per request keeps long waits simple.
function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "ES256", kid: keyId, typ: "JWT" })}.${part({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${signature.toString("base64url")}`;
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    const detail = (json.errors ?? []).map((e: any) => `${e.title}: ${e.detail}`).join("; ");
    throw new Error(`${method} ${path}: HTTP ${res.status} ${detail}`);
  }
  return json;
}

async function appId(): Promise<string> {
  const apps = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = apps.data.find((a: any) => a.attributes.bundleId === BUNDLE_ID);
  if (!app) fail(`No app with bundle ID ${BUNDLE_ID} in App Store Connect`);
  return app.id;
}

// The internal group, created (with access to every build) if it doesn't exist.
async function internalGroup(app: string): Promise<{ id: string; allBuilds: boolean }> {
  const groups = await api("GET", `/v1/apps/${app}/betaGroups?limit=50`);
  const found = groups.data.find((g: any) => g.attributes.name === groupName && g.attributes.isInternalGroup);
  if (found) return { id: found.id, allBuilds: Boolean(found.attributes.hasAccessToAllBuilds) };
  const created = await api("POST", "/v1/betaGroups", {
    data: {
      type: "betaGroups",
      attributes: { name: groupName, isInternalGroup: true, hasAccessToAllBuilds: true },
      relationships: { app: { data: { type: "apps", id: app } } },
    },
  });
  console.log(`Created the internal group "${groupName}", which gets every build.`);
  return { id: created.data.id, allBuilds: true };
}

// The iOS App Store version that can still be edited (the one being prepared, or one Apple
// rejected), and its en-US localization, where the watch's screenshots go too.
async function editableVersion(app: string): Promise<{ version: any; localization: any }> {
  const versions = await api("GET", `/v1/apps/${app}/appStoreVersions?filter[platform]=IOS&limit=20`);
  const editable = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];
  const version = versions.data.find((v: any) => editable.includes(v.attributes.appStoreState));
  if (!version) {
    const states = versions.data.map((v: any) => `${v.attributes.versionString} ${v.attributes.appStoreState}`).join(", ") || "none";
    fail(`No App Store version can be edited (versions: ${states}).`);
  }
  const localizations = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  const localization = localizations.data.find((l: any) => l.attributes.locale === "en-US") ?? localizations.data[0];
  if (!localization) fail(`Version ${version.attributes.versionString} has no localization.`);
  return { version, localization };
}

async function screenshotSets(localization: string): Promise<{ set: any; shots: any[] }[]> {
  const sets = await api("GET", `/v1/appStoreVersionLocalizations/${localization}/appScreenshotSets?include=appScreenshots&limit=50`);
  const shots = new Map<string, any>((sets.included ?? []).map((s: any) => [s.id, s]));
  return sets.data.map((set: any) => ({
    set,
    shots: (set.relationships?.appScreenshots?.data ?? []).map((r: any) => shots.get(r.id)).filter(Boolean),
  }));
}

async function findBuild(app: string, build: string): Promise<any | undefined> {
  const builds = await api("GET", `/v1/builds?filter[app]=${app}&filter[version]=${encodeURIComponent(build)}&limit=1`);
  return builds.data[0];
}

switch (command) {
  case "status": {
    const app = await appId();
    console.log(`App ${BUNDLE_ID} (${app})`);
    const groups = await api("GET", `/v1/apps/${app}/betaGroups?limit=50`);
    for (const g of groups.data) {
      const testers = await api("GET", `/v1/betaGroups/${g.id}/betaTesters?limit=200`);
      const who = testers.data.map((t: any) => t.attributes.email ?? "(no email)").join(", ") || "no testers";
      console.log(`  Group "${g.attributes.name}" (${g.attributes.isInternalGroup ? "internal" : "external"}${g.attributes.hasAccessToAllBuilds ? ", every build" : ""}): ${who}`);
    }
    const builds = await api("GET", `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=5`);
    for (const b of builds.data) {
      console.log(`  Build ${b.attributes.version}: ${b.attributes.processingState}, uploaded ${b.attributes.uploadedDate}${b.attributes.expired ? ", expired" : ""}`);
    }
    if (!builds.data.length) console.log("  No builds yet.");
    break;
  }
  case "release": {
    const build = args[0] ?? fail("usage: release <build> [--notes …]");
    const app = await appId();
    // A new upload takes a few minutes to appear, then processes for 5–15.
    const deadline = Date.now() + 45 * 60_000;
    let found: any;
    for (;;) {
      found = await findBuild(app, build);
      const state = found?.attributes.processingState ?? "not listed yet";
      if (state === "VALID") break;
      if (state === "FAILED" || state === "INVALID") fail(`Build ${build} is ${state}; App Store Connect's email says why.`);
      if (Date.now() > deadline) fail(`Build ${build} still ${state} after 45 minutes; run release ${build} again later.`);
      console.log(`  Build ${build}: ${state}…`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
    console.log(`Build ${build} is processed.`);
    if (values.notes) {
      const existing = await api("GET", `/v1/builds/${found.id}/betaBuildLocalizations`);
      const local = existing.data.find((l: any) => l.attributes.locale === "en-US");
      if (local) {
        await api("PATCH", `/v1/betaBuildLocalizations/${local.id}`, {
          data: { type: "betaBuildLocalizations", id: local.id, attributes: { whatsNew: values.notes } },
        });
      } else {
        await api("POST", "/v1/betaBuildLocalizations", {
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale: "en-US", whatsNew: values.notes },
            relationships: { build: { data: { type: "builds", id: found.id } } },
          },
        });
      }
      console.log("Set its What to Test notes.");
    }
    const group = await internalGroup(app);
    if (!group.allBuilds) {
      await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: found.id }] });
    }
    console.log(`"${groupName}" has build ${build}; testers get it in the TestFlight app.`);
    break;
  }
  case "beta-review": {
    const build = args[0] ?? fail('usage: beta-review <build> [--group "Early Testers"]');
    const name = values.group || config.ASC_EXTERNAL_GROUP || "Early Testers";
    const app = await appId();
    const found = await findBuild(app, build);
    if (!found) fail(`No build ${build} in App Store Connect.`);
    if (found.attributes.processingState !== "VALID") fail(`Build ${build} is ${found.attributes.processingState}, not processed yet.`);
    const groups = await api("GET", `/v1/apps/${app}/betaGroups?limit=50`);
    const group = groups.data.find((g: any) => g.attributes.name === name && !g.attributes.isInternalGroup);
    if (!group) fail(`No external group named "${name}".`);

    // What Beta App Review sees; Apple refuses the submission if a required part is missing.
    const [notes, appLocalizations, reviewDetail] = await Promise.all([
      api("GET", `/v1/builds/${found.id}/betaBuildLocalizations`),
      api("GET", `/v1/apps/${app}/betaAppLocalizations`),
      api("GET", `/v1/apps/${app}/betaAppReviewDetail`),
    ]);
    const whatsNew = notes.data.find((l: any) => l.attributes.locale === "en-US")?.attributes.whatsNew;
    const local = appLocalizations.data.find((l: any) => l.attributes.locale === "en-US") ?? appLocalizations.data[0];
    const review = reviewDetail.data?.attributes ?? {};
    const check = (label: string, ok: unknown) => console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    console.log(`Build ${build} (${found.attributes.version}), external group "${name}":`);
    check("What to Test", whatsNew);
    check("Beta description", local?.attributes.description);
    check("Feedback email", local?.attributes.feedbackEmail);
    check("Privacy policy URL", local?.attributes.privacyPolicyUrl);
    check("Review contact", review.contactEmail && review.contactPhone);
    check("Review notes", review.notes);
    check(`Encryption answered (${found.attributes.usesNonExemptEncryption === false ? "exempt" : found.attributes.usesNonExemptEncryption ?? "not set"})`, found.attributes.usesNonExemptEncryption !== null && found.attributes.usesNonExemptEncryption !== undefined);

    // A build uploaded with testFlightInternalTestingOnly can never go to an external group.
    const detail = (await api("GET", `/v1/builds/${found.id}/buildBetaDetail`)).data.attributes;
    console.log(`  TestFlight states: internal ${detail.internalBuildState}, external ${detail.externalBuildState}`);

    const existing = await api("GET", `/v1/builds/${found.id}/betaAppReviewSubmission`).catch(() => null);
    if (existing?.data) {
      console.log(`Already submitted: Beta App Review state ${existing.data.attributes.betaReviewState}.`);
      break;
    }
    await api("POST", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: found.id }] });
    console.log(`Added build ${build} to "${name}".`);
    const submission = await api("POST", "/v1/betaAppReviewSubmissions", {
      data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: found.id } } } },
    });
    console.log(`Submitted for Beta App Review: ${submission.data.attributes.betaReviewState}. Apple emails when it's reviewed (often within a day).`);
    break;
  }
  case "withdraw": {
    const build = args[0] ?? fail('usage: withdraw <build> [--group "Early Testers"]');
    const name = values.group || config.ASC_EXTERNAL_GROUP || "Early Testers";
    const app = await appId();
    const found = await findBuild(app, build);
    if (!found) fail(`No build ${build} in App Store Connect.`);
    const groups = await api("GET", `/v1/apps/${app}/betaGroups?limit=50`);
    const group = groups.data.find((g: any) => g.attributes.name === name && !g.attributes.isInternalGroup);
    if (!group) fail(`No external group named "${name}".`);
    await api("DELETE", `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: found.id }] });
    const left = await api("GET", `/v1/betaGroups/${group.id}/builds?limit=20`);
    const versions = left.data.map((b: any) => b.attributes.version).join(", ") || "none";
    console.log(`Took build ${build} back from "${name}"; it now has builds: ${versions}.`);
    break;
  }
  case "add-tester": {
    const email = args[0] ?? fail("usage: add-tester <email> [first name] [last name]");
    const group = await internalGroup(await appId());
    await api("POST", "/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: { email, firstName: args[1] ?? null, lastName: args[2] ?? null },
        relationships: { betaGroups: { data: [{ type: "betaGroups", id: group.id }] } },
      },
    });
    console.log(`Added ${email} to "${groupName}".`);
    break;
  }
  case "feedback":
  case "crashes": {
    const app = await appId();
    if (command === "crashes" && values.log) {
      const log = await api("GET", `/v1/betaFeedbackCrashSubmissions/${values.log}/crashLog`);
      console.log(log.data?.attributes?.logText ?? "No crash log.");
      break;
    }
    const since = Date.now() - Number(values.days ?? 14) * 86_400_000;
    const kind = command === "feedback" ? "betaFeedbackScreenshotSubmissions" : "betaFeedbackCrashSubmissions";
    const items = await api("GET", `/v1/apps/${app}/${kind}?sort=-createdDate&limit=100&include=build,tester`);
    const included = new Map<string, any>((items.included ?? []).map((i: any) => [`${i.type}/${i.id}`, i]));
    const rows = items.data.filter((f: any) => Date.parse(f.attributes.createdDate) >= since);
    if (!rows.length) console.log(`No TestFlight ${command === "feedback" ? "feedback" : "crashes"} in the last ${values.days ?? 14} days.`);
    for (const f of rows) {
      const a = f.attributes;
      const build = included.get(`builds/${f.relationships?.build?.data?.id}`)?.attributes?.version ?? "?";
      const tester = included.get(`betaTesters/${f.relationships?.tester?.data?.id}`)?.attributes;
      const who = tester ? [tester.firstName, tester.lastName].filter(Boolean).join(" ") || tester.email : a.email ?? "?";
      const watch = a.pairedAppleWatch ? `, watch ${a.pairedAppleWatch}` : "";
      console.log(`${a.createdDate.slice(0, 16).replace("T", " ")}  build ${build}  ${a.deviceModel ?? "?"} iOS ${a.osVersion ?? "?"}${watch}  ${who}  (${f.id})`);
      if (a.comment) console.log(`    "${a.comment}"`);
    }
    break;
  }
  case "diagnostics": {
    const app = await appId();
    const build = args[0]
      ? await findBuild(app, args[0])
      : (await api("GET", `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=1`)).data[0];
    if (!build) fail(`No build ${args[0] ?? ""}`);
    // A build Apple has no diagnostics for yet answers 404.
    const signatures = await api("GET", `/v1/builds/${build.id}/diagnosticSignatures?limit=50`)
      .catch((err: Error) => (err.message.includes("HTTP 404") ? { data: [] } : Promise.reject(err)));
    if (!signatures.data.length) console.log(`No diagnostics for build ${build.attributes.version} yet (Apple needs enough devices and days).`);
    for (const s of signatures.data) {
      const a = s.attributes;
      console.log(`${a.diagnosticType}  weight ${Number(a.weight ?? 0).toFixed(1)}%  ${a.signature}  (${s.id})`);
    }
    break;
  }
  case "listing": {
    const { version, localization } = await editableVersion(await appId());
    console.log(`Version ${version.attributes.versionString} (${version.attributes.appStoreState}), ${localization.attributes.locale}`);
    const sets = await screenshotSets(localization.id);
    if (!sets.length) console.log("  No screenshots yet.");
    for (const { set, shots } of sets) {
      console.log(`  ${set.attributes.screenshotDisplayType}: ${shots.length} screenshot${shots.length === 1 ? "" : "s"}`);
      for (const s of shots) console.log(`    ${s.attributes.fileName} ${s.attributes.assetDeliveryState?.state ?? ""}`);
    }
    break;
  }
  case "screenshots": {
    // Each display type takes the out/ files with its prefix, in file-name order.
    const dir = args[0] ?? join(import.meta.dirname, "screenshots", "out");
    const kinds = [
      { displayType: "APP_IPHONE_67", prefix: "iphone-" }, // the 6.9" display (1320 × 2868)
      { displayType: "APP_WATCH_SERIES_10", prefix: "watch-" }, // Series 10–12 (416 × 496)
    ];
    const { version, localization } = await editableVersion(await appId());
    console.log(`Version ${version.attributes.versionString}, ${localization.attributes.locale}`);
    const existing = await screenshotSets(localization.id);
    for (const { displayType, prefix } of kinds) {
      const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".png")).sort();
      if (!files.length) continue;
      let found = existing.find((e) => e.set.attributes.screenshotDisplayType === displayType);
      if (found?.shots.length && !values.replace) {
        fail(`${displayType} already has ${found.shots.length} screenshots; run with --replace to delete them first.`);
      }
      for (const old of found?.shots ?? []) await api("DELETE", `/v1/appScreenshots/${old.id}`);
      const setId = found?.set.id ?? (await api("POST", "/v1/appScreenshotSets", {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localization.id } } },
        },
      })).data.id;
      const ids: string[] = [];
      for (const file of files) {
        const bytes = readFileSync(join(dir, file));
        // Reserve, upload the parts App Store Connect asks for, then commit with the checksum.
        const reserved = await api("POST", "/v1/appScreenshots", {
          data: {
            type: "appScreenshots",
            attributes: { fileName: file, fileSize: bytes.length },
            relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } },
          },
        });
        for (const op of reserved.data.attributes.uploadOperations) {
          const headers = Object.fromEntries((op.requestHeaders ?? []).map((h: any) => [h.name, h.value]));
          const res = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
          if (!res.ok) fail(`Uploading ${file}: HTTP ${res.status}`);
        }
        await api("PATCH", `/v1/appScreenshots/${reserved.data.id}`, {
          data: {
            type: "appScreenshots",
            id: reserved.data.id,
            attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") },
          },
        });
        ids.push(reserved.data.id);
        console.log(`  ${displayType}: uploaded ${file}`);
      }
      await api("PATCH", `/v1/appScreenshotSets/${setId}/relationships/appScreenshots`, {
        data: ids.map((id) => ({ type: "appScreenshots", id })),
      });
      // Apple checks each image (size, format) after the upload.
      for (const id of ids) {
        for (let tries = 0; ; tries++) {
          const shot = await api("GET", `/v1/appScreenshots/${id}`);
          const state = shot.data.attributes.assetDeliveryState;
          if (state?.state === "COMPLETE") break;
          if (state?.state === "FAILED") fail(`${shot.data.attributes.fileName}: ${(state.errors ?? []).map((e: any) => e.description ?? e.code).join("; ")}`);
          if (tries > 40) fail(`${shot.data.attributes.fileName} still ${state?.state} after 2 minutes; check App Store Connect.`);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
      console.log(`${displayType}: ${ids.length} screenshots, processed.`);
    }
    break;
  }
  default:
    fail("usage: node deploy/appstore/asc.ts status | release <build> [--notes …] | add-tester <email> [first] [last] | feedback [--days N] | crashes [--days N] [--log <id>] | diagnostics [build] | listing | screenshots [dir] [--replace]");
}

// config.sh's KEY="value" lines.
function readConfig(path: string): Record<string, string> {
  if (!existsSync(path)) fail(`Copy deploy/appstore/config.example.sh to ${path} and fill it in.`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)="?([^"#]*)"?\s*(#.*)?$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function required(name: string): string {
  return config[name] || fail(`Set ${name} in deploy/appstore/config.sh`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
