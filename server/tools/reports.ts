// Reviewing reports (backlog: "A way to review reports"). Straight to Firestore with your gcloud
// credentials, like test-account.ts; reports also email an alert when they're filed.
//
//   node tools/reports.ts list [--all]
//       Open reports (or all of them), newest first.
//
//   node tools/reports.ts show <reportId>
//       One report, with both people's names and whether they're still friends.
//
//   node tools/reports.ts resolve <reportId> [--note "what was done"]
//       Marks it resolved, with an optional note.
//
//   node tools/reports.ts delete-account <userId> --yes
//       Deletes the account as the app's Delete Account does (friends, devices, sessions,
//       photo, invites), except that Apple's token isn't revoked: that needs the person's own
//       fresh sign-in. The same Apple ID can sign up again as a new account.
//
// GCP_PROJECT is the Google Cloud project (default walkie-talkie-relay). OAO_ACCOUNTS_FILE=<path>
// uses a local relay's accounts.json instead (DATA_DIR/accounts.json with SERVE_API=1).

import { parseArgs } from "node:util";
import { Accounts } from "../src/accounts.ts";
import { MemoryDocs, type Docs } from "../src/docs.ts";
import { Firestore, gcloudAccessToken } from "../src/firestore.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { all: { type: "boolean" }, note: { type: "string" }, yes: { type: "boolean" } },
});
const [command, id] = positionals;

const file = process.env.OAO_ACCOUNTS_FILE;
const docs: Docs = file
  ? new MemoryDocs(file)
  : new Firestore({ projectId: process.env.GCP_PROJECT ?? "walkie-talkie-relay", accessToken: gcloudAccessToken() });
const accounts = new Accounts(docs);

async function name(userId: unknown): Promise<string> {
  if (typeof userId !== "string") return "?";
  const user = await accounts.user(userId).catch(() => undefined);
  return user ? `${user.name} (${userId})` : `${userId}, deleted`;
}

function date(value: unknown): string {
  const ms = value instanceof Date ? value.getTime() : Number(value ?? 0);
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

switch (command) {
  case "list": {
    const rows = values.all
      ? await docs.list("reports")
      : await docs.query("reports", { where: { field: "status", op: "EQUAL", value: "open" } });
    rows.sort((a, b) => date(b.data.createdAt).localeCompare(date(a.data.createdAt)));
    if (!rows.length) console.log(values.all ? "No reports." : "No open reports.");
    for (const r of rows) {
      console.log(`${r.id}  ${date(r.data.createdAt)}  ${r.data.status}  ${r.data.reason}: ${await name(r.data.reporter)} reported ${await name(r.data.reported)}`);
    }
    break;
  }
  case "show": {
    const [report] = await docs.getAll([`reports/${requireArg(id, "reportId")}`]);
    if (!report) fail(`no report ${id}`);
    const [friendship] = await docs.getAll([`users/${report.reporter}/friends/${report.reported}`]);
    console.log(`Report ${id}, ${date(report.createdAt)}, ${report.status}`);
    console.log(`  Reporter: ${await name(report.reporter)}`);
    console.log(`  Reported: ${await name(report.reported)}`);
    console.log(`  Reason: ${report.reason}${report.note ? `\n  Note: ${report.note}` : ""}`);
    if (report.conversationId) console.log(`  Conversation: ${report.conversationId}`);
    console.log(`  Still friends: ${friendship ? "yes" : "no (blocked, removed or deleted)"}`);
    if (report.resolution) console.log(`  Resolution: ${report.resolution}`);
    break;
  }
  case "resolve": {
    const reportId = requireArg(id, "reportId");
    const data = { status: "resolved", resolvedAt: new Date(), resolution: values.note ?? null };
    await docs.commit([{ set: `reports/${reportId}`, data, fields: Object.keys(data), exists: true }]);
    console.log(`Resolved ${reportId}.`);
    break;
  }
  case "delete-account": {
    const userId = requireArg(id, "userId");
    const who = await name(userId);
    if (!values.yes) fail(`This deletes ${who} for good. Run again with --yes to go ahead.`);
    await accounts.deleteAccount(userId);
    console.log(`Deleted ${who}. Their reports stay, with IDs only.`);
    break;
  }
  default:
    fail("usage: node tools/reports.ts list [--all] | show <reportId> | resolve <reportId> [--note …] | delete-account <userId> --yes");
}

function requireArg(value: string | undefined, what: string): string {
  if (!value) fail(`${what} is required`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
