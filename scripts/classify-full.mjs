// 全量分类：把 var/runs 下所有 favorites.json 聚合去重，对每条收藏打上"应归夹"。
// 已人工校准的 300 条 (_ai_classify_merged.json) 保留；其余用本地语义分类器 (classifier.mjs) 判定。
// 不写抖音，只产出本地完整分类计划。
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

// 2) 已校准的 300 条（信任，直接采用）
const mergedPath = path.join(runsDir, "_ai_classify_merged.json");
const merged = fs.existsSync(mergedPath) ? JSON.parse(fs.readFileSync(mergedPath, "utf8")) : {};

// 3) 分类
const plan = {};               // aweme_id -> folder（合并兼容格式）
const byFolder = {};           // folder -> count
const uncertain = [];          // 落入宽泛兜底、需人工确认的
let reused = 0, classified = 0;

for (const [aid, fav] of favs) {
  let folder, uncertainFlag = false;
  if (merged[aid]) {
    folder = merged[aid];
    reused++;
  } else {
    const r = classifyFavorite(fav, { uncertainFolder: "待确认", mode: "ai" });
    folder = r.folder;
    uncertainFlag = (r.evidence || []).length === 0; // 未命中专精度规则 -> 兜底
    classified++;
  }
  plan[aid] = folder;
  byFolder[folder] = (byFolder[folder] || 0) + 1;
  if (uncertainFlag && !merged[aid]) {
    uncertain.push({ aweme_id: aid, title: fav.title, author: fav.author, folder });
  }
}

// 4) 写出
const planOut = path.join(runsDir, "full-classification-plan.json");
fs.writeFileSync(planOut, JSON.stringify(plan, null, 0));
const summary = {
  generated_at: new Date().toISOString(),
  total: favs.size,
  reused_from_merged: reused,
  newly_classified: classified,
  byFolder,
  uncertain_count: uncertain.length,
  uncertain,
};
const sumOut = path.join(runsDir, "full-classification-summary.json");
fs.writeFileSync(sumOut, JSON.stringify(summary, null, 2));

console.log("=== 全量分类完成 ===");
console.log("总唯一收藏:", favs.size);
console.log("复用已校准(300):", reused, " | 新分类:", classified);
console.log("落入宽泛兜底(待人工确认):", uncertain.length);
console.log("--- 各夹分布 ---");
for (const [f, c] of Object.entries(byFolder).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${f}: ${c}`);
}
console.log("写出:", planOut);
console.log("汇总:", sumOut);
