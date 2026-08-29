// probe-virtual.mjs —— 探测批量管理列表虚拟化行为：勾选状态是否跨滚动保留。
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";

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
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const log = m => process.stderr.write(`[PROBE] ${m}\n`);

const mappingExpression = `(() => {
  const output = [];
  const pattern = new RegExp('video/(\\\\d{15,})');
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
    let current = checkbox;
    let resolved = '';
    for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
      const anchor = current.querySelector && current.querySelector('a[href*="video/"]');
      if (anchor) { const m = anchor.getAttribute('href')?.match(pattern); if (m) { resolved = m[1]; break; } }
    }
    if (resolved) output.push({ id: resolved, checked: checkbox.checked });
  }
  return output;
})()`;

const scrollOnce = `(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')];
  boxes.at(-1)?.scrollIntoView({ block: 'end', inline: 'nearest' });
  for (const scroller of [...document.querySelectorAll('*')].filter(el => {
    if (el.scrollHeight <= el.clientHeight + 80 || el.clientHeight < 150) return false;
    const o = getComputedStyle(el).overflowY; return o === 'auto' || o === 'scroll';
  })) scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + 600);
  return true;
})()`;

async function enterManagement() {
  const onVideoPage = await evaluate("(() => location.href.includes('favorite_video'))()").catch(() => false);
  if (!onVideoPage) { await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground"); await wait(2.5); }
  const active = await evaluate("(() => document.body.innerText.includes('退出管理'))()").catch(() => false);
  if (active) {
    await evaluate(`(() => { const el = [...document.querySelectorAll('*')].find(e => e.innerText?.trim()==='退出管理' && (e.offsetWidth||e.offsetHeight)); el?.click(); return true; })()`);
    await wait(1);
  }
  await evaluate(`(() => { const el = [...document.querySelectorAll('*')].find(e => e.innerText?.trim()==='批量管理' && (e.offsetWidth||e.offsetHeight) && e.children.length===0); el?.click(); return true; })()`);
  await wait(1.5);
  const c = await evaluate("(() => ({exit:document.body.innerText.includes('退出管理'),add:document.body.innerText.includes('加入收藏夹')}))()").catch(() => null);
  log(`management=${JSON.stringify(c)}`);
}

async function main() {
  await enterManagement();
  // 1. 记录初始窗口
  const w0 = await evaluate(mappingExpression);
  log(`window0: ${w0.length} checkboxes, checked=${w0.filter(x=>x.checked).length}`);
  const targetId = w0[0]?.id;
  if (!targetId) { console.log(JSON.stringify({ error: "no checkboxes" })); return; }
  // 2. 勾选第一个
  await evaluate(`(() => { const cb=[...document.querySelectorAll('input[type=checkbox]')].find(c=>c.checked===false); cb?.click(); return true; })()`);
  await wait(0.5);
  const afterCheck = await evaluate(mappingExpression);
  log(`after check: checked=${afterCheck.filter(x=>x.checked).length}, checkedIds=${JSON.stringify(afterCheck.filter(x=>x.checked).map(x=>x.id))}`);
  // 3. 向下滚 12 轮（虚拟窗口移走）
  for (let i = 0; i < 12; i += 1) { await evaluate(scrollOnce); await wait(0.4); }
  const wMid = await evaluate(mappingExpression);
  log(`window-mid: ${wMid.length} checkboxes, checked=${wMid.filter(x=>x.checked).length}, stillHasTarget=${wMid.some(x=>x.id===targetId)}`);
  // 4. 滚回顶部
  for (let i = 0; i < 30; i += 1) {
    await evaluate(`(() => { for (const s of [...document.querySelectorAll('*')].filter(el => { if (el.scrollHeight <= el.clientHeight + 80 || el.clientHeight < 150) return false; const o = getComputedStyle(el).overflowY; return o==='auto'||o==='scroll'; })) s.scrollTop = 0; window.scrollTo(0,0); return true; })()`);
    await wait(0.3);
  }
  const wBack = await evaluate(mappingExpression);
  const targetNow = wBack.find(x => x.id === targetId);
  log(`window-top: ${wBack.length} checkboxes, target present=${!!targetNow}, target checked=${targetNow?.checked}`);
  console.log(JSON.stringify({
    window0Count: w0.length, targetId,
    checkedAfterClick: afterCheck.filter(x => x.checked).map(x => x.id),
    midCount: wMid.length, midChecked: wMid.filter(x => x.checked).length,
    backCount: wBack.length, targetStillChecked: targetNow?.checked ?? null,
  }, null, 2));
}
main().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
