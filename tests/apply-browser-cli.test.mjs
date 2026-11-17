import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("apply-all keeps the existing execution-token gate", () => {
  const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-apply-all-cli-"));
  fs.writeFileSync(path.join(runDirectory, "apply-manifest.json"), `${JSON.stringify({
    plan_fingerprint: "1234567890abcdef",
    create_folders: [],
    add_to_folders: [],
  })}\n`, "utf8");

  const result = spawnSync(process.execPath, [
    path.resolve("scripts/apply-browser.mjs"),
    "apply-all",
    "--run",
    runDirectory,
  ], { cwd: path.resolve("."), encoding: "utf8" });

  assert.deepEqual({ status: result.status, message: result.stderr.includes("EXECUTE:1234567890ab") }, {
    status: 1,
    message: true,
  });
});
