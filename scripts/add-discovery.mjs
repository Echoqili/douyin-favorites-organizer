// add-discovery.mjs —— 发现"加入收藏夹"的真实写接口。
// 打开一个视频页 -> 安装【全量】请求捕获（记录 method/url/body）-> 点击"收藏"按钮 ->
// 在弹出的收藏夹列表里点击某个夹 -> 读取捕获到的写请求（含 aweme_id / collects_id / 签名）。
// 仅用于发现，不写入任何数据。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const TEST_VIDEO = process.argv[2] || "7657024183007825192";
const TARGET_FOLDER = process.argv[3] || "AI与效率工具";

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
  const key = '__dok_add_cap';
  const state = { reqs: [], restore: null };
  const redact = (b) => { try { return typeof b === 'string' ? b.slice(0, 2000) : (b && typeof b === 'object' ? JSON.stringify(b).slice(0, 2000) : String(b || '')); } catch { return String(b || ''); } };
  const of = window.fetch, xp = XMLHttpRequest.prototype, oo = xp.open, os = xp.send;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ?? null;
    if (/aweme\\/v1\\/web/.test(String(url))) state.reqs.push({ type: 'fetch', method, url: String(url), body: redact(body) });
    return of.apply(this, arguments);
  };
  xp.open = function (m, u) { if (/aweme\\/v1\\/web/.test(String(u))) state.reqs.push({ type: 'xhr', method: String(m).toUpperCase(), url: String(u), body: '' }); Object.defineProperty(this, '__u', { value: u, writable: true, configurable: true }); return oo.apply(this, arguments); };
  xp.send = function (b) { const u = this.__u; if (/aweme\\/v1\\/web/.test(String(u))) { const r = state.reqs.find(x => x.url === u && x.body === ''); if (r) r.body = redact(b); } return os.apply(this, arguments); };
  state.restore = () => { window.fetch = of; xp.open = oo; xp.send = os; };
  Object.defineProperty(window, key, { value: state, writable: true, configurable: true, enumerable: false });
  return true;
})()`;

const READ_JS = `(() => (window['__dok_add_cap'] || {}).reqs || [])()`;

async function main() {
  console.error("[add] opening video", TEST_VIDEO);
  await browser("open", `https://www.douyin.com/video/${TEST_VIDEO}`, "--window", "foreground").catch(() => {});
  await sleep(5000);
  await evaluate(CAPTURE_JS).catch(() => {});

  // 点击"收藏"按钮（精确文本，避免误点"取消收藏"）
  const clickCollect = await evaluate(`(() => {
    const els = [...document.querySelectorAll('*')].filter(e => e.innerText?.trim() === '收藏' && (e.offsetWidth || e.offsetHeight) && e.children.length === 0);
    const t = els.at(-1);
    if (!t) return { clicked: false, found: els.length };
    const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 }));
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
    return { clicked: true };
  })()`).catch(e => ({ clicked: false, err: e.message }));
  console.error("[add] click 收藏:", JSON.stringify(clickCollect));
  await sleep(2500);

  // 在弹出的收藏夹列表里点击目标夹
  const clickFolder = await evaluate(`(() => {
    const items = [...document.querySelectorAll('*')].filter(e => e.innerText?.trim() === ${JSON.stringify(TARGET_FOLDER)} && (e.offsetWidth || e.offsetHeight));
    const t = items.at(-1);
    if (!t) return { clicked: false, found: items.length };
    const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 }));
    fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
    return { clicked: true };
  })()`).catch(e => ({ clicked: false, err: e.message }));
  console.error("[add] click folder:", JSON.stringify(clickFolder));
  await sleep(2500);

  const reqs = await evaluate(READ_JS).catch(() => []);
  // 只保留写相关（含 collects_id / aweme_id / add / collect）
  const writes = reqs.filter(r => /collects|favorite|collect|add/i.test(r.url) && !/video\\/list/.test(r.url));
  fs.writeFileSync(path.join(ROOT, "var", "runs", "add-discovery.json"), JSON.stringify({ captured_at: new Date().toISOString(), allReqs: reqs, writes }, null, 2));
  console.log(JSON.stringify({ total: reqs.length, writes }, null, 2));
  if (writes.length) console.error("[add] WRITE ENDPOINTS:\n" + writes.map(w => `  ${w.method} ${w.url}\n    body=${w.body}`).join("\n"));
}
main().catch(e => { console.error(e); process.exit(1); });
