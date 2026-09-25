import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../src/store.ts";

test("devices saved with a voipToken load with it as their pushToken", () => {
  const dir = mkdtempSync(join(tmpdir(), "devices-"));
  writeFileSync(
    join(dir, "devices.json"),
    JSON.stringify([{ userId: "watch-abee", name: "Watch", voipToken: "poll:watch-abee", apnsEnvironment: "sandbox", updatedAt: 1 }]),
  );
  const device = new DeviceStore(dir).get("watch-abee");
  assert.equal(device?.pushToken, "poll:watch-abee");
  assert.equal("voipToken" in (device ?? {}), false);
});
