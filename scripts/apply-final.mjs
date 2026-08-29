// apply-final.mjs —— 高效补齐缺失视频（一次管理态会话，深滚一次，逐夹提交）。
// 与旧 apply-browser.mjs 的区别：不每夹退出/重进管理态（避免 20min/夹 的重复深滚），
// 计数验证不导航（交给 enum2 接口捕获事后校验）。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";
const RUN_DIR = path.join(ROOT, "var", "runs", "final-apply");

// ---- 开放参数 ----
const LOAD_ATTEMPT_CAP = 1400;
const LOAD_STABLE_STOP = 160;
const MAX_RENDERED_CHECKBOXES = 6000;
const COOLDOWN_MS = 4000;
const DRY_RUN = process.argv.includes("--dry");

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
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const log = m => process.stderr.write(`[FINAL] ${m}\n`);

const mappingExpression = `(() => {
  const output = [];
  const pattern = new RegExp('video/(\\\\d{15,})');
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
    let current = checkbox;
    let resolved = '';
    for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
      const anchor = current.querySelector && current.querySelector('a[href*="video/"]');
      if (anchor) {
        const m = anchor.getAttribute('href') && anchor.getAttribute('href').match(pattern);
        if (m) { resolved = m[1]; break; }
      }
    }
    if (resolved) output.push({ id: resolved, checked: checkbox.checked });
  }
  return output;
})()`;

const cheapCount = "(() => document.querySelectorAll('input[type=checkbox]').length)()";
const scrollOnce = `(() => {
  const boxes = [...document.querySelectorAll('input[type=checkbox]')];
  const last = boxes.at(-1);
  last?.scrollIntoView({ block: 'end', inline: 'nearest' });
  const scrollers = [...document.querySelectorAll('*')].filter(element => {
    if (element.scrollHeight <= element.clientHeight + 80) return false;
    if (element.clientHeight < 150) return false;
    const overflow = getComputedStyle(element).overflowY;
    return overflow === 'auto' || overflow === 'scroll';
  });
  for (const scroller of scrollers) {
    scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, Math.floor(scroller.clientHeight * 0.6)));
  }
  return boxes.length;
})()`;

