// compute-missing.mjs —— 用真实成员（folder-members.json）比对规范计划（_ai_classify_merged.json），
// 算出每个夹真正缺失的视频。不触碰浏览器。
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const membersPath = path.join(ROOT, "var", "runs", "folder-members.json");
const planPath = path.join(ROOT, "var", "runs", "_ai_classify_merged.json");

const membersDoc = JSON.parse(fs.readFileSync(membersPath, "utf8"));
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

// 真实成员：folder name -> Set(ids)
const realByName = {};
const folderMeta = {};
for (const f of membersDoc.folders) {
  realByName[f.name] = new Set(f.ids);
  folderMeta[f.name] = { domCount: f.domCount, apiCount: f.apiCount, collects_id: f.collects_id };
}

// 计划：folder name -> [video ids]
const planByName = {};
for (const [vid, folder] of Object.entries(plan)) {
  (planByName[folder] ||= []).push(vid);
}

const report = { captured_at: new Date().toISOString(), folders: [], totals: {} };
let totalPlanned = 0, totalPresent = 0, totalMissing = 0;
const missingGlobal = [];
const unknownFolders = [];

for (const [folder, vids] of Object.entries(planByName)) {
  totalPlanned += vids.length;
  if (!realByName[folder]) { unknownFolders.push(folder); continue; }
  const real = realByName[folder];
  const present = vids.filter(v => real.has(v));
  const missing = vids.filter(v => !real.has(v));
  totalPresent += present.length;
  totalMissing += missing.length;
  missingGlobal.push(...missing.map(v => ({ video: v, folder })));
  report.folders.push({
    folder,
    planned: vids.length,
    present: present.length,
    missing: missing.length,
    domCount: folderMeta[folder]?.domCount ?? null,
    apiCount: folderMeta[folder]?.apiCount ?? null,
    incompleteEnum: folderMeta[folder] ? (folderMeta[folder].domCount > 0 && folderMeta[folder].apiCount < folderMeta[folder].domCount * 0.8) : false,
    missingIds: missing,
  });
}

// 未被计划覆盖、但真实存在的夹
const extraFolders = Object.keys(realByName).filter(f => !planByName[f]);

report.totals = { planned: totalPlanned, present: totalPresent, missing: totalMissing };
report.unknownFolders = unknownFolders;
report.extraRealFolders = extraFolders;
report.missingIds = missingGlobal;

fs.writeFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  totals: report.totals,
  unknownFolders,
  extraRealFolders: extraFolders,
  folders: report.folders.map(f => ({ folder: f.folder, planned: f.planned, present: f.present, missing: f.missing, domCount: f.domCount, apiCount: f.apiCount, incompleteEnum: f.incompleteEnum })),
}, null, 2));
