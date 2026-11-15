// 一键只读检查：采集 → 增量 → 分类初稿 → 校验 → 预览。
// 全程不修改抖音账号，只生成本地运行目录与预览文件。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { collectFavorites } from "../src/collector.mjs";
import { prepareIncrementalRun } from "../src/incremental.mjs";
import { writeDraftPlan } from "../src/classifier.mjs";
import { validatePlan, approvalToken } from "../src/plan.mjs";
import { readJson } from "../src/io.mjs";
import { renderPreview } from "../src/preview.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(values) {
  const args = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { args._.push(value); continue; }
    const key = value.slice(2).replaceAll("-", "_");
    const next = values[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
}

function log(step, message) {
  process.stdout.write(`${step}  ${message}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = args.limit ? Number(args.limit) : 12000;
  const folderVisibility = args.folder_visibility || "private";

  log("[1/5]", `采集抖音收藏（上限 ${limit}）…`);
  const collected = await collectFavorites({ limit });
  const run = collected.directory;
  log("      ", `已采集 ${collected.source.count} 条`);
  if (collected.source.coverage_warning) {
    log("      ", `⚠ 采集数量达到上限 ${limit}，可能未覆盖全部收藏；可用 --limit 调大再跑。`);
  }

  log("[2/5]", "与历史状态比较，计算增量…");
  const inc = prepareIncrementalRun(run);
  if (inc.summary.new_count === 0) {
    log("      ", "无新增收藏，无需处理，结束。");
    log("      ", `运行目录：${run}`);
    return;
  }
  log("      ", `新增 ${inc.summary.new_count} 条 / 总计 ${inc.summary.full_count} 条`);

  log("[3/5]", `生成分类初稿（新夹可见性=${folderVisibility}）…`);
  const drafted = writeDraftPlan(run, { folderVisibility });
  log("      ", `生成 ${drafted.plan.assignments.length} 条分配，${drafted.plan.folders.length} 个收藏夹`);

  log("[4/5]", "校验计划…");
  const source = readJson(path.join(run, "incremental-favorites.json"));
  const validation = validatePlan(drafted.plan, source);
  const preview = path.join(run, "preview.md");
  fs.writeFileSync(preview, renderPreview(drafted.plan, source, validation), "utf8");
  if (validation.ok) log("      ", "✓ 校验通过");
  else log("      ", `✗ 校验失败：${validation.errors.join("; ")}`);
  for (const warning of validation.warnings) log("      ", `⚠ ${warning}`);

  log("[5/5]", "预览已生成，全程未修改抖音账号。");
  process.stdout.write("\n");
  log("下一步", "");
  log("  1.", `查看预览：${preview}`);
  log("  2.", `由 AI 结合真实内容修订分类计划：${path.join(run, "classification-plan.json")}`);
  log("  3.", `确认后运行 \`npm run preview -- --run "${run}"\` 获取审批令牌`);
  log("  运行目录：", run);
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
