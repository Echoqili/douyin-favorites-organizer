// 待整理分类：只处理"未归类"的收藏（默认收藏里、还没进任何文件夹的视频）。
// 相比 classify-full.mjs：
//   1) 排除 folder-members.json 中所有已进夹的 ID（已整理的不再重复建议）；
//   2) 使用已增强的分类器（新增"认知提升"独立夹，见 src/classifier.mjs）。
// 不写抖音，只产出本地"待整理计划"。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFavorite } from "../src/classifier.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const runsDir = path.join(root, "var", "runs");

// 1) 聚合所有 favorites.json（去重 by aweme_id）
const favs = new Map();
function ingest(arr) {
  for (const it of arr || []) {
    const aid = it.aweme_id || it.aweme_id_str;
    if (!aid) continue;
    if (!favs.has(aid)) favs.set(aid, { aweme_id: aid, title: it.title || "", author: it.author || "" });
  }
}
for (const name of fs.readdirSync(runsDir)) {
  const fj = path.join(runsDir, name, "favorites.json");
  if (!fs.existsSync(fj)) continue;
  let data;
  try { data = JSON.parse(fs.readFileSync(fj, "utf8")); } catch { continue; }
  const arr = Array.isArray(data) ? data : (data.favorites || []);
  ingest(arr);
}

// 2) 已进夹的 ID（folder-members.json 的 ids 全集）
const organizedIds = new Set();
const fmPath = path.join(runsDir, "folder-members.json");
if (fs.existsSync(fmPath)) {
  const fm = JSON.parse(fs.readFileSync(fmPath, "utf8"));
  for (const f of fm.folders || []) for (const id of f.ids || []) organizedIds.add(id);
}
console.log("已进夹 ID 数:", organizedIds.size);

// 3) 已校准的 300 条（信任，直接采用）
const merged = fs.existsSync(path.join(runsDir, "_ai_classify_merged.json"))
  ? JSON.parse(fs.readFileSync(path.join(runsDir, "_ai_classify_merged.json"), "utf8"))
  : {};

// 4) 只分类未进夹的
const plan = {};               // aweme_id -> folder（待整理）
const byFolder = {};
const uncertain = [];
let reused = 0, classified = 0, skipped = 0;

for (const [aid, fav] of favs) {
  if (organizedIds.has(aid)) { skipped++; continue; }   // 已整理，跳过
  let folder, uncertainFlag = false;
  if (merged[aid]) {
    folder = merged[aid];
    reused++;
  } else {
    const r = classifyFavorite(fav, { uncertainFolder: "待确认", mode: "ai" });
    folder = r.folder;
    uncertainFlag = (r.evidence || []).length === 0;
    classified++;
  }
  plan[aid] = folder;
  byFolder[folder] = (byFolder[folder] || 0) + 1;
  if (uncertainFlag && !merged[aid]) uncertain.push({ aweme_id: aid, title: fav.title, author: fav.author, folder });
}

// 5) 写出
const planOut = path.join(runsDir, "todo-classification-plan.json");
fs.writeFileSync(planOut, JSON.stringify(plan, null, 0));
const summary = {
  generated_at: new Date().toISOString(),
  total_collected: favs.size,
  already_in_folder: skipped,
  todo_total: Object.keys(plan).length,
  reused_from_merged: reused,
  newly_classified: classified,
  byFolder,
  uncertain_count: uncertain.length,
  uncertain,
};
const sumOut = path.join(runsDir, "todo-classification-summary.json");
fs.writeFileSync(sumOut, JSON.stringify(summary, null, 2));

console.log("=== 待整理分类完成 ===");
console.log("采集总数:", favs.size, "| 已进夹(跳过):", skipped, "| 待整理:", Object.keys(plan).length);
console.log("复用已校准(300):", reused, " | 新分类:", classified);
console.log("落入宽泛兜底(待人工确认):", uncertain.length);
console.log("--- 待整理各夹分布 ---");
for (const [f, c] of Object.entries(byFolder).sort((a, b) => b[1] - a[1])) console.log(`  ${f}: ${c}`);
console.log("写出计划:", planOut);
console.log("汇总:", sumOut);
