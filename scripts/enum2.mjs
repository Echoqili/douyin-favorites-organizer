// enum2.mjs —— 滚动触发 + 捕获：点击夹后滚动单夹视图，让抖音自身代码自然翻页
// （带正确签名），monkey-patch 捕获每一页 collects/video/list 响应，拿全量成员。
// 验证模式：只跑传入的若干夹，确认能否抓满 domCount。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection&showSubTab=favorite_folder";
const ONLY = process.argv.slice(2);

function runOpencli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OPENCLI, ...args], { cwd: ROOT, env: { ...process.env }, windowsHide: true, shell: false });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject);
    child.on("close", code => { if (code !== 0) { reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${(stderr || stdout).trim().slice(0, 600)}`)); return; } try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ""))); } catch (e) { resolve(stdout.trim()); } });
  });
}
const browser = (...a) => runOpencli(["browser", SESSION, ...a]);
const evaluate = js => browser("eval", js);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CAPTURE_JS = `(() => {
  const key = '__dok_enum2';
  const state = { pages: [], firstUrl: "", restore: null };
  const itemsOf = (d) => Array.isArray(d?.aweme_list) ? d.aweme_list : Array.isArray(d?.awemeList) ? d.awemeList : Array.isArray(d?.data?.aweme_list) ? d.data.aweme_list : Array.isArray(d?.data?.awemeList) ? d.data.awemeList : [];
  const push = (u, d) => { if (!state.firstUrl) state.firstUrl = String(u); const its = itemsOf(d); if (its.length) state.pages.push({ url: String(u), cursor: Number(d?.cursor ?? d?.data?.cursor ?? 0), has_more: d?.has_more ?? d?.data?.has_more ?? null, items: its.map(a => String(a?.aweme_id || a?.awemeId || '')) }); };
  const of = window.fetch, xp = XMLHttpRequest.prototype, oo = xp.open, os = xp.send;
  window.fetch = async function (...a) { const u = typeof a[0]==='string'?a[0]:a[0]?.url; const r = await of.apply(this,a); if (/collects\\/video\\/list/.test(String(u))) r.clone().json().then(d=>push(u,d)).catch(()=>{}); return r; };
  xp.open = function (m,u){ Object.defineProperty(this,'__u',{value:u,writable:true,configurable:true}); return oo.apply(this,arguments); };
  xp.send = function(){ const u=this.__u; if (/collects\\/video\\/list/.test(String(u))) this.addEventListener('loadend',function(){try{push(u,this.responseType==='json'?this.response:JSON.parse(String(this.responseText||'')));}catch(_){}},{once:true}); return os.apply(this,arguments); };
  state.restore = () => { window.fetch=of; xp.open=oo; xp.send=os; };
  Object.defineProperty(window, key, { value: state, writable:true, configurable:true, enumerable:false });
  return true;
})()`;

const READ_JS = `(() => { const s = window['__dok_enum2']||{}; const ids = new Set(); const pages = s.pages||[]; for (const p of pages) for (const id of p.items) if (id) ids.add(id); const cursors = pages.map(p=>p.cursor); const hasMore = pages.length?pages[pages.length-1].has_more:null; const cid = (s.firstUrl||'').match(/collects_id=(\\d+)/); return { ids: Array.from(ids), pageCount: pages.length, lastCursor: cursors.length?Math.max(...cursors):0, lastHasMore: hasMore, allCursors: cursors, collects_id: cid?cid[1]:"" }; })()`;

const SCROLL_JS = `(() => {
  const fire = (el) => { try { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch(_){} };
  window.scrollTo(0, document.body.scrollHeight);
  document.querySelectorAll('*').forEach(el => { if (el.scrollHeight > el.clientHeight + 80) fire(el); });
  return true;
})()`;

async function enumFolder(name) {
  await browser("open", SELF_URL, "--window", "foreground").catch(() => {});
  await sleep(4000);
  await evaluate(CAPTURE_JS).catch(() => {});
  // 先滚动夹列表，触发懒渲染确保所有 <li> 进入 DOM（最后几个夹可能未渲染）
  for (let s = 0; s < 6; s += 1) {
    await evaluate(`(() => { const f = (el)=>{try{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll',{bubbles:true}));}catch(_){}}; window.scrollTo(0, document.body.scrollHeight); document.querySelectorAll('*').forEach(el=>{ if (el.scrollHeight>el.clientHeight+80) f(el); }); return true; })()`).catch(() => {});
    await sleep(700);
  }
  const clicked = await evaluate(`(() => {
    const li = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes(${JSON.stringify(name)}));
    if (!li) return 'NO_LI';
    const targets = [li.querySelector('div'), li.querySelector('p'), li].filter(Boolean);
    const chains = [
      ['pointerdown','mousedown','pointerup','mouseup','click'],
      ['mousedown','mouseup','click'],
      ['click']
    ];
    const fireChain = (t, chain) => { const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 })); for (const ty of chain) fire(ty, ty.startsWith('pointer')?PointerEvent:MouseEvent); };
    // 尝试多种目标+事件链，直到触发 collects/video/list（由捕获层记录 collects_id 判定）
    for (const t of targets) { for (const chain of chains) { fireChain(t, chain); const s = window['__dok_enum2']; if (s && s.firstUrl && /collects_id=/.test(s.firstUrl)) return 'CLICKED'; await new Promise(r=>setTimeout(r,300)); } }
    return 'CLICKED_TRIED';
  })()`).catch(e => 'ERR:' + e.message);
  if (clicked === 'NO_LI') return { name, clicked, collects_id: "", ids: [] };
  await sleep(3500);
  // 滚动触发翻页，直到连续 4 次无新增
  let lastCount = -1, stall = 0;
  for (let i = 0; i < 40; i += 1) {
    await evaluate(SCROLL_JS).catch(() => {});
    await sleep(900);
    const snap = await evaluate(READ_JS).catch(() => ({ ids: [] }));
    if (snap.ids.length === lastCount) { stall += 1; } else { stall = 0; lastCount = snap.ids.length; }
    if (stall >= 4) break;
  }
  const read = await evaluate(READ_JS).catch(() => ({ ids: [], lastHasMore: null, collects_id: "" }));
  await evaluate(`(() => { const s = window['__dok_enum2']; if (s && s.restore) s.restore(); return true; })()`).catch(() => {});
  return { name, clicked: "CLICKED", ids: read.ids, lastHasMore: read.lastHasMore, pageCount: read.pageCount, lastCursor: read.lastCursor, collects_id: read.collects_id };
}
function main() {
  return (async () => {
    await browser("open", SELF_URL, "--window", "foreground").catch(() => {});
    await sleep(4000);
    const folderTexts = await evaluate(`(() => Array.from(document.querySelectorAll('li')).map(li => (li.textContent||'').trim()).filter(t => /共\\d+作品/.test(t)))()`).catch(() => []);
    let folders = folderTexts
      .map(t => ({ name: t.replace(/共\d+作品.*/, ""), domCount: Number((t.match(/共(\d+)作品/) || [])[1] || 0) }))
      .filter(f => f.name && !f.name.includes("未处理"));
    if (ONLY.length) folders = folders.filter(f => ONLY.includes(f.name));
    console.error(`[enum2] folders to process:`, folders.map(f => `${f.name}(${f.domCount})`).join(", "));
    const result = { folders: [] };
    for (const f of folders) {
      const r = await enumFolder(f.name);
      result.folders.push({ name: f.name, domCount: f.domCount, apiCount: r.ids.length, lastHasMore: r.lastHasMore, pageCount: r.pageCount, lastCursor: r.lastCursor, clicked: r.clicked, collects_id: r.collects_id, ids: r.ids });
      console.error(`[enum2] ${f.name}: api=${r.ids.length}/${f.domCount} hasMore=${r.lastHasMore} pages=${r.pageCount} (${r.ids.length>=f.domCount?'FULL':'PARTIAL'})`);
    }
    const fp = path.join(ROOT, "var", "runs", "folder-members.json");
    // 合并模式：保留已抓到的其他夹，只更新本次处理的夹
    let merged = result;
    if (fs.existsSync(fp)) {
      try {
        const prev = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (Array.isArray(prev.folders)) {
          const done = new Set(result.folders.map(f => f.name));
          merged = { captured_at: result.captured_at || new Date().toISOString(), folders: [...prev.folders.filter(f => !done.has(f.name)), ...result.folders] };
        }
      } catch (_) {}
    }
    fs.writeFileSync(fp, JSON.stringify(merged, null, 2));
    console.log(JSON.stringify(result.folders.map(f => ({ name: f.name, domCount: f.domCount, apiCount: f.apiCount, lastHasMore: f.lastHasMore, pageCount: f.pageCount })), null, 2));
  })();
}
main().catch(e => { console.error(e); process.exit(1); });
