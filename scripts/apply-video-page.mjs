// 策略 A：逐视频详情页收集，绕开批量管理界面的虚拟化列表。
//
// 背景（见 经验技巧.md）：抖音批量管理界面靠虚拟化 + 无限滚动，深埋/已删视频的
// checkbox 根本不会被挂载出来，导致写入只能覆盖约 70%。而每条收藏的 source_url
// 是确定性的单视频页面（https://www.douyin.com/video/<aweme_id>），没有虚拟化。
// 本脚本对每条缺失视频：直达详情页 -> 探测可用性 -> 点收藏 -> 选目标夹 -> 校验，
// 全程真实 UI 点击，不碰 X-Bogus / 未公开接口 / 取消收藏 / 删除收藏夹。
//
// 安全红线：写入仍需 --execute --confirmation <token>（与 apply-browser.mjs 同一套
// 执行令牌机制），默认 dry-run。单视频逐页导航更易触发风控，故每条间隔 2~5s 随机抖动。
//
// 命令：
//   node scripts/apply-video-page.mjs inspect --run <dir>
//       只读，列出待处理视频与推导出的目标夹（不碰浏览器）
//   node scripts/apply-video-page.mjs probe --run <dir> [--id <aweme_id>]
//       只读，打开单个视频详情页并 dump 真实 DOM（用于校准选择器），不写
//   node scripts/apply-video-page.mjs apply --run <dir> [--limit N] [--dry-run]
//       逐页写入，需 --execute --confirmation <token>

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendJournal } from "../src/journal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
// 独立 session：与 apply-browser.mjs 的批量管理 session 隔离，避免互相抢窗口。
const SESSION_DEFAULT = "douyin-organizer-video-page";
let SESSION = SESSION_DEFAULT;

// 已删除/下架/审核中视频在详情页的常见提示文本（多关键词兜底，避免单一样式失效）。
// 这些文案可能随抖音版本变化，probe 命令会把页面真实文本一并 dump 出来供校准。
const UNAVAILABLE_PATTERN =
  /(视频不见了|视频不存在|内容不存在|作品已删除|该视频不存在|内容已删除|审核中|内容审核中|已失效|已删除|访问的内容不存在|作品不存在)/u;

// 目标夹占位名：unavailable 视频曾被归集到这个占位夹，其原始分类意图已丢失，不应擅自写入。
const UNHANDLED_FOLDER = "未处理（懒加载未渲染）";

