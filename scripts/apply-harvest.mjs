// apply-harvest.mjs —— 单次会话全列表遍历：按 id 真实勾选所有缺失目标，记录可加/已删
// 不提交，只产出：checked(可加的 id 集合) 与 notFound(疑似已删)
import path from "node:path";
import fs from "fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";
const RUN_DIR = path.join(ROOT, "var", "runs", "final-harvest");
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const log = m => process.stderr.write(`[H] ${m}\n`);

const runOpencli = (args) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [OPENCLI, ...args], { cwd: ROOT, env: { ...process.env }, windowsHide: true });
  let o = "", e = "";
  c.stdout.on("data", d => o += d); c.stderr.on("data", d => e += d);
  c.on("close", code => { if (code !== 0) { reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${(e || o).slice(0, 300)}`)); return; } try { resolve(JSON.parse(o.replace(/^\uFEFF/u, ""))); } catch { resolve(o.trim()); } });
});
const browser = (...a) => runOpencli(["browser", SESSION, ...a]);
const ev = js => browser("eval", js);
const ID_OF = `((cb) => { let cur = cb; for (let d = 0; d < 12 && cur; d++, cur = cur.parentElement) { const as = cur.querySelectorAll ? cur.querySelectorAll('a[href*="video/"]') : []; if (as.length === 1) { const m = (as[0].getAttribute('href') || '').match(/video\\/(\\d{15,})/); if (m) return m[1]; } if (as.length > 1) return null; } return null; })`;
const mountedMap = () => ev(`(() => { const cbs=[...document.querySelectorAll('input[type=checkbox]')]; const idOf=${ID_OF}; const out=[]; for(let i=0;i<cbs.length;i++){ const id=idOf(cbs[i]); if(id) out.push({nth:i, id}); } return out; })()`);

async function enterMgmt() {
  await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground");
  await wait(4);
  for (let i = 0; i < 6; i++) {
    await ev(`(() => { const t = document.getElementById('semiTabvideo'); if (!t) return; const e = t.querySelector('div') || t; const f = (ty, C) => e.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 })); f('pointerdown', PointerEvent); f('mousedown', MouseEvent); f('pointerup', PointerEvent); f('mouseup', MouseEvent); f('click', MouseEvent); })()`);
    await wait(1);
    const sel = await ev(`(() => document.getElementById('semiTabvideo')?.getAttribute('aria-selected'))()`);
    if (sel === "true" || sel === true) break;
  }
  await ev(`(() => { if (document.body.innerText.includes('退出管理')) { [...document.querySelectorAll('*')].find(el => el.innerText?.trim() === '退出管理' && (el.offsetWidth || el.offsetHeight))?.click(); } })()`);
  await wait(1.5);
  for (let attempt = 0; attempt < 6; attempt++) {
    await ev(`(() => { const cands = [...document.querySelectorAll('*')].filter(el => el.innerText?.trim() === '批量管理' && (el.offsetWidth || el.offsetHeight)); if (!cands.length) return; const el = cands.find(e => e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') || cands.at(-1); try { el.click(); } catch(e){} })()`);
    let on = false;
    for (let p = 0; p < 5; p++) { await wait(1); const st = await ev(`(() => document.body.innerText.includes('退出管理') && document.body.innerText.includes('加入收藏夹'))()`); if (st) { on = true; break; } }
    if (on) break;
  }
  return ev(`(() => document.body.innerText.includes('退出管理'))()`);
}

const SCROLL_TOP = `(() => { const cb=document.querySelector('input[type=checkbox]'); let el=cb; while(el&&el!==document.body){ if(el.scrollHeight>el.clientHeight+50){ return el.scrollTop; } el=el.parentElement;} return -1; })`;
const SCROLL_DO = `(() => { const cb=document.querySelector('input[type=checkbox]'); let el=cb; while(el&&el!==document.body){ if(el.scrollHeight>el.clientHeight+50){ const max=el.scrollHeight-el.clientHeight; const nt=Math.min(max, el.scrollTop+Math.round(el.clientHeight*0.7)); el.scrollTop=nt; return {max, nt}; } el=el.parentElement;} return null; })`;

(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const missingReport = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), "utf8"));
  const targets = new Set();
  for (const f of missingReport.folders) for (const id of f.missingIds) targets.add(String(id));
  log(`targets=${targets.size}`);
  const on = await enterMgmt();
  log(`mgmt on=${on}`);
  const checked = new Set();
  let iters = 0; const MAX = 600;
  let bottom = false;
  while (iters++ < MAX && !bottom) {
    const map = await mountedMap();
    for (const m of map) if (targets.has(m.id) && !checked.has(m.id)) {
      const r = await browser("check", "input[type=checkbox]", "--nth", String(m.nth)).catch(() => ({}));
      if (r && r.checked) { checked.add(m.id); log(`checked ${m.id} (${checked.size}/${targets.size})`); }
    }
    if (checked.size === targets.size) { log("ALL CHECKED"); break; }
    const scrollRes = await ev(SCROLL_DO);
    await wait(1.5);
    if (!scrollRes) { await wait(1.0); if (iters > 6) { log("no scroll container, stop"); break; } continue; }
    const after = await ev(SCROLL_TOP);
    if (after >= scrollRes.max - 5) {
      log("BOTTOM reached");
      const map2 = await mountedMap();
      for (const m of map2) if (targets.has(m.id) && !checked.has(m.id)) { const r = await browser("check", "input[type=checkbox]", "--nth", String(m.nth)).catch(() => ({})); if (r && r.checked) checked.add(m.id); }
      bottom = true;
    }
  }
  const notFound = [...targets].filter(id => !checked.has(id));
  const out = { at: new Date().toISOString(), total: targets.size, checkedCount: checked.size, checked: [...checked], notFoundCount: notFound.length, notFound };
  fs.writeFileSync(path.join(RUN_DIR, "harvest-result.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ total: out.total, checkedCount: out.checkedCount, notFoundCount: out.notFoundCount }, null, 2));
})().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
