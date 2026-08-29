// test-signature.mjs —— 决定性测试：抖音 collects/video/list 的签名是否绑定 cursor。
// 若改 cursor 复用同一签名仍能返回数据 => 可自由接口翻页；否则必须滚动触发。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection&showSubTab=favorite_folder";
const FOLDER = process.argv[2] || "商业与搞钱";

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
  const key = '__dok_sig_capture';
  const state = { urls: [], restore: null };
  const of = window.fetch, xp = XMLHttpRequest.prototype, oo = xp.open, os = xp.send;
  window.fetch = async function (...a) { const u = typeof a[0]==='string'?a[0]:a[0]?.url; const r = await of.apply(this,a); if (/collects\\/video\\/list/.test(String(u))) state.urls.push(String(u)); return r; };
  xp.open = function (m,u){ Object.defineProperty(this,'__u',{value:u,writable:true,configurable:true}); return oo.apply(this,arguments); };
  xp.send = function(){ const u=this.__u; if (/collects\\/video\\/list/.test(String(u))) state.urls.push(String(u)); return os.apply(this,arguments); };
  state.restore = () => { window.fetch=of; xp.open=oo; xp.send=os; };
  Object.defineProperty(window, key, { value: state, writable:true, configurable:true, enumerable:false });
  return true;
})()`;

const READ_JS = `(() => { const s = window['__dok_sig_capture']||{}; return { urls: (s.urls||[]).filter(u=>/collects\\/video\\/list/.test(u)) }; })()`;

function stripCursor(url) { return url.replace(/([?&]cursor=)\d+/, "$1").replace(/cursor=\d+&?/, "").replace(/[?&]$/, ""); }

async function main() {
  await browser("open", SELF_URL, "--window", "foreground").catch(() => {});
  await sleep(4500);
  await evaluate(CAPTURE_JS).catch(() => {});
  await evaluate(`(() => {
    const li = Array.from(document.querySelectorAll('li')).find(el => el.textContent.includes(${JSON.stringify(FOLDER)}));
    if (!li) return 'NO_LI';
    const t = li.querySelector('div') || li;
    const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 }));
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
    return 'CLICKED';
  })()`).catch(e => 'ERR:' + e.message);
  await sleep(3000);
  const read = await evaluate(READ_JS).catch(() => ({ urls: [] }));
  const firstUrl = read.urls[0] || "";
  console.error("FIRST_URL:", firstUrl.slice(0, 160), "...");
  await evaluate(`(() => { const s = window['__dok_sig_capture']; if (s && s.restore) s.restore(); return true; })()`).catch(() => {});
  if (!firstUrl) { console.log(JSON.stringify({ error: "no_first_url" })); return; }

  const base = stripCursor(firstUrl);
  // 提取原始 cursor
  const origCursor = Number((firstUrl.match(/[?&]cursor=(\d+)/) || [])[1] || 0);

  async function fetchAt(cursor, label) {
    const sep = base.includes("?") ? "&" : "?";
    const url = `${base}${sep}cursor=${cursor}&count=20`;
    const data = await evaluate(`(async () => { try { const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' }); const j = await res.json(); const its = j?.aweme_list||j?.awemeList||j?.data?.aweme_list||j?.data?.awemeList||[]; return { n: its.length, has_more: j?.has_more, status_code: j?.status_code, cursor: j?.cursor, err: j?.status_msg||null }; } catch (e) { return { n: 0, err: String(e) }; } })()`).catch(() => ({ n: 0, err: "eval_fail" }));
    console.error(`  [${label}] cursor=${cursor} ->`, JSON.stringify(data));
    return data;
  }

  const out = {};
  out.origCursor = origCursor;
  out.baseline = await fetchAt(origCursor, "baseline(same url)");
  out.cursor0 = await fetchAt(0, "cursor=0 same sig");
  out.cursor20 = await fetchAt(20, "cursor=20 same sig");
  out.cursor40 = await fetchAt(40, "cursor=40 same sig");
  out.cursor100 = await fetchAt(100, "cursor=100 same sig");
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