async function clickExactText(text) {
  const result = await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('*')]
      .filter(element => element.innerText?.trim() === ${JSON.stringify(text)} && (element.offsetWidth || element.offsetHeight));
    const target = candidates.find(element => element.children.length === 0) || candidates.at(-1);
    if (!target) return { clicked: false, matches: candidates.length };
    target.click();
    return { clicked: true, matches: candidates.length };
  })()`);
  if (!result.clicked) throw new Error(`Visible text control is missing: ${text}`);
  return result;
}

async function clickTab(id) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const r = await evaluate(`(() => {
      const tab = document.getElementById(${JSON.stringify(id)});
      if (!tab) return { clicked: false };
      const t = tab.querySelector('div') || tab;
      const fire = (ty, C) => t.dispatchEvent(new C(ty, { bubbles: true, composed: true, button: 0 }));
      fire('pointerdown', PointerEvent); fire('mousedown', MouseEvent); fire('pointerup', PointerEvent); fire('mouseup', MouseEvent); fire('click', MouseEvent);
      return { clicked: true };
    })()`);
    if (!r.clicked) { await wait(0.5); continue; }
    await wait(1.2);
    const selected = await evaluate(`(() => document.getElementById(${JSON.stringify(id)})?.getAttribute('aria-selected'))()`);
    if (selected === "true" || selected === true) return;
    await wait(0.5);
  }
  throw new Error(`Tab did not become selected: ${id}`);
}

async function enterManagement() {
  const onVideoPage = await evaluate("(() => location.href.includes('favorite_video'))()").catch(() => false);
  if (!onVideoPage) {
    await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground");
    await wait(2.5);
  }
  // 关键：URL 参数不等于 SPA 当前激活子标签（此前 enum2 把页面留在了"文件夹"标签，
  // 导致批量管理开在了文件夹列表上——14 行 checkbox 永不增长）。强制切到"视频"标签。
  await clickTab("semiTabvideo");
  const active = await evaluate("(() => document.body.innerText.includes('退出管理'))()").catch(() => false);
  if (active) { await clickExactText("退出管理"); await wait(0.8); }
  log("click 批量管理");
  await clickExactText("批量管理");
  await wait(1.0);
  let controls = null;
  for (let probe = 0; probe < 10; probe += 1) {
    controls = await evaluate("(() => ({exit:document.body.innerText.includes('退出管理'),add:document.body.innerText.includes('加入收藏夹'),cancel:document.body.innerText.includes('取消收藏')}))()").catch(() => null);
    if (controls && controls.exit && controls.add && controls.cancel) break;
    await wait(1.0);
  }
  if (!controls || !controls.exit || !controls.add || !controls.cancel) throw new Error(`Management controls changed: ${JSON.stringify(controls)}`);
  // sanity：视频列表管理态初始渲染约 11~24 个（视窗大小），文件夹列表管理态也是 ~14 行，
  // 初始数无法区分；真正的区分靠深滚后 mapped 是否增长（见 loadTargetIds 后的校验）。
  const initial = await evaluate(cheapCount);
  if (initial < 8) throw new Error(`Management list suspiciously small (checkboxes=${initial})`);
  log(`management mode ON, initial checkboxes=${initial}`);
}

async function loadTargetIds(targetIds) {
  let stable = 0, previous = -1, attempt = 0;
  let ids = new Set();
  let lastExtractedCount = -1;
  for (; attempt < LOAD_ATTEMPT_CAP; attempt += 1) {
    const count = await evaluate(cheapCount).catch(() => lastExtractedCount);
    // 数量变化时立即抽取；数量不变也每 3 轮抽取一次（虚拟化下 DOM 数量恒定但内容会换）
    if (count !== lastExtractedCount || attempt % 3 === 0) {
      const mapped = await evaluate(mappingExpression);
      for (const item of mapped) ids.add(item.id);
      lastExtractedCount = count;
      if (targetIds.every(id => ids.has(id))) {
        log(`all targets rendered at attempt=${attempt} mapped=${ids.size}`);
        return { available: targetIds.filter(id => ids.has(id)), mapped: ids.size, attempts: attempt + 1 };
      }
    }
    if (count === previous) stable += 1; else stable = 0;
    previous = count;
    if (count >= MAX_RENDERED_CHECKBOXES) { log(`hit MAX_RENDERED_CHECKBOXES=${count}`); break; }
    if (stable >= LOAD_STABLE_STOP) break;
    await evaluate(scrollOnce);
    await wait(0.5);
  }
  const final = await evaluate(mappingExpression).catch(() => []);
  ids = new Set(final.map(item => item.id));
  log(`deep-scroll done: mapped=${ids.size} targets present=${targetIds.filter(id => ids.has(id)).length}/${targetIds.length} attempts=${attempt}`);
  return { available: targetIds.filter(id => ids.has(id)), mapped: ids.size, attempts: attempt };
}

const targetCheckboxSelector = id => `[data-organizer-target="${id}"] input[type=checkbox]`;

async function selectTargetIds(targetIds) {
  const marked = await evaluate(`(() => {
    const targets = new Set(${JSON.stringify(targetIds)});
    const pattern = new RegExp('video/(\\\\d{15,})');
    const mapped = new Map();
    for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
      let current = checkbox;
      let resolved = '';
      for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
        const anchor = current.querySelector && current.querySelector('a[href*="video/"]');
        if (anchor) {
          const m = anchor.getAttribute('href') && anchor.getAttribute('href').match(pattern);
          if (m) { resolved = m[1]; break; }
        }
      }
      if (resolved && targets.has(resolved)) mapped.set(resolved, checkbox);
    }
    const missing = [...targets].filter(id => !mapped.has(id));
    if (missing.length) return { ok: false, error: 'missing', missing };
    for (const [id, checkbox] of mapped.entries()) {
      if (checkbox.checked) checkbox.click(); // 先取消既有勾选，保证状态干净
      checkbox.setAttribute('data-organizer-target', id);
    }
    return { ok: true, marked: mapped.size };
  })()`);
  if (!marked.ok) throw new Error(`Marking failed: ${JSON.stringify(marked)}`);
  for (const id of targetIds) {
    const checked = await browser("check", targetCheckboxSelector(id));
    if (!checked.checked || checked.matches_n !== 1) throw new Error(`Checkbox check failed for ${id}: ${JSON.stringify(checked)}`);
  }
  await wait(0.4);
  const verified = await evaluate(`(() => {
    const targets = new Set(${JSON.stringify(targetIds)});
    const pattern = new RegExp('video/(\\\\d{15,})');
    const checked = [];
    for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
      let current = checkbox;
      let resolved = '';
      for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
        const anchor = current.querySelector && current.querySelector('a[href*="video/"]');
        if (anchor) {
          const m = anchor.getAttribute('href') && anchor.getAttribute('href').match(pattern);
          if (m) { resolved = m[1]; break; }
        }
      }
      if (resolved && checkbox.checked) checked.push(resolved);
    }
    return { targetChecked: [...targets].filter(id => checked.includes(id)), allChecked: [...new Set(checked)] };
  })()`);
  if (verified.targetChecked.length !== targetIds.length || verified.allChecked.length !== targetIds.length) {
    throw new Error(`Selection mismatch: ${JSON.stringify(verified)}`);
  }
}

async function submitToFolder(folder) {
  await clickExactText("加入收藏夹");
  await wait(0.8);
  const chosen = await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('*')]
      .filter(element => element.innerText?.trim() === ${JSON.stringify(folder)} && (element.offsetWidth || element.offsetHeight));
    if (candidates.length !== 1) return { ok: false, error: 'missing or ambiguous folder', matches: candidates.length };
    const row = candidates[0].parentElement?.parentElement;
    const control = row?.querySelector('span.semi-checkbox');
    if (!control) return { ok: false, error: 'missing folder checkbox' };
    control.setAttribute('data-organizer-folder-checkbox', 'destination');
    return { ok: true };
  })()`);
  if (!chosen.ok) throw new Error(`Choose folder failed: ${JSON.stringify(chosen)}`);
  const folderClick = await browser("click", '[data-organizer-folder-checkbox="destination"]');
  if (!folderClick.clicked || folderClick.matches_n !== 1) throw new Error(`Folder checkbox click failed: ${JSON.stringify(folderClick)}`);
  await wait(0.4);
  const confirmation = await evaluate(`(() => {
    const destination = document.querySelector('[data-organizer-folder-checkbox="destination"] input[type=checkbox]');
    const buttons = [...document.querySelectorAll('button')]
      .filter(element => element.innerText.trim() === '确定' && (element.offsetWidth || element.offsetHeight));
    if (!destination?.checked || buttons.length !== 1 || buttons[0].disabled) {
      return { ready: false, destinationChecked: destination?.checked ?? false, matches: buttons.length };
    }
    buttons[0].setAttribute('data-organizer-confirm', 'destination');
    return { ready: true };
  })()`);
  if (!confirmation.ready) throw new Error(`Confirm ambiguous: ${JSON.stringify(confirmation)}`);
  const confirmClick = await browser("click", '[data-organizer-confirm="destination"]');
  if (!confirmClick.clicked || confirmClick.matches_n !== 1) throw new Error(`Confirm click failed: ${JSON.stringify(confirmClick)}`);
  await wait(1.5);
}

