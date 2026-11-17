import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitIncrementalRun, prepareIncrementalRun } from "../src/incremental.mjs";
import { writeJson } from "../src/io.mjs";

function favorite(id, title) {
  return { aweme_id: id, title, author: "作者", duration: 10, source_url: `https://www.douyin.com/video/${id}` };
}

test("prepares only favorites not seen in historical runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-incremental-"));
  const runs = path.join(root, "runs");
  const prior = path.join(runs, "prior");
  const current = path.join(runs, "current");
  writeJson(path.join(prior, "favorites.json"), { captured_at: "2026-07-31T00:00:00Z", favorites: [favorite("1", "旧收藏")] });
  writeJson(path.join(prior, "classification-plan.json"), {
    folders: [{ name: "AI工具与自动化", description: "AI", visibility: "public" }],
    existing_folders: [],
    assignments: [{ aweme_id: "1", folder: "AI工具与自动化" }],
  });
  writeJson(path.join(current, "favorites.json"), {
    captured_at: "2026-08-03T00:00:00Z",
    source: "test",
    count: 2,
    coverage_warning: false,
    favorites: [favorite("1", "旧收藏"), favorite("2", "全新主题")],
  });
  const result = prepareIncrementalRun(current);
  assert.equal(result.summary.new_count, 1);
  assert.deepEqual(result.summary.new_aweme_ids, ["2"]);
  assert.deepEqual(result.summary.existing_folders, ["AI工具与自动化"]);
});

test("commits only completed incremental assignments", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-incremental-"));
  const run = path.join(root, "runs", "current");
  writeJson(path.join(run, "favorites.json"), {
    captured_at: "2026-08-03T00:00:00Z",
    source: "test",
    count: 1,
    coverage_warning: false,
    favorites: [favorite("2", "全新主题")],
  });
  const prepared = prepareIncrementalRun(run);
  writeJson(path.join(run, "classification-plan.json"), {
    folders: [{ name: "新主题", description: "稳定新主题", visibility: "public" }],
    existing_folders: [],
    assignments: [{ aweme_id: "2", folder: "新主题", confidence: 0.9 }],
  });
  assert.throws(() => commitIncrementalRun(run), /incomplete aweme_id/u);
  fs.writeFileSync(path.join(run, "apply-journal.jsonl"), `${JSON.stringify({ status: "verified", aweme_ids: ["2"] })}\n`, "utf8");
  const result = commitIncrementalRun(run);
  assert.equal(result.committed, 1);
  assert.equal(result.state.videos["2"].folder, "新主题");
  assert.equal(result.state.folders[0].visibility, "public");
  assert.equal(result.stateFile, prepared.stateFile);
});


test("partially commits verified items while deferred items remain new on the next run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-incremental-"));
  const run = path.join(root, "runs", "current");
  const nextRun = path.join(root, "runs", "next");
  const stateFile = path.join(root, "state.json");
  writeJson(path.join(run, "favorites.json"), {
    captured_at: "2026-09-21T00:00:00Z",
    source: "test",
    count: 2,
    coverage_warning: false,
    favorites: [favorite("10", "成功"), favorite("11", "稍后重试")],
  });
  prepareIncrementalRun(run, { stateFile });
  writeJson(path.join(run, "classification-plan.json"), {
    folders: [],
    existing_folders: ["AI工具"],
    assignments: [
      { aweme_id: "10", folder: "AI工具", confidence: 0.9 },
      { aweme_id: "11", folder: "AI工具", confidence: 0.9 },
    ],
  });
  fs.writeFileSync(path.join(run, "apply-journal.jsonl"), [
    JSON.stringify({ status: "verified", aweme_ids: ["10"] }),
    JSON.stringify({ status: "deferred", aweme_ids: ["11"] }),
    "",
  ].join("\n"), "utf8");

  const committed = commitIncrementalRun(run, { stateFile });
  assert.equal(committed.committed, 1);
  assert.deepEqual(committed.deferred, ["11"]);
  assert.equal(Boolean(committed.state.videos["10"]), true);
  assert.equal(Boolean(committed.state.videos["11"]), false);

  writeJson(path.join(nextRun, "favorites.json"), {
    captured_at: "2026-09-21T01:00:00Z",
    source: "test",
    count: 2,
    coverage_warning: false,
    favorites: [favorite("10", "成功"), favorite("11", "稍后重试")],
  });
  const prepared = prepareIncrementalRun(nextRun, { stateFile });
  assert.deepEqual(prepared.summary.new_aweme_ids, ["11"]);
});

test("unknown submit still blocks every state commit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-incremental-"));
  const run = path.join(root, "runs", "current");
  writeJson(path.join(run, "favorites.json"), {
    captured_at: "2026-09-21T00:00:00Z",
    source: "test",
    count: 1,
    coverage_warning: false,
    favorites: [favorite("20", "未知结果")],
  });
  prepareIncrementalRun(run);
  writeJson(path.join(run, "classification-plan.json"), {
    folders: [], existing_folders: ["AI工具"], assignments: [{ aweme_id: "20", folder: "AI工具" }],
  });
  fs.writeFileSync(path.join(run, "apply-journal.jsonl"), JSON.stringify({ status: "unknown", aweme_ids: ["20"] }) + "\n", "utf8");
  assert.throws(() => commitIncrementalRun(run), /unknown submit.*20/iu);
});
