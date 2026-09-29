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
// These print testers' comments and emails, so they stay on this Mac (the Beta telemetry spec).

import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
  options: { notes: { type: "string" }, days: { type: "string" }, log: { type: "string" } },
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
  default:
    fail("usage: node deploy/appstore/asc.ts status | release <build> [--notes …] | add-tester <email> [first] [last] | feedback [--days N] | crashes [--days N] [--log <id>] | diagnostics [build]");
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