function appendJournal(entry) {
  fs.appendFileSync(path.join(RUN_DIR, "journal.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  // 1. 组装补齐计划
  const missingReport = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "_ai_classify_merged.json"), "utf8"));
  const UNREADABLE = new Set(["健身与运动", "内容创作与自媒体"]); // enum 读不到，用全量计划幂等补
  const addPlan = [];
  for (const f of missingReport.folders) {
    if (UNREADABLE.has(f.folder)) continue;
    if (f.missingIds.length) addPlan.push({ folder: f.folder, ids: f.missingIds.map(String) });
  }
  const planByFolder = {};
  for (const [vid, folder] of Object.entries(plan)) (planByFolder[folder] ||= []).push(String(vid));
  for (const folder of UNREADABLE) {
    const ids = planByFolder[folder] || [];
    if (ids.length) addPlan.push({ folder, ids, note: "unreadable-folder, full plan idempotent" });
  }
  const totalIds = addPlan.reduce((s, b) => s + b.ids.length, 0);
  log(`add plan: ${addPlan.length} folders, ${totalIds} videos`);
  if (DRY_RUN) { console.log(JSON.stringify(addPlan, null, 2)); return; }

  // 2. 进入管理态，深滚一次渲染
  await enterManagement();
  const unionIds = [...new Set(addPlan.flatMap(b => b.ids))];
  const avail = await loadTargetIds(unionIds);
  // 保险：深滚后 mapped 必须显著增长（视频列表可累计数千）或目标全部找到，
  // 否则说明滚的是错误列表（如文件夹行），绝不能提交。
  if (avail.mapped < 200 && avail.available.length < unionIds.length) {
    throw new Error(`Deep scroll did not render the video list (mapped=${avail.mapped}, targets=${avail.available.length}/${unionIds.length}) — aborting before submit`);
  }
  const availSet = new Set(avail.available);

  // 3. 逐夹提交（不退出管理态）
  const results = [];
  for (const b of addPlan) {
    const available = b.ids.filter(id => availSet.has(id));
    const unavailable = b.ids.filter(id => !availSet.has(id));
    const entry = { folder: b.folder, intended: b.ids.length, available: available.length, unavailable: unavailable.length, unavailableIds: unavailable, status: "skipped" };
    if (unavailable.length) recordUnavail(b.folder, unavailable);
    if (!available.length) {
      log(`${b.folder}: nothing rendered (all ${b.ids.length} unavailable) -> skip`);
      entry.status = "all-unavailable";
      appendJournal(entry); results.push({ folder: b.folder, status: entry.status });
      continue;
    }
    try {
      const before = await evaluate(cheapCount);
      await selectTargetIds(available);
      await submitToFolder(b.folder);
      const after = await evaluate(cheapCount);
      entry.status = "submitted";
      entry.renderedBefore = before; entry.renderedAfter = after;
      log(`${b.folder}: submitted ${available.length} (rendered ${before}->${after})`);
    } catch (e) {
      entry.status = "error";
      entry.error = String(e.message).slice(0, 300);
      log(`${b.folder}: ERROR ${e.message}`);
    }
    appendJournal(entry);
    results.push({ folder: b.folder, status: entry.status, available: available.length });
    await wait(COOLDOWN_MS / 1000);
  }
  // 4. 退出管理态
  try { await clickExactText("退出管理"); await wait(0.8); } catch (_) { await evaluate(`(() => { window.location.href = ${JSON.stringify(`${SELF_URL}&showSubTab=favorite_video`)}; return true; })()`).catch(() => {}); }
  fs.writeFileSync(path.join(RUN_DIR, "summary.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ results }, null, 2));
}

function recordUnavail(folder, ids) {
  const file = path.join(RUN_DIR, "unavailable.json");
  const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  doc[folder] = [...new Set([...(doc[folder] || []), ...ids.map(String)])];
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

main().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