function argsMap(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const key = value.slice(2).replaceAll("-", "_");
    const next = values[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function runOpencli(args, { json = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [OPENCLI, ...args], {
      cwd: ROOT,
      env: { ...process.env },
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`OpenCLI ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      if (!json) { resolve(stdout.trim()); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/u, ""))); }
      catch (error) { reject(new Error(`Could not parse OpenCLI JSON: ${error.message}; output=${stdout.slice(0, 500)}`)); }
    });
  });
}

const browser = (...args) => runOpencli(["browser", SESSION, ...args]);
const evaluate = js => browser("eval", js);
const wait = seconds => runOpencli(["browser", SESSION, "wait", "time", String(seconds)], { json: false });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureSession({ windowMode = "foreground" } = {}) {
  // 复用现有 session：先探测 bridge 是否活着；活着就继续，死了才 open。
  try {
    await evaluate("(() => 1 + 1)()");
    return;
  } catch {
    // bridge 未连接：open 一个视频页唤起（此处用占位页，实际流程会再 open 目标视频）
    await browser("open", "https://www.douyin.com/", "--window", windowMode);
    await wait(2);
  }
}

// 从 manifest 反查 aweme_id -> { title, source_url, folder }。
// unavailable-video-ids.json 的 folder 字段可能已被二次归集污染成「未处理」占位夹，
// 因此以 manifest.add_to_folders 为准；manifest 查不到时才退回 unavailable 条目的 folder。
function loadTargets(runDirectory) {
  const manifestFile = path.join(runDirectory, "apply-manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error(`apply-manifest.json not found: ${runDirectory}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const byId = new Map();
  for (const batch of manifest.add_to_folders || []) {
    for (const video of batch.videos || []) {
      byId.set(String(video.aweme_id), {
        aweme_id: String(video.aweme_id),
        title: video.title || "",
        source_url: video.source_url || `https://www.douyin.com/video/${video.aweme_id}`,
        folder: batch.folder,
      });
    }
  }

  const unavailableFile = path.join(runDirectory, "unavailable-video-ids.json");
  const entries = fs.existsSync(unavailableFile)
    ? (JSON.parse(fs.readFileSync(unavailableFile, "utf8")).entries || [])
    : [];

  const targets = [];
  for (const entry of entries) {
    const id = String(entry.aweme_id);
    const manifestHit = byId.get(id);
    const folder = manifestHit?.folder || entry.folder || "";
    targets.push({
      aweme_id: id,
      title: manifestHit?.title || entry.title || "",
      source_url: manifestHit?.source_url || `https://www.douyin.com/video/${id}`,
      folder,
      folderSource: manifestHit ? "manifest" : (entry.folder ? "unavailable-entry" : "none"),
    });
  }
  return { manifest, targets };
}

// 探测视频详情页状态。返回页面可见信息，供「是否存在 / 是否已收藏 / 收藏按钮长啥样」判断。
async function probeVideoPage() {
  return evaluate(`(() => {
    const visible = el => el && (el.offsetWidth || el.offsetHeight);
    const bodyText = document.body.innerText || '';
    const title = document.title || '';
    const attr = (el, name) => el?.getAttribute(name) || '';
    // 收藏/取消收藏：精确文本匹配
    const collectButtons = [...document.querySelectorAll('*')]
      .filter(el => visible(el) && (el.innerText || '').trim() === '收藏')
      .map(el => ({ tag: el.tagName, cls: attr(el, 'class').slice(0, 60), aria: attr(el, 'aria-label'), e2e: attr(el, 'data-e2e') || attr(el, 'data-testid') }));
    const uncollectButtons = [...document.querySelectorAll('*')]
      .filter(el => visible(el) && (el.innerText || '').trim() === '取消收藏')
      .map(el => ({ tag: el.tagName, cls: attr(el, 'class').slice(0, 60), aria: attr(el, 'aria-label') }));
    // 含「收藏」子串的可见元素（图标按钮文字可能带数字/被拆分）
    const collectSubstring = [...document.querySelectorAll('*')]
      .filter(el => visible(el) && (el.innerText || '').includes('收藏'))
      .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 20), cls: attr(el, 'class').slice(0, 60), aria: attr(el, 'aria-label'), e2e: attr(el, 'data-e2e') || attr(el, 'data-testid') }))
      .slice(0, 12);
    // aria-label 含「收藏」
    const ariaCollect = [...document.querySelectorAll('[aria-label]')]
      .filter(el => (attr(el, 'aria-label') || '').includes('收藏'))
      .map(el => ({ tag: el.tagName, aria: attr(el, 'aria-label'), cls: attr(el, 'class').slice(0, 60), e2e: attr(el, 'data-e2e') || attr(el, 'data-testid') }))
      .slice(0, 12);
    // data-e2e / data-testid 含收藏/collect/fav
    const e2eCollect = [...document.querySelectorAll('[data-e2e],[data-testid]')]
      .filter(el => /collect|fav|收藏/u.test(attr(el, 'data-e2e') + attr(el, 'data-testid')))
      .map(el => ({ tag: el.tagName, e2e: attr(el, 'data-e2e') || attr(el, 'data-testid'), aria: attr(el, 'aria-label'), text: (el.innerText || '').trim().slice(0, 20) }))
      .slice(0, 20);
    // 页面所有 iframe（视频/操作区可能藏在 iframe 里）
    const iframes = [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean).slice(0, 10);
    // 所有可见 button（含 role=button）文本，帮助识别操作栏
    const allButtons = [...document.querySelectorAll('button,[role=button]')]
      .filter(el => visible(el))
      .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 12), aria: attr(el, 'aria-label'), e2e: attr(el, 'data-e2e') || attr(el, 'data-testid') }))
      .slice(0, 30);
    const unavailable = /(视频不见了|视频不存在|内容不存在|作品已删除|该视频不存在|内容已删除|审核中|内容审核中|已失效|已删除|访问的内容不存在|作品不存在)/.test(bodyText);
    return {
      url: location.href,
      title,
      unavailable,
      bodyContainsCollect: bodyText.includes('收藏'),
      bodyTextSample: bodyText.slice(0, 300),
      collectButtonCount: collectButtons.length,
      collectButtons: collectButtons.slice(0, 5),
      uncollectButtonCount: uncollectButtons.length,
      uncollectButtons: uncollectButtons.slice(0, 3),
      collectSubstring,
      ariaCollect,
      e2eCollect,
      iframes,
      allButtons,
      hasLogin: bodyText.includes('登录'),
    };
  })()`);
}

// 点「收藏」按钮（真实 CDP 点击，抖音控件忽略 JS 合成 click 事件）。
// 精确定位：div[data-e2e="video-player-collect"]（抖音 web 收藏按钮，纯图标无文字）。
// 点击后可能直接快捷收藏（无弹窗），也可能弹收藏夹选择器，probe 会告诉我们。
async function clickCollectButton() {
  const clicked = await browser("click", '[data-e2e="video-player-collect"]');
  return { ...clicked, via: "data-e2e-cdp" };
}

// 探测收藏夹选择器弹窗（点收藏后出现的）。dump 目标夹是否可见、勾选控件、确认按钮。
async function probeCollectPicker(folder) {
  return evaluate(`(() => {
    const visible = el => el && (el.offsetWidth || el.offsetHeight);
    const bodyText = document.body.innerText || '';
    // 弹窗容器：role=dialog 或 class 含 modal/mask/popup/panel 的可见容器（抖音用 Semi Design）
    const dialogs = [...document.querySelectorAll('[role=dialog],.semi-modal,[class*=modal],[class*=mask],[class*=popup],[class*=panel]')]
      .filter(visible)
      .map(el => ({ cls: String(el.className || '').slice(0, 80), text: (el.innerText || '').trim().slice(0, 200) }))
      .slice(0, 10);
    // 目标夹行：文本含夹名
    const folderCandidates = [...document.querySelectorAll('*')]
      .filter(el => visible(el) && (el.innerText || '').trim() === ${JSON.stringify(folder)});
    // 目标夹元素向上遍历，找含 checkbox 的祖先层级（确认勾选控件的相对位置）
    const folderLeaf = [...folderCandidates].sort((a, b) => a.children.length - b.children.length)[0];
    const chain = [];
    let node = folderLeaf;
    for (let i = 0; i < 6 && node; i += 1) {
      chain.push({
        level: i,
        tag: node.tagName,
        cls: String(node.className || '').slice(0, 70),
        hasSemiCheck: !!node.querySelector?.('span.semi-checkbox'),
        hasInputCheck: !!node.querySelector?.('input[type=checkbox]'),
        childCount: node.children?.length || 0,
      });
      node = node.parentElement;
    }
    // 确认按钮候选（抖音不同场景用不同文案）
    const confirmButtons = [...document.querySelectorAll('button')]
      .filter(el => visible(el) && ['确定', '完成', '保存'].includes((el.innerText || '').trim()))
      .map(el => ({ text: el.innerText.trim(), disabled: !!el.disabled, cls: String(el.className || '').slice(0, 60) }));
    // 各类 checkbox 控件
    const semiCheckboxes = document.querySelectorAll('span.semi-checkbox').length;
    const nativeCheckboxes = document.querySelectorAll('input[type=checkbox]').length;
    const e2eChecks = [...document.querySelectorAll('[data-e2e],[data-testid]')]
      .filter(el => /check|select|pick|fold/u.test((el.getAttribute('data-e2e') || '') + (el.getAttribute('data-testid') || '')))
      .map(el => ({ e2e: el.getAttribute('data-e2e') || el.getAttribute('data-testid'), tag: el.tagName, text: (el.innerText || '').trim().slice(0, 16) }))
      .slice(0, 20);
    return {
      dialogCount: dialogs.length,
      dialogs,
      bodyHasFolderWord: bodyText.includes('收藏夹'),
      bodyHasNewFolderWord: bodyText.includes('新建收藏夹'),
      bodyHasCollectWord: bodyText.includes('已收藏') || bodyText.includes('取消收藏'),
      bodyTextSample: bodyText.slice(0, 500),
      folderTextMatches: folderCandidates.length,
      folderTag: folderCandidates[0]?.tagName || null,
      folderRowChain: chain,
      confirmButtons,
      semiCheckboxes,
      nativeCheckboxes,
      e2eChecks,
    };
  })()`);
}

// 轮询等待目标夹在收藏夹选择器里出现（弹窗列表已确认全量渲染，此函数仅作渲染时机兜底）。
async function waitForFolderInPicker(folder, { timeoutMs = 6000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(`(() => {
      const visible = el => el && (el.offsetWidth || el.offsetHeight);
      return [...document.querySelectorAll('*')]
        .some(el => visible(el) && (el.innerText || '').trim() === ${JSON.stringify(folder)});
    })()`);
    if (found) return true;
    await sleep(intervalMs);
  }
  return false;
}

// 在收藏夹选择器弹窗里勾选目标夹并确认。
// 已通过 probe 校准：目标夹名 SPAN 向上 2 层是含 span.semi-checkbox 的行容器；
// 确认按钮是「保存」（button.semi-button-primary）。勾选态用行内 input[type=checkbox].checked 判断。
// dryRun=true 时只定位+判断勾选态，不真正勾选/保存（供 dry-run 给出真实预测）。
async function pickFolderAndConfirm(folder, { dryRun = false } = {}) {
  // 0) 等待目标夹出现（弹窗列表已确认全量渲染，目标夹精确匹配应秒出；留 4s 兜底）
  const appeared = await waitForFolderInPicker(folder, { timeoutMs: 4000 });
  if (!appeared) {
    return { ok: false, reason: 'folder not in picker' };
  }

  // 1) 定位目标夹行（向上遍历找含 checkbox 的祖先），判断勾选态，标记 checkbox
  const marked = await evaluate(`(() => {
    const visible = el => el && (el.offsetWidth || el.offsetHeight);
    const candidates = [...document.querySelectorAll('*')]
      .filter(el => visible(el) && (el.innerText || '').trim() === ${JSON.stringify(folder)})
      .sort((a, b) => a.children.length - b.children.length); // 叶子优先
    if (candidates.length === 0) {
      // 诊断：目标夹是否在 DOM 里、是否可见（区分「需滚动/懒加载」vs「夹不存在」）
      const anyInDom = [...document.querySelectorAll('*')]
        .filter(el => (el.innerText || '').includes(${JSON.stringify(folder)}))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        .slice(0, 5)
        .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 40), visible: !!(el.offsetWidth || el.offsetHeight), cls: String(el.className || '').slice(0, 50) }));
      // 弹窗内滚动容器：scrollHeight > clientHeight 说明列表可滚、存在未展开项
      const scrollable = [...document.querySelectorAll('*')]
        .filter(el => el.scrollHeight > el.clientHeight + 5 && el.clientHeight > 0)
        .map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 60), clientHeight: el.clientHeight, scrollHeight: el.scrollHeight }))
        .slice(0, 5);
      return { ok: false, matches: 0, reason: 'folder not visible in picker', anyInDom, scrollable };
    }
    const leaf = candidates[0];
    let row = leaf;
    for (let i = 0; i < 6 && row; i += 1) {
      if (row.querySelector?.('span.semi-checkbox')) break;
      row = row.parentElement;
    }
    const control = row?.querySelector('span.semi-checkbox') || row?.querySelector('input[type=checkbox]');
    if (!control) return { ok: false, matches: candidates.length, reason: 'no checkbox in folder row' };
    const input = row?.querySelector('input[type=checkbox]');
    const alreadyChecked = !!(input?.checked) || control.classList?.contains('semi-checkbox-checked') || control.getAttribute('aria-checked') === 'true';
    control.setAttribute('data-organizer-folder-checkbox', 'video-page-destination');
    return { ok: true, controlTag: control.tagName, alreadyChecked };
  })()`);
  if (!marked.ok) return marked;
  if (marked.alreadyChecked) return { ok: true, alreadyCollected: true, skipped: true };
  if (dryRun) return { ok: true, alreadyChecked: false, dryRun: true, wouldCollect: true };

  // 2) 真实 CDP 点击勾选（抖音控件忽略 JS 合成 click）
  const clicked = await browser("click", '[data-organizer-folder-checkbox="video-page-destination"]');
  if (!clicked.clicked || clicked.matches_n !== 1) return { ok: false, reason: `checkbox click failed: ${JSON.stringify(clicked)}` };
  await wait(0.4);

  // 3) 点「保存」按钮（优先 semi-button-primary）
  const confirm = await evaluate(`(() => {
    const visible = el => el && (el.offsetWidth || el.offsetHeight);
    const btn = [...document.querySelectorAll('button')]
      .find(el => visible(el) && !el.disabled && (el.innerText || '').trim() === '保存')
      || [...document.querySelectorAll('button')]
      .find(el => visible(el) && !el.disabled && ['确定', '完成'].includes((el.innerText || '').trim()));
    if (!btn) return { ok: false, reason: 'no enabled save button' };
    btn.setAttribute('data-organizer-confirm', 'video-page-destination');
    return { ok: true, text: btn.innerText.trim() };
  })()`);
  if (!confirm.ok) return confirm;
  const confirmClick = await browser("click", '[data-organizer-confirm="video-page-destination"]');
  if (!confirmClick.clicked) return { ok: false, reason: `confirm click failed: ${JSON.stringify(confirmClick)}` };
  return { ok: true, confirmText: confirm.text, collected: true };
}

// 幂等打开收藏夹选择器并确认弹窗真的打开。
// 可靠标志：存在 span.semi-checkbox 且存在「保存」按钮（bodyText 含「收藏夹」不可靠，弹窗标题会变）。
// 先 ESC 清残留；再点收藏后轮询等待弹窗打开（最多 5s），避免「弹窗正在渲染就被误判未开」。
async function ensurePickerOpen() {
  await browser("keys", "Escape").catch(() => {});
  await wait(0.3);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await clickCollectButton();
    const deadline = Date.now() + 5000;
    let open = false;
    while (Date.now() < deadline) {
      const state = await evaluate(`(() => {
        const hasCheck = document.querySelectorAll('span.semi-checkbox').length > 0;
        const hasSave = [...document.querySelectorAll('button')].some(b => (b.offsetWidth || b.offsetHeight) && (b.innerText || '').trim() === '保存');
        return hasCheck && hasSave;
      })()`);
      if (state) { open = true; break; }
      await sleep(500);
    }
    if (open) return { ok: true, attempt };
    await browser("keys", "Escape").catch(() => {});
    await wait(0.3);
  }
  return { ok: false, reason: 'picker did not open after retries' };
}

// 关闭收藏夹选择器弹窗（ESC 键最通用），避免弹窗残留导致下一条 toggle 失效。
async function closeCollectPicker() {
  await browser("keys", "Escape").catch(() => {});
  await wait(0.3);
  return { ok: true, via: "esc" };
}

async function main() {
  const [command] = process.argv.slice(2);
  const args = argsMap(process.argv.slice(3));
  if (args.session && typeof args.session === "string" && args.session.trim()) {
    SESSION = args.session.trim();
  }

  if (command === "inspect") {
    if (!args.run) throw new Error("--run <directory> is required");
    const { targets } = loadTargets(path.resolve(String(args.run)));
    const missingFolder = targets.filter(t => !t.folder || t.folder === UNHANDLED_FOLDER);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      total: targets.length,
      resolvable: targets.length - missingFolder.length,
      lostFolder: missingFolder.map(t => t.aweme_id),
      sample: targets.slice(0, 10),
    }, null, 2)}\n`);
    return;
  }

  if (command === "probe") {
    if (!args.run) throw new Error("--run <directory> is required");
    const { targets } = loadTargets(path.resolve(String(args.run)));
    const target = args.id
      ? targets.find(t => t.aweme_id === String(args.id))
      : targets[0];
    if (!target) throw new Error("no target found to probe");
    await ensureSession();
    await browser("open", target.source_url, "--window", "foreground");
    await wait(3);
    const page = await probeVideoPage();
    process.stdout.write(`${JSON.stringify({ target, page }, null, 2)}\n`);
    const hasCollectButton = page.collectButtonCount > 0 || page.e2eCollect.length > 0;
    if (!page.unavailable && hasCollectButton) {
      // 点击前先探测是否有残留弹窗（上次 probe 可能没关）
      const preClick = await probeCollectPicker(target.folder);
      // 只读探测：点收藏看弹窗时序（弹窗可能延迟出现 / toggle 关闭）
      const clicked = await clickCollectButton();
      await wait(0.8);
      const pickerEarly = await probeCollectPicker(target.folder);
      await wait(1.5);
      const pickerLate = await probeCollectPicker(target.folder);
      process.stdout.write(`${JSON.stringify({ preClick, clickResult: clicked, pickerEarly, pickerLate }, null, 2)}\n`);
    }
    return;
  }

  if (command === "apply") {
    if (!args.run) throw new Error("--run <directory> is required");
    const runDirectory = path.resolve(String(args.run));
    const { manifest, targets } = loadTargets(runDirectory);
    const executionToken = `EXECUTE:${(manifest.plan_fingerprint || "").slice(0, 12)}`;
    const dryRun = args.dry_run !== false; // 默认 dry-run，显式 --dry-run=false 才真正写
    if (!dryRun && (args.execute !== true || args.confirmation !== executionToken)) {
      throw new Error(`Account writes require --execute --confirmation ${executionToken}`);
    }
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : targets.length;
    const pending = targets.slice(0, limit);

    await ensureSession();
    const results = [];
    for (let i = 0; i < pending.length; i += 1) {
      const target = pending[i];
      const label = `[${i + 1}/${pending.length}] ${target.aweme_id}`;
      if (!target.folder || target.folder === UNHANDLED_FOLDER) {
        process.stderr.write(`${label} SKIP (folder intent lost: "${target.folder || ""}")\n`);
        results.push({ aweme_id: target.aweme_id, status: "skipped", reason: "folder intent lost" });
        continue;
      }
      try {
        await browser("open", target.source_url, "--window", "foreground");
        await wait(2.5);
        const page = await probeVideoPage();
        if (page.unavailable) {
          process.stderr.write(`${label} UNAVAILABLE (${page.title || "deleted"})\n`);
          if (!dryRun) {
            appendJournal(runDirectory, {
              folder: target.folder,
              ids: [target.aweme_id],
              status: "unavailable",
              verifiedCount: 0,
              evidence: "video detail page shows deleted/unavailable",
            });
          }
          results.push({ aweme_id: target.aweme_id, status: "unavailable", folder: target.folder });
        } else if (!page.e2eCollect.some(e => e.e2e === "video-player-collect") && page.collectButtonCount === 0) {
          process.stderr.write(`${label} NO COLLECT BUTTON (page state unknown)\n`);
          results.push({ aweme_id: target.aweme_id, status: "unknown", reason: "no collect button", detail: page });
        } else {
          process.stderr.write(`${label} ${dryRun ? "DRY-RUN" : "collecting"} -> ${target.folder}\n`);
          // 幂等打开收藏夹选择器（残留则复用，不 toggle）
          await ensurePickerOpen();
          const picked = await pickFolderAndConfirm(target.folder, { dryRun });
          if (!picked.ok) {
            process.stderr.write(`${label}   FAIL: ${picked.reason || "unknown"} | anyInDom=${JSON.stringify(picked.anyInDom)} | scrollable=${JSON.stringify(picked.scrollable)}\n`);
            results.push({ aweme_id: target.aweme_id, status: "failed", reason: picked.reason, folder: target.folder, anyInDom: picked.anyInDom, scrollable: picked.scrollable });
          } else if (picked.alreadyCollected) {
            process.stderr.write(`${label}   ALREADY IN FOLDER (skip)\n`);
            results.push({ aweme_id: target.aweme_id, status: "already-collected", folder: target.folder });
          } else if (dryRun) {
            process.stderr.write(`${label}   WOULD COLLECT (dry-run)\n`);
            results.push({ aweme_id: target.aweme_id, status: "dry-run", folder: target.folder });
          } else {
            appendJournal(runDirectory, {
              folder: target.folder,
              ids: [target.aweme_id],
              status: "verified",
              verifiedCount: 1,
              evidence: "collected via video detail page picker",
            });
            process.stderr.write(`${label}   COLLECTED\n`);
            results.push({ aweme_id: target.aweme_id, status: "verified", folder: target.folder });
          }
          // 无论成功与否，关闭可能残留的弹窗，避免下一条 toggle 失效
          await closeCollectPicker().catch(() => {});
        }
      } catch (error) {
        process.stderr.write(`${label} ERROR: ${error.message}\n`);
        results.push({ aweme_id: target.aweme_id, status: "failed", reason: error.message, folder: target.folder });
        await closeCollectPicker().catch(() => {});
      }
      // 节流：逐页导航比批量管理更易触发风控，每条间隔 2~5s 随机抖动
      await wait(2 + Math.random() * 3);
    }

    const summary = {
      ok: true,
      dryRun,
      total: pending.length,
      verified: results.filter(r => r.status === "verified").length,
      alreadyCollected: results.filter(r => r.status === "already-collected").length,
      unavailable: results.filter(r => r.status === "unavailable").length,
      failed: results.filter(r => r.status === "failed").length,
      skipped: results.filter(r => r.status === "skipped").length,
      unknown: results.filter(r => r.status === "unknown").length,
      results,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!dryRun) {
      const outFile = path.join(runDirectory, "video-page-results.json");
      fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      process.stderr.write(`results written to ${outFile}\n`);
    }
    return;
  }

  throw new Error("Use inspect, probe, or apply");
}

process.on("unhandledRejection", reason => {
  process.stderr.write(`[UNHANDLED] ${reason?.stack || reason}\n`);
});
main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
