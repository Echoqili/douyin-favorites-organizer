// apply-real.mjs —— 真实 CDP 命令写入：进场→滚动收割(真实 check, 勾选持久)→加入收藏夹→选夹→确定
// 每个目标夹一趟：滚动全列表真实勾选本夹目标视频，再提交到该夹。
// --pilot：只处理第一个夹并验证。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";
const RUN_DIR = path.join(ROOT, "var", "runs", "final-apply-real");
const PILOT = process.argv.includes("--pilot");
const FOLDER_ARG = process.argv.slice(2).find(a => !a.startsWith("--")) || null;
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const log = m => process.stderr.write(`[REAL] ${m}\n`);

function runOpencli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OPENCLI, ...args], { cwd: ROOT, env: { ...process.env }, windowsHide: true, shell: false });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", code => { if (code !== 0) { reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim().slice(0, 400)}`)); return; } try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ""))); } catch (e) { resolve(stdout.trim()); } });
  });
}
const browser = (...a) => runOpencli(["browser", SESSION, ...a]);
const evaluate = js => browser("eval", js);
const ID_OF = `((cb) => { let cur = cb; for (let d = 0; d < 12 && cur; d++, cur = cur.parentElement) { const as = cur.querySelectorAll ? cur.querySelectorAll('a[href*="video/"]') : []; if (as.length === 1) { const m = (as[0].getAttribute('href') || '').match(/video\\/(\\d{15,})/); if (m) return m[1]; } if (as.length > 1) return null; } return null; })`;

async function enterMgmt() {
  await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground");
  await wait(4);
  for (let i = 0; i < 6; i++) {
    await evaluate(`(() => { const t = document.getElementById('semiTabvideo'); if (!t) return; const e = t.querySelector('div') || t; const f = (ty, C) => e.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 })); f('pointerdown', PointerEvent); f('mousedown', MouseEvent); f('pointerup', PointerEvent); f('mouseup', MouseEvent); f('click', MouseEvent); })()`);
    await wait(1);
    const sel = await evaluate(`(() => document.getElementById('semiTabvideo')?.getAttribute('aria-selected'))()`);
    if (sel === "true" || sel === true) break;
  }
  await evaluate(`(() => { if (document.body.innerText.includes('退出管理')) { [...document.querySelectorAll('*')].find(el => el.innerText?.trim() === '退出管理' && (el.offsetWidth || el.offsetHeight))?.click(); } })()`);
  await wait(1.5);
  for (let attempt = 0; attempt < 6; attempt++) {
    await evaluate(`(() => { const cands = [...document.querySelectorAll('*')].filter(el => el.innerText?.trim() === '批量管理' && (el.offsetWidth || el.offsetHeight)); if (!cands.length) return; const el = cands.find(e => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') || cands.at(-1); try { el.click(); } catch(e){} try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); } catch(e){} })()`);
    let on = false;
    for (let p = 0; p < 5; p++) { await wait(1); const st = await evaluate(`(() => document.body.innerText.includes('退出管理') && document.body.innerText.includes('加入收藏夹'))()`); if (st) { on = true; break; } }
    if (on) break;
  }
  return evaluate(`(() => document.body.innerText.includes('退出管理'))()`);
}

async function exitMgmt() {
  await evaluate(`(() => { const el=[...document.querySelectorAll('*')].find(e=>e.innerText?.trim()==='退出管理'&&(e.offsetWidth||e.offsetHeight)); if(el)el.click(); })()`).catch(()=>{});
  await wait(1.5);
}

