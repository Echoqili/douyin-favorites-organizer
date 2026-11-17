import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendJournal } from "../src/journal.mjs";

test("journals only non-sensitive batch evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-organizer-"));
  const result = appendJournal(directory, {
    folder: "AI视频工作流",
    ids: ["1", "2"],
    status: "verified",
    verifiedCount: 2,
    baselineCount: 15,
    finalCount: 17,
    evidence: "visible success toast",
  });
  assert.equal(result.record.verified_count, 2);
  assert.equal(result.record.baseline_count, 15);
  assert.equal(result.record.final_count, 17);
  assert.equal(fs.readFileSync(result.file, "utf8").trim().length > 0, true);
});

test("accepts deferred work that must remain retryable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-organizer-"));
  const result = appendJournal(directory, {
    folder: "待处理",
    ids: ["3"],
    status: "deferred",
    evidence: "not found during the bounded browser scan",
  });
  assert.equal(result.record.status, "deferred");
  assert.equal(result.record.verified_count, 0);
});

test("rejects sensitive evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-organizer-"));
  assert.throws(() => appendJournal(directory, {
    folder: "x",
    ids: ["1"],
    status: "failed",
    evidence: "Cookie=secret-value",
  }), /sensitive/u);
});
