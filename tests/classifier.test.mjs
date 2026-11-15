import test from "node:test";
import assert from "node:assert/strict";
import { buildDraftPlan, classifyFavorite } from "../src/classifier.mjs";

test("classifies AI workflow content", () => {
  const result = classifyFavorite({ title: "Codex Skill 自动化工作流实战", author: "测试" });
  assert.equal(result.folder, "AI与效率工具");
  assert.ok(result.confidence >= 0.58);
});

test("routes empty-title content to review instead of forcing a category", () => {
  const result = classifyFavorite({ title: "   ", author: "测试" });
  assert.equal(result.folder, "待确认");
  assert.ok(result.confidence < 0.58);
});

test("falls back to the broad life-wisdom category for unclassified content", () => {
  const result = classifyFavorite({ title: "今天聊一件事", author: "测试" });
  assert.equal(result.folder, "人生感悟与认知");
});

test("draft assigns every source video exactly once", () => {
  const source = {
    source_sha256: "abc",
    favorites: [
      { aweme_id: "1", title: "GitHub 开源项目", author: "a" },
      { aweme_id: "2", title: "短视频剪辑教程", author: "b" },
    ],
  };
  const plan = buildDraftPlan(source);
  assert.equal(plan.assignments.length, 2);
  assert.equal(new Set(plan.assignments.map(item => item.aweme_id)).size, 2);
});
