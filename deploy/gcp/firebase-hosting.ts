// overandout.app on Firebase Hosting (design decision 2026-09-27), over the REST API with
// the gcloud CLI's credentials, so no Firebase CLI or login is needed. Run through
// setup-web.sh and deploy-web.sh, which pass the settings as environment variables.
//
//   node deploy/gcp/firebase-hosting.ts setup     adds Firebase to the project, creates the
//                                                 site and the custom domain, and prints the
//                                                 DNS records to add at GoDaddy
//   node deploy/gcp/firebase-hosting.ts dns       prints the domain's DNS and certificate state
//   node deploy/gcp/firebase-hosting.ts deploy    uploads web/public and releases it
//   node deploy/gcp/firebase-hosting.ts redirect  a site with no files that sends every path to
//                                                 REDIRECT_URL (ops.overandout.app → the Ops
//                                                 dashboard): creates the site and its custom
//                                                 domain if needed, releases, prints the DNS records
//
//   PROJECT_ID, REGION   from config.sh
//   SITE                 the Hosting site (default: PROJECT_ID)
//   WEB_DOMAIN           the custom domain (default overandout.app; not DOMAIN, which config.sh
//                        sets to the relay's hostname)
//   REDIRECT_TO          setup only: create WEB_DOMAIN as a redirect to this domain instead, for
//                        example WEB_DOMAIN=www.overandout.app REDIRECT_TO=overandout.app
//   TEAM_ID              the Apple team ID, for apple-app-site-association
//   SUPPORT_EMAIL        shown on the privacy and support pages
//   TESTFLIGHT_URL       optional: the Beta's public TestFlight link, which the invite page
//                        offers instead of "Coming soon to the App Store"
//   REDIRECT_URL         redirect only: the https:// address every path goes to

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const env = process.env;
const project = required("PROJECT_ID");
const region = env.REGION || "us-central1";
const site = env.SITE || project;
const domain = env.WEB_DOMAIN || "overandout.app";
const redirectTo = env.REDIRECT_TO || "";
const publicDir = join(import.meta.dirname, "..", "..", "web", "public");
const hosting = "https://firebasehosting.googleapis.com/v1beta1";

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let token = "";
async function call(method: string, url: string, body?: unknown, okStatuses: number[] = []): Promise<any> {
  token ||= execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "x-goog-user-project": project,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${url}: ${res.status} ${text.slice(0, 500)}`);
  return { status: res.status, ...(text ? JSON.parse(text) : {}) };
}

async function waitForOperation(op: { name?: string; done?: boolean }, base: string): Promise<void> {
  for (let i = 0; op.name && !op.done && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    op = await call("GET", `${base}/${op.name}`);
  }
}

// What the site serves besides its files.
const servingConfig = {
  cleanUrls: true,
  trailingSlashBehavior: "REMOVE",
  headers: [
    // No file extension, so it must be labelled JSON explicitly.
    { glob: "/.well-known/apple-app-site-association", headers: { "Content-Type": "application/json", "Cache-Control": "max-age=3600" } },
    { glob: "**/*.@(html|css)", headers: { "Cache-Control": "max-age=300" } },
  ],
  rewrites: [
    // The account API on Cloud Run (deploy-api.sh; contracts/README.md).
    { glob: "/v2/**", run: { serviceId: "api", region } },
    // Invite links: the app opens them when it's installed; otherwise this page.
    { glob: "/i/**", path: "/invite.html" },
  ],
};

// The invite page's two variants: while TESTFLIGHT_URL is set (the Beta), what's between
// <!-- testflight --> and <!-- /testflight --> is kept, with TESTFLIGHT_URL filled in;
// otherwise what's between <!-- app-store --> and <!-- /app-store -->.
function pageVariant(text: string, testflightUrl: string): string {
  const [keep, drop] = testflightUrl ? ["testflight", "app-store"] : ["app-store", "testflight"];
  return text
    .replace(new RegExp(`[ \\t]*<!-- ${drop} -->[\\s\\S]*?<!-- /${drop} -->\\n?`, "g"), "")
    .replace(new RegExp(`[ \\t]*<!-- /?${keep} -->\\n?`, "g"), "")
    .replaceAll("TESTFLIGHT_URL", testflightUrl);
}

// Files whose placeholders are filled in; everything else (images) is uploaded byte for byte.
const textFile = /\.(html|css|txt|json)$|^apple-app-site-association$/;

function files(): Map<string, Buffer> {
  const teamId = required("TEAM_ID");
  const supportEmail = required("SUPPORT_EMAIL");
  const testflightUrl = env.TESTFLIGHT_URL || "";
  // A public TestFlight link, and nothing that could break out of the page's href.
  if (testflightUrl && !/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/.test(testflightUrl)) {
    throw new Error("TESTFLIGHT_URL must look like https://testflight.apple.com/join/AbCd1234");
  }
  const found = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name !== ".DS_Store") {
        const bytes = readFileSync(path);
        if (!textFile.test(name)) {
          found.set(`/${relative(publicDir, path)}`, bytes);
          continue;
        }
        const text = pageVariant(bytes.toString("utf8"), testflightUrl)
          .replaceAll("TEAM_ID.", `${teamId}.`)
          .replaceAll("SUPPORT_EMAIL", supportEmail);
        found.set(`/${relative(publicDir, path)}`, Buffer.from(text));
      }
    }
  };
  walk(publicDir);
  return found;
}

async function deploy(): Promise<void> {
  const content = files();
  const version = await call("POST", `${hosting}/sites/${site}/versions`, { config: servingConfig });
  const gzipped = new Map<string, { hash: string; bytes: Buffer }>();
  for (const [path, bytes] of content) {
    const gz = gzipSync(bytes, { level: 9 });
    gzipped.set(path, { hash: createHash("sha256").update(gz).digest("hex"), bytes: gz });
  }
  const populate = await call("POST", `${hosting}/${version.name}:populateFiles`, {
    files: Object.fromEntries([...gzipped].map(([path, f]) => [path, f.hash])),
  });
  const needed = new Set<string>(populate.uploadRequiredHashes ?? []);
  for (const [path, f] of gzipped) {
    if (!needed.has(f.hash)) continue;
    const res = await fetch(`${populate.uploadUrl}/${f.hash}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-goog-user-project": project, "content-type": "application/octet-stream" },
      body: f.bytes,
    });
    if (!res.ok) throw new Error(`uploading ${path}: ${res.status} ${await res.text()}`);
  }
  await call("PATCH", `${hosting}/${version.name}?update_mask=status`, { status: "FINALIZED" });
  await call("POST", `${hosting}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`, {});
  console.log(`Released ${content.size} files (${needed.size} uploaded) to https://${site}.web.app and https://${domain}.`);
}

