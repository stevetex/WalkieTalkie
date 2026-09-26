import { test } from "node:test";
import assert from "node:assert/strict";
import { DryRunPusher, ringAlert } from "../src/apns.ts";
import { SimulatorPusher, parseSimulatorToken, type Exec } from "../src/simulator.ts";

const udid = "5DE92663-5226-41E6-9799-2C68705F50F7";
const push = ringAlert({ conversationId: "c1", from: "alice", fromName: "Alice", burstId: "b1", pushSentAt: 1 }, 35_001);

test("simulator tokens name the device and the app", () => {
  assert.deepEqual(parseSimulatorToken(`simulator:${udid}:com.example.app.watchkitapp`), {
    udid,
    bundleId: "com.example.app.watchkitapp",
  });
  // Nothing that could turn into extra command-line arguments.
  assert.equal(parseSimulatorToken(`simulator:${udid}:com.example;rm -rf`), null);
  assert.equal(parseSimulatorToken("simulator:not-a-udid:com.example.app"), null);
});

test("rings to a simulator go through simctl push with the alert payload on stdin", async () => {
  const calls: Array<{ file: string; args: string[]; input: string }> = [];
  const exec: Exec = async (file, args, input) => {
    calls.push({ file, args, input });
    return { code: 0, stderr: "" };
  };
  const next = new DryRunPusher();
  const pusher = new SimulatorPusher(next, exec);

  const result = await pusher.sendAlert(`simulator:${udid}:com.example.app`, "sandbox", push);
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ["simctl", "push", udid, "com.example.app", "-"]);
  assert.equal(calls[0].file, "xcrun");
  assert.deepEqual(JSON.parse(calls[0].input), push.payload);
  assert.equal(next.sent.length, 0);

  // Real device tokens still go to APNs (here the dry run).
  await pusher.sendAlert("abcdef0123456789", "sandbox", push);
  assert.equal(next.sent.length, 1);
  assert.equal(calls.length, 1);
});

test("a failed or malformed simulator push is reported, not sent elsewhere", async () => {
  const next = new DryRunPusher();
  const failing = new SimulatorPusher(next, async () => ({ code: 164, stderr: "Invalid device\n" }));
  const failed = await failing.sendAlert(`simulator:${udid}:com.example.app`, "sandbox", push);
  assert.deepEqual([failed.ok, failed.reason], [false, "Invalid device"]);
  const bad = await failing.sendAlert("simulator:bogus", "sandbox", push);
  assert.deepEqual([bad.ok, bad.status], [false, 400]);
  assert.equal(next.sent.length, 0);
});
