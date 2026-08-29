// diagnose-folders.mjs —— 高效诊断：接口直连读取每个收藏夹真实成员，
// 与 3200 条"应该加入"的目标视频比对，输出真正缺失的视频清单。
// 替代暴力滚动渲染（25 天 → 几分钟）。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";

function runOpencli(args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OPENCLI, ...args], {
      cwd: ROOT, env: { ...process.env }, windowsHide: true, shell: false,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) { reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim().slice(0, 400)}`)); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ""))); }
      catch (e) { resolve(stdout.trim()); }
    });
  });
}
const browser = (...a) => runOpencli(["browser", SESSION, ...a]);
const evaluate = js => browser("eval", js);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 安装捕获器：拦截所有 /aweme/v1/web/ 请求，记录 url + 视频 id
const CAPTURE_JS = `(() => {
  const key = '__dok_diag_capture';
  const state = { pages: [], urls: [], restore: null };
  const itemsOf = (d) => Array.isArray(d?.aweme_list) ? d.aweme_list
    : Array.isArray(d?.awemeList) ? d.awemeList
    : Array.isArray(d?.data?.aweme_list) ? d.data.aweme_list
    : Array.isArray(d?.data?.awemeList) ? d.data.awemeList : [];
  const push = (url, data) => { state.urls.push(String(url)); state.pages.push({ url: String(url), items: itemsOf(data).map(a => String(a?.aweme_id || a?.awemeId || '')) }); };
  const ep = v => String(v || '').includes('/aweme/v1/web/') ? v : '';
  const of = window.fetch, xp = XMLHttpRequest.prototype, oo = xp.open, os = xp.send;
  window.fetch = async function (...a) { const u = typeof a[0]==='string'?a[0]:a[0]?.url; const e = ep(u); const r = await of.apply(this, a); if (e) r.clone().json().then(d=>push(u,d)).catch(()=>{}); return r; };
  xp.open = function (m, u) { Object.defineProperty(this, '__u', { value: u, writable: true, configurable: true }); return oo.apply(this, arguments); };
  xp.send = function () { const e = ep(this.__u); if (e) this.addEventListener('loadend', function(){ try { push(this.__u, this.responseType==='json'?this.response:JSON.parse(String(this.responseText||''))); } catch(_){} }, { once: true }); return os.apply(this, arguments); };
  state.restore = () => { window.fetch = of; xp.open = oo; xp.send = os; };
  Object.defineProperty(window, key, { value: state, writable: true, configurable: true, enumerable: false });
  return true;
})()`;

// 提取所有 batch journal 里的 folder -> target aweme_ids
function loadTargets() {
  const targets = {};
  const runsDir = path.join(ROOT, "var", "runs");
  for (const name of fs.readdirSync(runsDir)) {
    if (!/^batch-\d{3}$/.test(name)) continue;
    const jf = path.join(runsDir, name, "apply-journal.jsonl");
    if (!fs.existsSync(jf)) continue;
    for (const line of fs.readFileSync(jf, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const folder = rec.folder; const ids = rec.aweme_ids || [];
      if (!folder || !ids.length) continue;
      targets[folder] = targets[folder] || new Set();
      for (const id of ids) targets[folder].add(String(id));
    }
  }
  return targets;
}

async function captureFolderMembers(folder) {
  // 先回到收藏夹列表视图，确保 LI 可见（点夹后会切到单夹视图，LI 消失）
  await evaluate(`(() => { const el = document.getElementById('semiTabfavorite_folder'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`).catch(() => {});
  await sleep(1500);
  await evaluate(CAPTURE_JS).catch(() => {});
  const clicked = await evaluate(`(() => {
    const li = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes(${JSON.stringify(folder)}));
    if (!li) return 'NO_LI';
    const target = li.querySelector('div') || li;
    const fire = (t, C) => target.dispatchEvent(new C(t, { bubbles: true, composed: true, button: 0 }));
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
    return 'CLICKED';
  })()`).catch(e => 'ERR:' + e.message);
  if (clicked !== 'CLICKED') return { clicked, members: new Set() };
  await sleep(2500);
  const first = await evaluate(`(() => {
    const s = window['__dok_diag_capture'] || {};
    const urls = s.urls || [];
    const collects = urls.filter(u => u.includes('/collects/video/list/'));
    const ids = new Set();
    for (const p of s.pages) for (const id of p.items) if (id) ids.add(id);
    return { firstUrl: collects[0] || '', ids: Array.from(ids) };
  })()`).catch(() => ({ firstUrl: "", ids: [] }));
  const members = new Set(first.ids);
  if (first.firstUrl) {
    let nextCursor = 20;
    for (let i = 0; i < 80; i += 1) {
      const url = first.firstUrl.replace(/([?&]cursor=)\d+/, "$1" + nextCursor);
      let data = null;
      for (let r = 0; r < 3; r += 1) {
        data = await evaluate(`(async () => { try { const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' }); return await res.json(); } catch (e) { return { __err: String(e) }; } })()`).catch(() => ({ __err: "eval" }));
        const items = data?.aweme_list || data?.awemeList || data?.data?.aweme_list || data?.data?.awemeList || [];
        if (!data?.__err && items.length) break;
        await sleep(500);
      }
      if (data?.__err) break;
      const items = data?.aweme_list || data?.awemeList || data?.data?.aweme_list || data?.data?.awemeList || [];
      if (!items.length) break;
      for (const a of items) if (a?.aweme_id) members.add(String(a.aweme_id));
      const nc = Number(data?.cursor ?? data?.data?.cursor ?? 0);
      if (nc > nextCursor) nextCursor = nc; else nextCursor += 20;
      if (data?.has_more === false) break;
    }
  }
  await evaluate(`(() => { const s = window['__dok_diag_capture']; if (s && s.restore) s.restore(); return true; })()`).catch(() => {});
  return { clicked: "CLICKED", members };
}

async function main() {
  const targets = loadTargets();
  const folders = Object.keys(targets);
  const totalTargets = folders.reduce((s, f) => s + targets[f].size, 0);
  console.error(`[diagnose] ${folders.length} folders, ${totalTargets} target videos`);
  await browser("open", `${SELF_URL}&showSubTab=favorite_folder`, "--window", "foreground").catch(e => console.error("[diagnose] open warn:", e.message));
  await sleep(8000);
  await evaluate(`(() => { const el = document.getElementById('semiTabfavorite_folder'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`).catch(() => {});
  await sleep(3000);

  const report = { captured_at: new Date().toISOString(), folders: [] };
  let totalMissing = 0;
  for (const folder of folders) {
    if (folder.includes("未处理")) { console.error(`[diagnose] skip non-folder: ${folder}`); continue; }
    const { clicked, members } = await captureFolderMembers(folder);
    const tset = targets[folder];
    const missing = [...tset].filter(id => !members.has(id));
    totalMissing += missing.length;
    report.folders.push({ folder, target: tset.size, members: members.size, missing: missing.length, missingIds: missing.slice(0, 30) });
    console.error(`[diagnose] ${folder}: target=${tset.size} members=${members.size} missing=${missing.length} (${clicked})`);
  }
  report.totalTargets = totalTargets;
  report.totalMissing = totalMissing;
  const fp = path.join(ROOT, "var", "runs", "diagnose-report.json");
  fs.writeFileSync(fp, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