// 滚动全列表，真实勾选 folder 的 target ids；返回已勾选集合
async function harvest(folder, ids) {
  const remaining = new Set(ids.map(String));
  const checked = new Set();
  let lastTop = -1, plateau = 0;
  const MAX_ITER = 600;
  for (let it = 0; it < MAX_ITER && remaining.size > 0; it++) {
    const mounted = await evaluate(`(() => { const cbs=[...document.querySelectorAll('input[type=checkbox]')]; const idOf=${ID_OF}; const out=[]; for(let i=0;i<cbs.length;i++){ const id=idOf(cbs[i]); if(id) out.push({nth:i, id}); } return out; })()`);
    for (const m of mounted) {
      if (remaining.has(m.id)) {
        const r = await browser("check", "input[type=checkbox]", "--nth", String(m.nth)).catch(e => ({ error: String(e.message) }));
        if (r && r.checked) { checked.add(m.id); remaining.delete(m.id); log(`${folder}: checked ${m.id} (${checked.size}/${ids.length})`); }
      }
    }
    if (remaining.size === 0) break;
    // 滚动
    const top = await evaluate(`(() => { const cb=document.querySelector('input[type=checkbox]'); let el=cb; while(el&&el!==document.body){ if(el.scrollHeight>el.clientHeight+5){ const t=el.scrollTop; el.scrollTop=t+1200; return t; } el=el.parentElement; } return -1; })()`);
    await wait(0.25);
    if (top === lastTop) { plateau += 1; if (plateau > 8) { log(`${folder}: reached bottom, ${remaining.size} not found (likely deleted)`); break; } } else { plateau = 0; lastTop = top; }
  }
  if (remaining.size > 0) log(`${folder}: ${remaining.size} targets not mounted (deleted?): ${[...remaining].slice(0,5).join(",")}`);
  return { checked: [...checked], notFound: [...remaining] };
}

async function submitToFolder(folder) {
  await browser("click", "--text", "加入收藏夹").catch(() => {});
  await wait(1.5);
  const panel = await evaluate(`(() => document.body.innerText.includes('选择收藏夹') || document.body.innerText.includes('加入收藏夹'))()`).catch(() => false);
  if (!panel) throw new Error("folder panel did not open");
  // 选目标夹（按文本点行）
  const sel = await browser("click", "--text", folder).catch(e => ({ error: String(e.message) }));
  log(`${folder} select result: ${JSON.stringify(sel).slice(0,120)}`);
  await wait(1.0);
  const confirm = await browser("click", "--text", "确定").catch(e => ({ error: String(e.message) }));
  log(`${folder} confirm: ${JSON.stringify(confirm).slice(0,120)}`);
  await wait(2.0);
  return true;
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const missingReport = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "_ai_classify_merged.json"), "utf8"));
  const UNREADABLE = new Set(["健身与运动", "内容创作与自媒体"]);
  let addPlan = [];
  for (const f of missingReport.folders) {
    if (UNREADABLE.has(f.folder)) continue;
    if (f.missingIds.length) addPlan.push({ folder: f.folder, ids: f.missingIds.map(String) });
  }
  const planByFolder = {};
  for (const [vid, folder] of Object.entries(plan)) (planByFolder[folder] ||= []).push(String(vid));
  for (const folder of UNREADABLE) { const ids = planByFolder[folder] || []; if (ids.length) addPlan.push({ folder, ids }); }
  log(`add plan: ${addPlan.length} folders, ${addPlan.reduce((s,b)=>s+b.ids.length,0)} videos`);
  if (FOLDER_ARG) addPlan = addPlan.filter(b => b.folder === FOLDER_ARG);
  if (PILOT) addPlan = addPlan.slice(0, 1);
  const results = [];
  for (const b of addPlan) {
    const mgmt = await enterMgmt();
    if (!mgmt) { results.push({ folder: b.folder, error: "enter mgmt failed" }); continue; }
    const harv = await harvest(b.folder, b.ids);
    let status = "nothing-checked";
    if (harv.checked.length) {
      try { await submitToFolder(b.folder); status = "submitted"; }
      catch (e) { status = "submit-error"; log(`${b.folder} submit error: ${e.message}`); }
    }
    await exitMgmt();
    const entry = { folder: b.folder, intended: b.ids.length, checked: harv.checked.length, notFound: harv.notFound.length, status };
    results.push(entry);
    log(`FOLDER DONE: ${JSON.stringify(entry)}`);
    fs.writeFileSync(path.join(RUN_DIR, "progress.json"), JSON.stringify(results, null, 2));
    await wait(2);
  }
  fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
}
main().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
