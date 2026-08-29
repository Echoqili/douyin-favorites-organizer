// enum-folders.mjs —— 高效枚举：逐个收藏夹接口直连拿完整真实成员 ID。
// 每个夹：fresh-open 收藏夹列表页 -> 完整事件链点击夹 -> 捕获带 collects_id 的
// collects/video/list 签名 URL -> 用 fetch 翻页拿全量成员。
// 跳过"未处理（懒加载未渲染）"这类非真实夹。输出 var/runs/folder-members.json。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection&showSubTab=favorite_folder";

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
  const key = '__dok_enum_capture';
  const state = { urls: [], pages: [], restore: null };
  const itemsOf = (d) => Array.isArray(d?.aweme_list) ? d.aweme_list : Array.isArray(d?.awemeList) ? d.awemeList : Array.isArray(d?.data?.aweme_list) ? d.data.aweme_list : Array.isArray(d?.data?.awemeList) ? d.data.awemeList : [];
  const push = (u, d) => { state.urls.push(String(u)); const its = itemsOf(d); if (its.length) state.pages.push({ url: String(u), cursor: Number(d?.cursor ?? d?.data?.cursor ?? 0), items: its.map(a => String(a?.aweme_id || a?.awemeId || '')) }); };
  const of = window.fetch, xp = XMLHttpRequest.prototype, oo = xp.open, os = xp.send;
  window.fetch = async function (...a) { const u = typeof a[0]==='string'?a[0]:a[0]?.url; const r = await of.apply(this,a); if (/collects\\/video\\/list/.test(String(u))) r.clone().json().then(d=>push(u,d)).catch(()=>{}); return r; };
  xp.open = function (m,u){ Object.defineProperty(this,'__u',{value:u,writable:true,configurable:true}); return oo.apply(this,arguments); };
  xp.send = function(){ const u=this.__u; if (/collects\\/video\\/list/.test(String(u))) this.addEventListener('loadend',function(){try{push(u,this.responseType==='json'?this.response:JSON.parse(String(this.responseText||'')));}catch(_){}},{once:true}); return os.apply(this,arguments); };
  state.restore = () => { window.fetch=of; xp.open=oo; xp.send=os; };
  Object.defineProperty(window, key, { value: state, writable:true, configurable:true, enumerable:false });
  return true;
})()`;

const READ_JS = `(() => {
  const s = window['__dok_enum_capture'] || {};
  const urls = (s.urls || []).filter(u => /collects\\/video\\/list/.test(u));
  const ids = new Set();
  for (const p of (s.pages||[])) for (const id of p.items) if (id) ids.add(id);
  return { firstUrl: urls[0] || '', allUrls: urls, capturedIds: Array.from(ids) };
})()`;

function baseUrlOf(url) {
  // 去掉 cursor 参数，保留签名等
  return url.replace(/([?&]cursor=)\d+/, "$1").replace(/cursor=\d+&?/, "").replace(/[?&]$/, "");
}

async function fetchPages(baseUrl, startCursor, maxPages) {
  const members = new Set();
  let cursor = startCursor;
  for (let i = 0; i < maxPages; i += 1) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}cursor=${cursor}&count=20`;
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
    if (data?.has_more === false) break;
    const nc = Number(data?.cursor ?? data?.data?.cursor ?? 0);
    if (nc > cursor) cursor = nc; else cursor += 20;
    if (cursor >= startCursor + maxPages * 20) break;
  }
  return members;
}

async function enumFolder(name) {
  await browser("open", SELF_URL, "--window", "foreground").catch(() => {});
  await sleep(4500);
  await evaluate(CAPTURE_JS).catch(() => {});
  const clicked = await evaluate(`(() => {
    const li = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes(${JSON.stringify(name)}));
    if (!li) return 'NO_LI';
    const t = li.querySelector('div') || li;
    const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 }));
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
    return 'CLICKED';
  })()`).catch(e => 'ERR:' + e.message);
  if (clicked !== 'CLICKED') return { name, clicked, collects_id: "", members: [] };
  await sleep(2500);
  const read = await evaluate(READ_JS).catch(() => ({ firstUrl: "", capturedIds: [] }));
  const collects_id = (read.firstUrl.match(/collects_id=(\d+)/) || [])[1] || "";
  const members = new Set(read.capturedIds);
  if (read.firstUrl) {
    const base = baseUrlOf(read.firstUrl);
    // 从已捕获页面的最大 cursor 之后继续翻页
    const capturedCursors = (read.allUrls || []).map(u => Number((u.match(/cursor=(\d+)/) || [])[1] || 0));
    const start = Math.max(0, ...capturedCursors) + 20;
    const more = await fetchPages(base, start, 40);
    for (const id of more) members.add(id);
  }
  await evaluate(`(() => { const s = window['__dok_enum_capture']; if (s && s.restore) s.restore(); return true; })()`).catch(() => {});
  return { name, clicked: "CLICKED", collects_id, members: Array.from(members) };
}

async function main() {
  // Phase A: 读收藏夹名列表（DOM）
  await browser("open", SELF_URL, "--window", "foreground").catch(() => {});
  await sleep(4500);
  const folderTexts = await evaluate(`(() => Array.from(document.querySelectorAll('li')).map(li => (li.textContent||'').trim()).filter(t => /共\\d+作品/.test(t)))()`).catch(() => []);
  const folders = folderTexts
    .map(t => ({ name: t.replace(/共\d+作品.*/, ""), domCount: Number((t.match(/共(\d+)作品/) || [])[1] || 0) }))
    .filter(f => f.name && !f.name.includes("未处理"));
  console.error(`[enum] discovered ${folders.length} folders:`, folders.map(f => f.name).join(", "));

  const result = { captured_at: new Date().toISOString(), folders: [] };
  for (const f of folders) {
    const r = await enumFolder(f.name);
    result.folders.push({ name: f.name, domCount: f.domCount, collects_id: r.collects_id, apiCount: r.members.length, clicked: r.clicked, ids: r.members });
    console.error(`[enum] ${f.name}: clicked=${r.clicked} collects_id=${r.collects_id} members=${r.members.length} (dom=${f.domCount})`);
  }
  const fp = path.join(ROOT, "var", "runs", "folder-members.json");
  fs.writeFileSync(fp, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ captured_at: result.captured_at, summary: result.folders.map(f => ({ name: f.name, domCount: f.domCount, apiCount: f.apiCount, collects_id: f.collects_id })) }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