// Releases a version whose only job is a temporary redirect (302, so a changed target isn't
// cached), for a site that serves nothing itself.
async function releaseRedirect(location: string): Promise<void> {
  const version = await call("POST", `${hosting}/sites/${site}/versions`, {
    config: { redirects: [{ glob: "**", statusCode: 302, location }] },
  });
  await call("POST", `${hosting}/${version.name}:populateFiles`, { files: {} });
  await call("PATCH", `${hosting}/${version.name}?update_mask=status`, { status: "FINALIZED" });
  await call("POST", `${hosting}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`, {});
  console.log(`https://${site}.web.app and https://${domain} redirect to ${location}.`);
}

async function redirect(): Promise<void> {
  const location = required("REDIRECT_URL");
  if (!/^https:\/\/[^\s"'<>]+$/.test(location)) throw new Error("REDIRECT_URL must be an https:// address");
  await setup(false);
  await releaseRedirect(location);
  await dns();
}

async function setup(printDns = true): Promise<void> {
  const firebase = "https://firebase.googleapis.com/v1beta1";
  const existing = await call("GET", `${firebase}/projects/${project}`, undefined, [403, 404]);
  if (existing.status !== 200) {
    console.log(`Adding Firebase to ${project}…`);
    await waitForOperation(await call("POST", `${firebase}/projects/${project}:addFirebase`, {}), firebase);
  }
  const siteInfo = await call("GET", `${hosting}/projects/${project}/sites/${site}`, undefined, [404]);
  if (siteInfo.status === 404) {
    console.log(`Creating the Hosting site ${site}…`);
    await call("POST", `${hosting}/projects/${project}/sites?siteId=${site}`, {});
  }
  const custom = await call("GET", `${hosting}/projects/${project}/sites/${site}/customDomains/${domain}`, undefined, [404]);
  if (custom.status === 404) {
    console.log(`Adding the custom domain ${domain}${redirectTo ? `, redirecting to ${redirectTo}` : ""}…`);
    const body = redirectTo ? { redirectTarget: redirectTo } : {};
    await waitForOperation(await call("POST", `${hosting}/projects/${project}/sites/${site}/customDomains?customDomainId=${domain}`, body), hosting);
  }
  if (printDns) await dns();
}

async function dns(): Promise<void> {
  const custom = await call("GET", `${hosting}/projects/${project}/sites/${site}/customDomains/${domain}`);
  console.log(`${domain}: host ${custom.hostState ?? "?"}, ownership ${custom.ownershipState ?? "?"}, certificate ${custom.cert?.state ?? "?"}`);
  const updates = custom.requiredDnsUpdates?.desired ?? [];
  const records = updates.flatMap((u: { records?: Array<{ domainName: string; type: string; rdata: string; requiredAction?: string }> }) => u.records ?? []);
  const changes = records.filter((r: { requiredAction?: string }) => r.requiredAction && r.requiredAction !== "NONE");
  if (!changes.length) {
    console.log("No DNS changes needed.");
    return;
  }
  console.log("DNS changes for GoDaddy:");
  for (const r of changes) console.log(`  ${r.requiredAction}  ${r.type}  ${r.domainName}  ${r.rdata}`);
}

const command = process.argv[2];
if (command === "deploy") await deploy();
else if (command === "setup") await setup();
else if (command === "dns") await dns();
else if (command === "redirect") await redirect();
else {
  console.error("usage: node deploy/gcp/firebase-hosting.ts setup | dns | deploy | redirect");
  process.exit(2);
}
