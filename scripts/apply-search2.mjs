// apply-search2.mjs —— 搜索窄化 + 真实 CDP 勾选 写入
// 对每个缺失视频：用标题前缀搜 -> 结果页进批量管理(窄列表) -> 按 id 真实勾选 -> 加入对应夹 -> 确定
// --limit N：只处理前 N 个（pilot）。--pilot：limit=3
import path from "node:path";
import fs from "fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";
const RUN_DIR = path.join(ROOT, "var", "runs", "final-apply-search");
const PILOT = process.argv.includes("--pilot");
const LIMIT = (() => { const i = process.argv.indexOf("--limit"); return i >= 0 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const log = m => process.stderr.write(`[S2] ${m}\n`);

const runOpencli = (args) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [OPENCLI, ...args], { cwd: ROOT, env: { ...process.env }, windowsHide: true });
  let o = "", e = "";
  c.stdout.on("data", d => o += d); c.stderr.on("data", d => e += d);
  c.on("close", code => { if (code !== 0) { reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${(stderr || stdout || '').slice(0, 300)}`)); return; } try { resolve(JSON.parse(o.replace(/^\uFEFF/u, ""))); } catch { resolve(o.trim()); } });
});
const browser = (...a) => runOpencli(["browser", SESSION, ...a]);
const ev = js => browser("eval", js);
const ID_OF = `((cb) => { let cur = cb; for (let d = 0; d < 12 && cur; d++, cur = cur.parentElement) { const as = cur.querySelectorAll ? cur.querySelectorAll('a[href*="video/"]') : []; if (as.length === 1) { const m = (as[0].getAttribute('href') || '').match(/video\\/(\\d{15,})/); if (m) return m[1]; } if (as.length > 1) return null; } return null; })`;
const mountedMap = () => ev(`(() => { const cbs=[...document.querySelectorAll('input[type=checkbox]')]; const idOf=${ID_OF}; const out=[]; for(let i=0;i<cbs.length;i++){ const id=idOf(cbs[i]); if(id) out.push({nth:i, id}); } return out; })()`);

function titlePrefix(title) {
  const base = String(title || "").split(/[#\n@]/)[0].trim();
  return base.slice(0, 12);
}

async function ensureFavPage() {
  const mgmt = await ev(`(() => document.body.innerText.includes('退出管理'))()`).catch(() => false);
  if (mgmt) { await ev(`(() => { const el=[...document.querySelectorAll('*')].find(e=>e.innerText?.trim()==='退出管理'&&(e.offsetWidth||e.offsetHeight)); if(el)el.click(); })()`).catch(()=>{}); await wait(1.5); }
  const onFav = await ev(`(() => location.href.includes('favorite') && !document.body.innerText.includes('退出管理'))()`).catch(() => false);
  if (!onFav) { await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground"); await wait(4); }
}

async function enterMgmtFromResults(query) {
  const fillR = await browser("fill", "--name", "搜索你收藏的作品", query).catch(e => ({ error: e.message }));
  if (!fillR || fillR.error) return { ok: false, why: "fill:" + (fillR && fillR.error) };
  await wait(1);
  await ev(`(() => { const inp=[...document.querySelectorAll('input')].find(i=>(i.getAttribute('placeholder')||'')==='搜索你收藏的作品'); if(inp){ inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true})); inp.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,bubbles:true})); } })()`);
  await wait(3);
  const hasBatch = await ev(`(() => document.body.innerText.includes('批量管理'))()`).catch(() => false);
  if (!hasBatch) return { ok: false, why: "no-batch-after-search" };
  await ev(`(() => { const cands=[...document.querySelectorAll('*')].filter(el=>el.innerText?.trim()==='批量管理'&&(el.offsetWidth||el.offsetHeight)); const el=cands.find(e=>e.tagName==='BUTTON'||e.getAttribute('role')==='button')||cands.at(-1); if(el){el.click();} })()`);
  await wait(3);
  const mgmt = await ev(`(() => document.body.innerText.includes('退出管理'))()`).catch(() => false);
  return { ok: !!mgmt, why: mgmt ? "" : "mgmt-not-on" };
}

async function submitToFolder(folder) {
  await browser("click", "--text", "加入收藏夹").catch(() => {});
  await wait(1.5);
  await browser("click", "--text", folder).catch(() => {});
  await wait(1.0);
  const r = await browser("click", "--text", "确定").catch(e => ({ error: e.message }));
  await wait(2.0);
  return r;
}

(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const missingReport = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), "utf8"));
  const favs = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "_full", "favorites.json"), "utf8"));
  const arr = Array.isArray(favs) ? favs : (favs.aweme_list || favs.favorites || Object.values(favs)[0]);
  const titleById = new Map(arr.map(v => [String(v.aweme_id || v.id), v.title || v.desc || ""]));

  // 扁平化任务： (id, folder)
  const tasks = [];
  for (const f of missingReport.folders) for (const id of f.missingIds) tasks.push({ id: String(id), folder: f.folder });
  const limited = tasks.slice(0, PILOT ? 3 : LIMIT);
  log(`total tasks=${tasks.length} running=${limited.length}`);

  const results = [];
  for (const t of limited) {
    const query = titlePrefix(titleById.get(t.id));
    log(`-- ${t.id} [${t.folder}] query="${query}"`);
    await ensureFavPage();
    const ent = await enterMgmtFromResults(query);
    if (!ent.ok) { results.push({ ...t, status: "search-fail", why: ent.why }); log(`   search-fail: ${ent.why}`); continue; }
    const map = await mountedMap();
    const hit = map.find(m => m.id === t.id);
    if (!hit) { results.push({ ...t, status: "not-in-filtered", filteredCount: map.length }); log(`   not in filtered (${map.length})`); continue; }
    const chk = await browser("check", "input[type=checkbox]", "--nth", String(hit.nth)).catch(e => ({ error: e.message }));
    if (!chk || !chk.checked) { results.push({ ...t, status: "check-fail", chk: JSON.stringify(chk).slice(0, 80) }); log(`   check-fail`); continue; }
    const sub = await submitToFolder(t.folder);
    results.push({ ...t, status: "submitted", submit: JSON.stringify(sub).slice(0, 80) });
    log(`   SUBMITTED`);
    await wait(2);
  }
  const summary = { at: new Date().toISOString(), done: results.length, byStatus: {}, results };
  for (const r of results) summary.byStatus[r.status] = (summary.byStatus[r.status] || 0) + 1;
  fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
