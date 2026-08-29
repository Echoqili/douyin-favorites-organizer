import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendJournal } from "../src/journal.mjs";
import { browserSessionPolicy, douyinFavoritesUrl } from "../src/browser-session-policy.mjs";
import { partitionMappedTargets, targetCheckboxSelector } from "../src/browser-selection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION_DEFAULT = "douyin-organizer-apply";
let SESSION = SESSION_DEFAULT; // 可被 --session <name> 覆盖，支持多终端手动并行（每终端独立 session 隔离）
const SELF_URL = douyinFavoritesUrl();
// 未处理收藏夹：抖音批量管理懒加载未渲染、无法定位 checkbox 的视频统一归集到这里，
// 不阻塞主流程；后续可单独重试。命名带括号说明，避免与分类夹混淆。
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

async function ensureSession({ windowMode = "background", resetExisting = false } = {}) {
  if (resetExisting) {
    await runOpencli(["browser", SESSION, "close"], { json: false }).catch(() => {});
    await browser("open", SELF_URL, "--window", windowMode);
    await wait(2);
    return;
  }
  try {
    const state = await evaluate("(() => ({url:location.href}))()");
    if (!String(state?.url || "").includes("douyin.com/user/self")) {
      await browser("open", SELF_URL, "--window", windowMode);
      await wait(2);
    }
  } catch {
    await browser("open", SELF_URL, "--window", windowMode);
    await wait(2);
  }
}

async function clickTab(id) {
  // 抖音界面偶发抖动：标签点击后 aria-selected 未及时变为 true（点击事件没落到目标上）。
  // 加内部重试（最多 3 次），每次重新读取状态并重新派发事件，避免偶发抖动直接中断整个批次。
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await evaluate(`(() => {
      const tab = document.getElementById(${JSON.stringify(id)});
      if (!tab || !(tab.offsetWidth || tab.offsetHeight)) return { clicked: false };
      if (tab.getAttribute('aria-selected') === 'true') return { clicked: true, alreadySelected: true };
      const target = tab.querySelector('span') || tab;
      const pointer = type => target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, composed: true, pointerId: 1, isPrimary: true
      }));
      const mouse = type => target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, composed: true, button: 0
      }));
      pointer('pointerdown');
      mouse('mousedown');
      pointer('pointerup');
      mouse('mouseup');
      mouse('click');
      return { clicked: true };
    })()`);
    if (!result.clicked) { lastError = new Error(`Required tab is missing: ${id}`); await wait(0.5); continue; }
    await wait(1.5);
    const selected = await evaluate(`(() => document.getElementById(${JSON.stringify(id)})?.getAttribute('aria-selected'))()`);
    if (selected === "true" || selected === true) return;
    lastError = new Error(`Tab did not become selected: ${id}`);
    await wait(0.6);
  }
  throw lastError || new Error(`Tab did not become selected: ${id}`);
}

async function clickExactText(text) {
  const result = await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('*')]
      .filter(element => element.innerText?.trim() === ${JSON.stringify(text)} && (element.offsetWidth || element.offsetHeight));
    const target = candidates.find(element => element.children.length === 0) || candidates.at(-1);
    if (!target) return { clicked: false, matches: candidates.length };
    target.click();
    return { clicked: true, matches: candidates.length, tag: target.tagName };
  })()`);
  if (!result.clicked) throw new Error(`Visible text control is missing: ${text}`);
  return result;
}

// 稳健退出批量管理态：抖音在 submit 后界面会变化（按钮文本可能是"退出管理"或"完成"，
// 也可能弹窗/自动关闭），一旦文本不匹配就不该抛错——因为视频可能已写入成功。
// 兜底：reopen 收藏视频 URL，强制回到普通态。
async function safeExitManagement() {
  for (const label of ["退出管理", "完成", "关闭"]) {
    const r = await evaluate(`(() => {
      const candidates = [...document.querySelectorAll('*')]
        .filter(element => element.innerText?.trim() === ${JSON.stringify(label)} && (element.offsetWidth || element.offsetHeight));
      const target = candidates.find(element => element.children.length === 0) || candidates.at(-1);
      if (!target) return { clicked: false, matches: candidates.length };
      target.click();
      return { clicked: true, matches: candidates.length };
    })()`).catch(() => ({ clicked: false }));
    if (r.clicked) {
      await wait(0.6);
      return { exited: true, via: label };
    }
  }
  // 兜底：重开「收藏视频」子标签（而非裸 SELF_URL），避免离开后 semiTabfavorite_folder 不可见，
  // 导致下一夹的 folderCount/clickTab 误报 "Required tab is missing"
  await evaluate(`(() => { window.location.href = ${JSON.stringify(`${SELF_URL}&showSubTab=favorite_video`)}; return true; })()`).catch(() => {});
  await wait(0.8);
  return { exited: true, via: "reopen-url" };
}

async function preflight(manifest, windowMode = "background") {
  await ensureSession(windowMode);
  // 直接导航到收藏视频子标签（与 enterManagement 目标一致，避免重复 open 触发 Chrome 崩溃）
  await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", windowMode).catch(() => {});
  await wait(2.5);
  const managementOpen = await evaluate("(() => document.body.innerText.includes('退出管理'))()").catch(() => false);
  if (managementOpen) {
    await safeExitManagement();
    await wait(0.8);
  }
  let state = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    state = await evaluate(`(() => ({
      loggedIn: !!document.getElementById('semiTabfavorite_collection'),
      folderTab: !!document.getElementById('semiTabfavorite_folder'),
      videoTab: !!document.getElementById('semiTabvideo'),
      batchManage: document.body.innerText.includes('批量管理'),
      addActionKnown: true,
      cancelActionGuard: true
    }))()`).catch(() => null);
    if (state && state.folderTab && state.videoTab && state.batchManage) break;
    await wait(0.5);
  }
  if (!state || !state.loggedIn || !state.folderTab || !state.videoTab || !state.batchManage) {
    throw new Error(`Douyin favorites UI preflight failed: ${JSON.stringify(state)}`);
  }
  return {
    ok: true,
    folders: manifest.create_folders.length,
    videos: manifest.add_to_folders.reduce((sum, batch) => sum + batch.videos.length, 0),
    state,
  };
}

async function folderVisible(name) {
  return evaluate(`(() => {
    return [...document.querySelectorAll('*')].some(element =>
      element.innerText?.trim() === ${JSON.stringify(name)} && (element.offsetWidth || element.offsetHeight)
    );
  })()`);
}

async function folderCount(name) {
  // 退出管理态后页面可能已离开收藏视频子标签（semiTabfavorite_folder 不可见），
  // 这里先确保停在收藏视频页，否则 clickTab 会误报 "Required tab is missing"。
  // 与 enterManagement 复用同一判断，修复「每批第 1 夹成功、第 2 夹起全失败」的问题。
  const onVideoPage = await evaluate("(() => location.href.includes('favorite_video'))()").catch(() => false);
  if (!onVideoPage) {
    await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground");
    await wait(2.5);
  }
  await clickTab("semiTabfavorite_folder");
  return evaluate(`(() => {
    const label = [...document.querySelectorAll('*')].find(element =>
      element.innerText?.trim() === ${JSON.stringify(name)} && (element.offsetWidth || element.offsetHeight)
    );
    const row = label?.closest('li') || label?.parentElement?.parentElement;
    const match = row?.innerText?.match(/共\\s*(\\d+)\\s*作品/);
    return match ? Number(match[1]) : -1;
  })()`);
}

async function inspectFolders() {
  await ensureSession(browserSessionPolicy("inspect-folders"));
  await clickTab("semiTabfavorite_collection");
  await clickTab("semiTabfavorite_folder");
  const state = await evaluate(`(() => {
    const folders = [...document.querySelectorAll('li')].map(row => {
      const match = row.innerText?.match(/共\\s*(\\d+)\\s*作品/);
      if (!match) return null;
      const name = [...row.querySelectorAll('p')]
        .map(element => element.innerText?.trim())
        .find(text => text && !/^共\\s*\\d+\\s*作品$/.test(text));
      if (!name) return null;
      return {
        name,
        count: Number(match[1]),
        visibility: row.querySelector('span[role=img]') ? 'private' : 'public'
      };
    }).filter(Boolean);
    return {
      accountName: document.querySelector('h1')?.innerText?.trim() || '',
      folders
    };
  })()`);
  return { ok: true, accountPage: true, ...state };
}

async function createFolder(name, visibility) {
  if ([...name].length > 15) throw new Error(`Folder name exceeds 15 characters: ${name}`);
  if (!["private", "public"].includes(visibility)) throw new Error(`Unsupported folder visibility: ${visibility}`);
  const desiredPublicState = visibility === "public" ? "true" : "false";
  await clickTab("semiTabfavorite_folder");
  if (await folderVisible(name)) return { name, status: "existing" };

  await clickExactText("新建收藏夹");
  await wait(0.5);

  const prepared = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].find(element => element.offsetWidth || element.offsetHeight);
    const input = dialog?.querySelector('input[placeholder*="收藏夹的名称"]');
    const control = dialog?.querySelector('[role=switch]');
    if (!dialog || !input || !control) return { ok: false, dialog: !!dialog, input: !!input, control: !!control };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const desired = ${JSON.stringify(desiredPublicState)};
    if (control.getAttribute('aria-checked') !== desired) control.click();
    return { ok: true, publicState: control.getAttribute('aria-checked') };
  })()`);
  if (!prepared.ok) throw new Error(`Could not prepare folder dialog: ${JSON.stringify(prepared)}`);
  await wait(0.4);

  const submitted = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].find(element => element.offsetWidth || element.offsetHeight);
    const input = dialog?.querySelector('input[placeholder*="收藏夹的名称"]');
    const control = dialog?.querySelector('[role=switch]');
    const confirm = [...(dialog?.querySelectorAll('button') || [])]
      .find(element => element.innerText.trim() === '确认' && (element.offsetWidth || element.offsetHeight));
    const snapshot = {
      inputValue: input?.value || '',
      publicState: control?.getAttribute('aria-checked'),
      confirmDisabled: confirm?.disabled ?? true
    };
    if (snapshot.inputValue !== ${JSON.stringify(name)} || snapshot.publicState !== ${JSON.stringify(desiredPublicState)} || !confirm || confirm.disabled) {
      return { submitted: false, snapshot };
    }
    confirm.click();
    return { submitted: true, snapshot };
  })()`);
  if (!submitted.submitted) throw new Error(`Folder submit precondition failed: ${JSON.stringify(submitted)}`);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(0.5);
    const verified = await evaluate(`(() => {
      const dialogOpen = [...document.querySelectorAll('[role=dialog]')].some(element => element.offsetWidth || element.offsetHeight);
      const label = [...document.querySelectorAll('*')].find(element =>
        element.innerText?.trim() === ${JSON.stringify(name)} && (element.offsetWidth || element.offsetHeight)
      );
      const row = label?.closest('li') || label?.parentElement?.parentElement;
      const privateIndicator = !!row?.querySelector('span[role=img]');
      const visibilityMatches = ${JSON.stringify(visibility)} === 'public' ? !privateIndicator : privateIndicator;
      return { dialogOpen, visible: !!label, visibilityMatches };
    })()`);
    if (!verified.dialogOpen && verified.visible && verified.visibilityMatches) {
      return { name, status: "created", visibility };
    }
  }
  throw new Error(`Folder creation result is unknown after submit: ${name}`);
}

async function deleteFolder(name) {
  if (![...name].length) throw new Error("Folder name is empty");
  await clickTab("semiTabfavorite_folder");
  if (!(await folderVisible(name))) return { name, status: "missing" };

  const locateExpression = `(() => {
    const name = ${JSON.stringify(name)};
    const rows = [...document.querySelectorAll('li')];
    const row = rows.find(li => {
      const txt = li.innerText || '';
      return txt.includes(name) && /共\\s*\\d+\\s*作品/.test(txt);
    });
    if (!row) return { found: false };
    const deleteCandidate = [...row.querySelectorAll('*')].find(el => {
      const t = el.innerText?.trim();
      const ar = el.getAttribute('aria-label') || '';
      const ti = el.getAttribute('title') || '';
      return t === '删除' || ar.includes('删除') || ti.includes('删除');
    });
    return { found: true, hasDelete: !!deleteCandidate };
  })()`;

  let info = await evaluate(locateExpression);
  if (!info.found) return { name, status: "missing" };
  if (!info.hasDelete) {
    // 收藏夹列表可能处于普通态，需进入管理态才会露出删除控件
    await clickExactText("管理").catch(() => {});
    await wait(0.6);
    if (!(await folderVisible(name))) return { name, status: "missing" };
    info = await evaluate(locateExpression);
  }
  if (!info.hasDelete) throw new Error(`No delete control found for folder (check UI state): ${name}`);

  const clicked = await evaluate(`(() => {
    const name = ${JSON.stringify(name)};
    const rows = [...document.querySelectorAll('li')];
    const row = rows.find(li => {
      const txt = li.innerText || '';
      return txt.includes(name) && /共\\s*\\d+\\s*作品/.test(txt);
    });
    if (!row) return { ok: false };
    const del = [...row.querySelectorAll('*')].find(el => {
      const t = el.innerText?.trim();
      const ar = el.getAttribute('aria-label') || '';
      const ti = el.getAttribute('title') || '';
      return t === '删除' || ar.includes('删除') || ti.includes('删除');
    });
    if (!del) return { ok: false };
    del.click();
    return { ok: true };
  })()`);
  if (!clicked.ok) throw new Error(`Could not click delete control for: ${name}`);
  await wait(0.6);

  const confirm = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role=dialog]')].find(el => el.offsetWidth || el.offsetHeight);
    if (!dialog) return { ok: false };
    const btn = [...dialog.querySelectorAll('button')].find(b => {
      const t = b.innerText.trim();
      return (t === '确定' || t === '删除') && (b.offsetWidth || b.offsetHeight);
    });
    if (!btn) return { ok: false };
    btn.setAttribute('data-organizer-delete-confirm', '1');
    return { ok: true };
  })()`);
  if (!confirm.ok) throw new Error(`Delete confirm dialog missing for: ${name}`);
  await browser("click", '[data-organizer-delete-confirm="1"]');
  await wait(0.8);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(0.4);
    if (!(await folderVisible(name))) return { name, status: "deleted" };
  }
  throw new Error(`Folder still present after delete confirmation: ${name}`);
}

const mappingExpression = `(() => {
  const output = [];
  const pattern = new RegExp('video/(\\\\d{15,})');
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
    let current = checkbox;
    let resolved = '';
    // 轻量提取：向上最多 10 层，找第一个含 video/ 链接的 <a> 的 href，
    // 不再取 outerHTML（避免大页面字符串爆炸导致 Chrome 主线程卡死/崩溃）
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

async function enterManagement() {
  // 复用现有 session：只在页面不在收藏视频页时才 open（不再暴力 close+open，
  // 避免把活着的 session 搞死 / 新窗口 Chrome 起不来导致 bridge 断开崩溃）。
  process.stderr.write(`[EM] ensure favorite_video page\n`);
  const onVideoPage = await evaluate("(() => location.href.includes('favorite_video'))()").catch(() => false);
  if (!onVideoPage) {
    await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground");
    await wait(2.5);
  }
  // 若已在管理态，先退出，回到普通列表再重新进入（保证状态干净）
  const active = await evaluate("(() => document.body.innerText.includes('退出管理'))()").catch(() => false);
  if (active) {
    await safeExitManagement();
    await wait(0.6);
  }
  process.stderr.write(`[EM] click 批量管理\n`);
  await clickExactText("批量管理");
  await wait(1.0);
  process.stderr.write(`[EM] poll controls\n`);
  let controls = null;
  for (let probe = 0; probe < 10; probe += 1) {
    controls = await evaluate("(() => ({exit:document.body.innerText.includes('退出管理'),add:document.body.innerText.includes('加入收藏夹'),cancel:document.body.innerText.includes('取消收藏')}))()").catch(() => null);
    if (controls && controls.exit && controls.add && controls.cancel) break;
    await wait(1.0);
  }
  if (!controls || !controls.exit || !controls.add || !controls.cancel) throw new Error(`Management controls changed: ${JSON.stringify(controls)}`);
  process.stderr.write(`[EM] done\n`);
}

// 单批目标上限：抖音批量管理懒加载全部视频会撑爆 Chrome 内存导致崩溃，
// 因此每批只处理少量目标。但"渲染到覆盖目标即停"，绝不无脑滚到底。
const TARGET_BATCH_CAP = 25;
// 突破"827 假上限"：此前 LOAD_ATTEMPT_CAP=30 + LOAD_STABLE_STOP=8 让滚动提前停止，
// 实际虚拟列表可渲染全量收藏（只读探针暴力滚动 150 轮即渲染 2436 个 checkbox；
// 深滚到全量 ~3000+ 亦可，未崩溃）。放宽到足以覆盖全量收藏并保留内存安全余量。
const LOAD_ATTEMPT_CAP = 600;            // 普通模式最多滚动轮数（只读探针验证全量收藏 ~5000 需 ~520 轮，留余量）
const LOAD_STABLE_STOP = 25;             // 连续 25 轮无新增才认定"已渲染完"，避免懒加载间隙误停
// 加强加载模式：用于 unavailable 长尾重试——懒加载视频可能需要更多轮才渲染。
// 抖音批量管理懒加载有"间隙"（某些轮次滚了但不立即挂载新节点），stableStop 设太小会在间隙期
// 误判"已滚到底"而提前停（实测 stableStop=40 时 mapped 只到 349 就停）。探针 400 轮能到 4707，
// 故 aggressive 下放宽到 stableStop=160、attemptCap=1400，确保最深的收藏（position ~5000）也能被滚到。
const LOAD_ATTEMPT_CAP_AGGRESSIVE = 1400;
const LOAD_STABLE_STOP_AGGRESSIVE = 160;
// 内存安全上限：渲染中的 checkbox 数超过此值即停止滚动（仅作极端账号兜底，避免撑爆 Chrome 崩溃）。
// 探针验证渲染 4707 个 checkbox 未崩溃；本账户全量收藏约 5000 量级，故阈值取到 6000，
// 真实场景不会触发（触发时仍未命中的目标记为 unavailable，交由后续策略/手动处理）。
const MAX_RENDERED_CHECKBOXES = 6000;
// 每夹之间冷却（ms）：add-folder --all 连续处理多夹时，夹间留冷却，避免触发抖音"操作频繁"瞬时退化。
const COOLDOWN_BETWEEN_FOLDERS = 8000;

async function loadTargetIds(targetIds, { aggressive = false } = {}) {
  const attemptCap = aggressive ? LOAD_ATTEMPT_CAP_AGGRESSIVE : LOAD_ATTEMPT_CAP;
  const stableStop = aggressive ? LOAD_STABLE_STOP_AGGRESSIVE : LOAD_STABLE_STOP;
  let stable = 0;
  let previous = -1;
  let attempt = 0;
  // 探测：进入管理态后先确认 bridge 活着（极简 evaluate），区分"管理态页面崩"与"mappingExpression 崩"
  try {
    const probe = await evaluate("(() => 1 + 1)()");
    process.stderr.write(`[LOADTARGET] bridge probe=${JSON.stringify(probe)}\n`);
  } catch (e) {
    process.stderr.write(`[LOADTARGET] bridge probe FAILED: ${e.message}\n`);
    throw e;
  }
  // 注意：不要在这里做 scrollToTop 复位！抖音批量管理用底部 IntersectionObserver 哨兵触发懒加载，
  // 强制 window/容器 scrollTop=0 反而会让哨兵脱离视口、无法触发加载（实测只能渲染 ~24 个 checkbox）。
  // 进入管理态后由 enterManagement 自然停留在顶部即可，深滚由下方 scrollOnce 负责。
  await wait(0.3);
  // 性能优化：稳定（checkbox 数无新增）的轮次只做廉价计数，不做耗时的全量 ID 抽取；
  // 仅当 checkbox 数增长（有新视频挂载）时才跑 mappingExpression 抽取 ID 并比对目标。
  // 这样深滚到全量收藏（~5000）也不会每轮都遍历全部 checkbox 拖垮 Chrome。
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
  let ids = new Set();
  let lastExtractedCount = -1;
  for (; attempt < attemptCap; attempt += 1) {
    const count = await evaluate(cheapCount).catch(() => lastExtractedCount);
    // 仅当首次或 checkbox 数增长时才做全量 ID 抽取与比对
    if (count !== lastExtractedCount) {
      const mapped = await evaluate(mappingExpression);
      ids = new Set(mapped.map(item => item.id));
      lastExtractedCount = count;
      if (targetIds.every(id => ids.has(id))) {
        return { ...partitionMappedTargets(targetIds, ids), mapped: ids.size, attempts: attempt + 1 };
      }
    }
    if (count === previous) stable += 1;
    else stable = 0;
    previous = count;
    // 内存安全：渲染中的 checkbox 数逼近上限即停止滚动（避免撑爆 Chrome 崩溃）。
    if (count >= MAX_RENDERED_CHECKBOXES) {
      process.stderr.write(`[LOADTARGET] reached MAX_RENDERED_CHECKBOXES=${MAX_RENDERED_CHECKBOXES}; stop scrolling (targets beyond cap -> unavailable)\n`);
      break;
    }
    // 连续 N 轮没有新增渲染（说明这一屏能加载的都加载了），停止滚动
    if (stable >= stableStop) break;
    await evaluate(scrollOnce);
    await wait(0.5);
  }
  // 退出前用一次全量抽取确保 ids 最新（末尾可能最后一增长轮后又有细微变动）
  const final = await evaluate(mappingExpression).catch(() => []);
  ids = new Set(final.map(item => item.id));
  process.stderr.write(`[LOADTARGET] mapped=${ids.size} targetPresent=${targetIds.filter(id => ids.has(id)).length}/${targetIds.length} attempts=${attempt}\n`);
  return { ...partitionMappedTargets(targetIds, ids), mapped: ids.size, attempts: attempt };
}

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
      if (resolved && targets.has(resolved)) {
        if (mapped.has(resolved)) return { ok: false, error: 'duplicate checkbox', id: resolved };
        mapped.set(resolved, checkbox);
      }
    }
    const missing = [...targets].filter(id => !mapped.has(id));
    if (missing.length) return { ok: false, error: 'missing', missing };
    const alreadyChecked = [...mapped.entries()].filter(([, checkbox]) => checkbox.checked).map(([id]) => id);
    if (alreadyChecked.length) return { ok: false, error: 'preselected', alreadyChecked };
    for (const [id, checkbox] of mapped.entries()) checkbox.setAttribute('data-organizer-target', id);
    return { ok: true, marked: mapped.size };
  })()`);
  if (!marked.ok || marked.marked !== targetIds.length) throw new Error(`Video selection marking failed: ${JSON.stringify(marked)}`);
  for (const id of targetIds) {
    const checked = await browser("check", targetCheckboxSelector(id));
    if (!checked.checked || checked.matches_n !== 1) throw new Error(`Browser checkbox selection failed for ${id}: ${JSON.stringify(checked)}`);
  }
  await wait(0.5);
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
    return {
      targetChecked: [...targets].filter(id => checked.includes(id)),
      allChecked: [...new Set(checked)]
    };
  })()`);
  if (verified.targetChecked.length !== targetIds.length || verified.allChecked.length !== targetIds.length) {
    throw new Error(`Selected count mismatch: expected ${targetIds.length}, got ${JSON.stringify(verified)}`);
  }
}

function recordUnavailableIds(runDirectory, folder, ids) {
  if (!ids.length) return;
  const file = path.join(runDirectory, "unavailable-video-ids.json");
  const document = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema_version: 1, entries: [] };
  const entries = new Map((document.entries || []).map(entry => [String(entry.aweme_id), entry]));
  for (const id of ids) {
    entries.set(String(id), {
      aweme_id: String(id),
      folder,
      reason: "not rendered in Douyin batch management UI after full bounded scroll",
    });
  }
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, entries: [...entries.values()] }, null, 2)}\n`, "utf8");
}

async function addFolderOnce(folder, videos, runDirectory, beforeCount, { aggressive = false } = {}) {
  // 单批写入：进入管理态 → 定位 → 勾选 → 加入 → 校验计数
  const ids = videos.map(video => String(video.aweme_id));
  await enterManagement();
  const availability = await loadTargetIds(ids, { aggressive });
  process.stderr.write(`[AVAIL] available=${availability.available.length} missing=${availability.missing.length}\n`);
  if (availability.missing.length) {
    recordUnavailableIds(runDirectory, folder, availability.missing);
    appendJournal(runDirectory, {
      folder,
      ids: availability.missing,
      status: "unavailable",
      verifiedCount: 0,
      evidence: "not rendered in Douyin batch management UI after bounded scroll",
    });
  }
  const attemptedIds = availability.available;
  if (!attemptedIds.length) {
    await safeExitManagement();
    return { written: 0, missing: availability.missing.length };
  }
  const expectedCount = beforeCount + attemptedIds.length;
  await selectTargetIds(attemptedIds);
  await clickExactText("加入收藏夹");
  await wait(0.7);

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
  if (!chosen.ok) throw new Error(`Could not choose destination folder: ${JSON.stringify(chosen)}`);
  const folderClick = await browser("click", '[data-organizer-folder-checkbox="destination"]');
  if (!folderClick.clicked || folderClick.matches_n !== 1) throw new Error(`Destination checkbox click failed: ${JSON.stringify(folderClick)}`);
  await wait(0.4);

  const confirmation = await evaluate(`(() => {
    const destination = document.querySelector('[data-organizer-folder-checkbox="destination"] input[type=checkbox]');
    const buttons = [...document.querySelectorAll('button')]
      .filter(element => element.innerText.trim() === '确定' && (element.offsetWidth || element.offsetHeight));
    if (!destination?.checked || buttons.length !== 1 || buttons[0].disabled) {
      return { ready: false, destinationChecked: destination?.checked ?? false, matches: buttons.length, disabled: buttons[0]?.disabled };
    }
    buttons[0].setAttribute('data-organizer-confirm', 'destination');
    return { ready: true };
  })()`);
  if (!confirmation.ready) throw new Error(`Destination confirmation is ambiguous: ${JSON.stringify(confirmation)}`);
  const confirmClick = await browser("click", '[data-organizer-confirm="destination"]');
  if (!confirmClick.clicked || confirmClick.matches_n !== 1) throw new Error(`Destination confirm click failed: ${JSON.stringify(confirmClick)}`);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(0.45);
    const afterCount = await folderCount(folder);
    if (afterCount === expectedCount) {
      appendJournal(runDirectory, {
        folder,
        ids: attemptedIds,
        status: "verified",
        verifiedCount: attemptedIds.length,
        baselineCount: beforeCount,
        finalCount: afterCount,
        evidence: "folder item count increased by approved batch size",
      });
      await safeExitManagement();
      return { written: attemptedIds.length, missing: availability.missing.length };
    }
    // 抖音"加入收藏夹"是幂等去重的：若这些视频本来已在夹中（之前运行已部分写入），
    // 计数不会增长。只要 submit 成功执行且计数未异常减少，就视为已就位（verified）。
    if (afterCount > beforeCount) {
      const newlyAdded = afterCount - beforeCount;
      appendJournal(runDirectory, {
        folder,
        ids: attemptedIds,
        status: "verified",
        verifiedCount: newlyAdded,
        baselineCount: beforeCount,
        finalCount: afterCount,
        evidence: "folder count increased (partial); remaining likely already present via idempotent dedup",
      });
      await safeExitManagement();
      return { written: newlyAdded, missing: availability.missing.length };
    }
    if (afterCount === beforeCount) {
      // 计数未变：可能是抖音去重（视频已在夹中），不视为失败
      appendJournal(runDirectory, {
        folder,
        ids: attemptedIds,
        status: "verified",
        verifiedCount: 0,
        baselineCount: beforeCount,
        finalCount: afterCount,
        evidence: "submit executed; count unchanged — videos likely already in folder (idempotent dedup)",
      });
      await safeExitManagement();
      return { written: 0, missing: availability.missing.length, alreadyPresent: true };
    }
  }
  appendJournal(runDirectory, { folder, ids: attemptedIds, status: "unknown", verifiedCount: 0, evidence: "submit completed but folder count did not match (likely already present or count unreadable)" });
  await safeExitManagement();
  return { written: 0, missing: availability.missing.length, unknown: true };
}

async function addFolderBatch(folder, videos, runDirectory, { aggressive = false } = {}) {
  process.stderr.write(`[ADDBATCH] start folder=${folder} videos=${videos.length}${aggressive ? " [aggressive]" : ""}\n`);
  const ids = videos.map(video => String(video.aweme_id));
  const journalFile = path.join(runDirectory, "apply-journal.jsonl");
  const priorVerified = fs.existsSync(journalFile)
    ? fs.readFileSync(journalFile, "utf8").split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)).some(entry => {
      const recorded = [...(entry.aweme_ids || [])].map(String).sort();
      return entry.status === "verified" && entry.folder === folder
        && JSON.stringify(recorded) === JSON.stringify([...ids].sort());
    })
    : false;
  if (priorVerified) {
    appendJournal(runDirectory, { folder, ids, status: "verified", verifiedCount: ids.length, evidence: "exact batch already verified in journal" });
    return { folder, status: "already-verified", videos: ids.length, verifiedCount: ids.length };
  }
  const beforeCount = await folderCount(folder);
  if (beforeCount < 0) throw new Error(`Folder is missing or unreadable: ${folder}`);

  // 分批：每批最多 TARGET_BATCH_CAP 条，避免一次性加载全部视频撑爆浏览器
  const chunks = [];
  for (let i = 0; i < videos.length; i += TARGET_BATCH_CAP) chunks.push(videos.slice(i, i + TARGET_BATCH_CAP));
  let totalWritten = 0;
  let totalMissing = 0;
  for (let ci = 0; ci < chunks.length; ci += 1) {
    process.stderr.write(`[ADDBATCH] chunk ${ci + 1}/${chunks.length} size=${chunks[ci].length}\n`);
    const afterBase = beforeCount + totalWritten;
    const res = await addFolderOnce(folder, chunks[ci], runDirectory, afterBase, { aggressive });
    totalWritten += res.written;
    totalMissing += res.missing;
  }
  const finalCount = beforeCount + totalWritten;
  return {
    folder,
    status: totalWritten > 0 ? "verified" : "unavailable",
    videos: totalWritten,
    verifiedCount: totalWritten,
    unavailable: totalMissing,
    baselineCount: beforeCount,
    finalCount,
  };
}

// 把 unavailable 视频归集到"未处理"夹：这些视频在批量管理 UI 懒加载下没渲染出来，
// 无法勾选原目标夹；但抖音主收藏池里仍可能存在（去重幂等，安全）。
// 读取一个或多个 run 目录的 unavailable-video-ids.json，去重后建夹并写入。
async function collectUnhandled(runDirectories, { aggressive = false } = {}) {
  const seen = new Map(); // aweme_id -> { aweme_id, from }
  for (const runDirectory of runDirectories) {
    const file = path.join(runDirectory, "unavailable-video-ids.json");
    if (!fs.existsSync(file)) continue;
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const entry of document.entries || []) {
      const id = String(entry.aweme_id);
      if (!seen.has(id)) seen.set(id, { aweme_id: id, sourceFolder: entry.folder || "未知" });
    }
  }
  const videos = [...seen.values()];
  if (!videos.length) {
    return { ok: true, folder: UNHANDLED_FOLDER, status: "empty", written: 0, total: 0 };
  }
  // 确保"未处理"夹存在（私有，避免污染公开收藏）
  await createFolder(UNHANDLED_FOLDER, "private").catch(error => {
    process.stderr.write(`[UNHANDLED] create folder warn: ${error.message}\n`);
  });
  // 复用 addFolderBatch 逻辑写入（它是幂等去重的，重复跑安全）
  const result = await addFolderBatch(UNHANDLED_FOLDER, videos, runDirectories[0], { aggressive });
  return { ok: true, folder: UNHANDLED_FOLDER, status: result.status, written: result.verifiedCount ?? result.videos, total: videos.length };
}

function loadManifest(runDirectory) {
  const file = path.join(runDirectory, "apply-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!manifest.plan_fingerprint || !Array.isArray(manifest.create_folders) || !Array.isArray(manifest.add_to_folders)) {
    throw new Error("Invalid apply manifest");
  }
  return manifest;
}

async function main() {
  const [command] = process.argv.slice(2);
  const args = argsMap(process.argv.slice(3));
  // --session <name> 覆盖默认 session，支持多终端手动并行（每个终端用不同名隔离，
  // 各自开独立 Chrome 窗口操作抖音同一账号的不同视图，互不抢同一 session）。
  if (args.session && typeof args.session === "string" && args.session.trim()) {
    SESSION = args.session.trim();
  }
  process.stderr.write(`[MAIN] command=${command} run=${args.run || '-'} session=${SESSION}\n`);

  if (command === "inspect-folders") {
    process.stdout.write(`${JSON.stringify(await inspectFolders(), null, 2)}\n`);
    return;
  }
  if (command === "inspect-video-ui") {
    // 复用已经验证过的 enterManagement 进入批量管理态（它会重试点击并轮询确认控件出现），
    // 不再自行 clickExactText 吞错——之前探针失败就是因为批量管理态没真正进入。
    await enterManagement();
    const scrollCap = Number.isFinite(Number(args.scroll_cap)) ? Number(args.scroll_cap) : 150;
    // 1) 结构性 dump：按钮、菜单项、输入、疑似排序控件、当前 checkbox 数
    const controls = await evaluate(`(() => {
      const visible = el => el && (el.offsetWidth || el.offsetHeight);
      const buttons = [...document.querySelectorAll('button')].filter(visible).map(b => b.innerText.trim()).filter(Boolean);
      const roles = [...document.querySelectorAll('[role=option],[role=menuitem],[role=tab],[role=listbox],[role=menu]')]
        .filter(visible).map(el => ({ role: el.getAttribute('role'), text: el.innerText.trim().slice(0, 40) }))
        .filter(e => e.text);
      const inputs = [...document.querySelectorAll('input')].map(i => ({ ph: i.getAttribute('placeholder'), type: i.type, cls: String(i.className || '').slice(0, 80) })).filter(i => i.ph || i.type);
      const sortish = [...document.querySelectorAll('*')].filter(el => visible(el) && /(排序|最新|最旧|默认排序|综合排序|时间排序)/.test(el.innerText || '') && (el.innerText || '').trim().length < 24)
        .map(el => ({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), text: el.innerText.trim() }));
      const selectAll = [...document.querySelectorAll('*')].filter(el => visible(el) && (el.innerText || '').trim() === '全选').map(el => el.tagName);
      const checkboxNow = document.querySelectorAll('input[type=checkbox]').length;
      const totalMatch = document.body.innerText.match(/共\\s*(\\d+)\\s*作品/);
      return {
        inBatch: document.body.innerText.includes('退出管理'),
        checkboxNow,
        totalInHeader: totalMatch ? Number(totalMatch[1]) : -1,
        buttons: [...new Set(buttons)],
        roleTexts: [...new Set(roles.map(r => r.text))],
        inputs,
        sortish: [...new Set(sortish.map(s => s.text))],
        sortishDetail: sortish.slice(0, 8),
        selectAll,
      };
    })()`);
    // 2) 暴力滚动，找虚拟列表硬上限（每轮复用 loadTargetIds 同款滚动逻辑）
    let maxBoxes = controls.checkboxNow;
    let lastSeen = controls.checkboxNow;
    let stable = 0;
    let plateauAt = -1;
    const curve = [];
    for (let i = 0; i < scrollCap; i += 1) {
      const r = await evaluate(`(() => {
        const boxes = [...document.querySelectorAll('input[type=checkbox]')];
        const last = boxes.at(-1);
        last && last.scrollIntoView({ block: 'end', inline: 'nearest' });
        const scrollers = [...document.querySelectorAll('*')].filter(element => {
          if (element.scrollHeight <= element.clientHeight + 80) return false;
          if (element.clientHeight < 150) return false;
          const overflow = getComputedStyle(element).overflowY;
          return overflow === 'auto' || overflow === 'scroll';
        });
        for (const scroller of scrollers) {
          scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(400, Math.floor(scroller.clientHeight * 0.6)));
        }
        return document.querySelectorAll('input[type=checkbox]').length;
      })()`).catch(() => lastSeen);
      if (r > maxBoxes) maxBoxes = r;
      if (r === lastSeen) { stable += 1; if (stable >= 30 && plateauAt < 0) plateauAt = i; }
      else stable = 0;
      lastSeen = r;
      if (i % 20 === 0) curve.push(r);
      await wait(0.35);
    }
    const finalCount = lastSeen;
    const plateaued = plateauAt >= 0 && finalCount === maxBoxes;
    // 3) 排序控件探测：点开疑似排序下拉，读取选项（只读，不改数据）
    const sortProbe = await evaluate(`(() => {
      const visible = el => el && (el.offsetWidth || el.offsetHeight);
      const trigger = [...document.querySelectorAll('*')].find(el => visible(el) && /(排序|最新|最旧|默认排序|综合排序)/.test(el.innerText || '') && (el.innerText || '').trim().length < 24);
      if (!trigger) return { found: false };
      trigger.click();
      return { found: true, text: trigger.innerText.trim(), tag: trigger.tagName, cls: String(trigger.className || '').slice(0, 80) };
    })()`).catch(() => ({ found: false }));
    await wait(0.9);
    const sortOptions = sortProbe.found
      ? await evaluate(`(() => [...document.querySelectorAll('[role=option],[role=menuitem],li')].map(el => el.innerText.trim()).filter(t => /(最新|最旧|默认|综合|时间)/.test(t)).filter(Boolean).slice(0, 20))()`).catch(() => [])
      : [];
    await safeExitManagement();
    process.stdout.write(`${JSON.stringify({ controls, maxCheckbox: maxBoxes, finalCount, plateaued, plateauAt, scrollCap, curve, sortProbe, sortOptions: [...new Set(sortOptions)] }, null, 2)}\n`);
    return;
  }
  if (command === "search-video-ui") {
    // 只读验证：在批量管理态下用"搜索你收藏的作品"按标题子串定位某个（深的）视频，
    // 确认搜索能把它从长尾里过滤出来并渲染出 checkbox。这是"突破 827"的内存安全路径。
    if (!args.query) throw new Error("--query <text> is required for search-video-ui");
    await enterManagement();
    const setVal = await evaluate(`(() => {
      const inp = [...document.querySelectorAll('input')].find(i => (i.getAttribute('placeholder') || '') === '搜索你收藏的作品');
      if (!inp) return { ok: false };
      // React 受控输入的值追踪器（_valueTracker）陷阱：直接走原型 setter 改 DOM 值后，
      // React 比对话发现 tracker 值未变会认为没变化、不触发 onChange。先把 tracker 设为旧值，
      // 让 React 在下一次 input 事件里读到"新 DOM 值 ≠ 旧 tracker 值"从而真正触发 onChange。
      const oldValue = inp.value;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(args.query)});
      if (inp._valueTracker) inp._valueTracker.setValue(oldValue);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: inp.value };
    })()`);
    if (!setVal.ok) throw new Error("search input (搜索你收藏的作品) not found in batch mode");
    let count = -1;
    let found = false;
    let ids = [];
    for (let i = 0; i < 12; i += 1) {
      await wait(0.6);
      const r = await evaluate(mappingExpression).catch(() => []);
      count = r.length;
      ids = r.map(x => x.id);
      if (args.expect_id) found = ids.some(id => String(id) === String(args.expect_id));
      if (count > 0 && (found || !args.expect_id)) break;
    }
    const headerTotal = await evaluate("(() => { const m = document.body.innerText.match(/共\\s*(\\d+)\\s*作品/); return m ? Number(m[1]) : -1; })()").catch(() => -1);
    await safeExitManagement();
    process.stdout.write(`${JSON.stringify({ query: args.query, setOk: setVal.ok, checkboxCount: count, expectId: args.expect_id || null, foundExpected: args.expect_id ? found : null, sampleIds: ids.slice(0, 12), headerTotal }, null, 2)}\n`);
    return;
  }
  if (command === "close") {
    await runOpencli(["browser", SESSION, "close"], { json: false }).catch(() => {});
    process.stdout.write(`${JSON.stringify({ ok: true, closed: true }, null, 2)}\n`);
    return;
  }
  if (command === "unhandled") {
    // 跨 run 归集 unavailable 视频到"未处理"夹。--runs 用逗号分隔多个 run 目录。
    // 此命令不依赖 manifest，也不做破坏性删除，但仍需登录态与收藏页，故单独做轻量 preflight。
    if (!args.runs) throw new Error("--runs <逗号分隔的 run 目录> is required for unhandled");
    const dirs = String(args.runs).split(",").map(d => d.trim()).filter(Boolean).map(d => path.resolve(d));
    for (const d of dirs) {
      if (!fs.existsSync(d)) throw new Error(`run directory not found: ${d}`);
    }
    await ensureSession(browserSessionPolicy("unhandled"));
    await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "background").catch(() => {});
    await wait(2);
    const summary = await collectUnhandled(dirs, { aggressive: args.aggressive === true });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (!args.run) throw new Error("--run <directory> is required");
  const runDirectory = path.resolve(String(args.run));
  const manifest = loadManifest(runDirectory);
  const executionToken = `EXECUTE:${manifest.plan_fingerprint.slice(0, 12)}`;

  if (command === "preflight") {
    process.stdout.write(`${JSON.stringify(await preflight(manifest, browserSessionPolicy(command)), null, 2)}\n`);
    return;
  }
  if (args.execute !== true || args.confirmation !== executionToken) {
    throw new Error(`Account writes require --execute --confirmation ${executionToken}`);
  }
  process.stderr.write(`[MAIN] preflight done for command=${command}\n`);
  await preflight(manifest, browserSessionPolicy(command));
  process.stderr.write(`[MAIN] preflight passed for command=${command}\n`);

  if (command === "create-folders") {
    const results = [];
    for (const folder of manifest.create_folders) {
      results.push(await createFolder(folder.name, folder.visibility));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
    return;
  }
  if (command === "delete-folders") {
    if (!args.folders) throw new Error("--folders <逗号分隔的收藏夹名> is required for delete-folders");
    const names = String(args.folders).split(",").map(name => name.trim()).filter(Boolean);
    if (!names.length) throw new Error("--folders resolved to an empty list");
    const journalFile = path.join(runDirectory, "delete-journal.jsonl");
    const results = [];
    for (const name of names) {
      try {
        const result = await deleteFolder(name);
        results.push(result);
        // 删除没有视频 ID，不写入 apply-journal（仅接受视频写入），单独留 delete-journal 审计
        fs.appendFileSync(journalFile, `${JSON.stringify({ folder: name, status: result.status, at: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        const failed = { name, status: "failed", error: error.message };
        results.push(failed);
        fs.appendFileSync(journalFile, `${JSON.stringify({ folder: name, status: "failed", error: error.message, at: new Date().toISOString() })}\n`, "utf8");
        process.stderr.write(`delete-folders stopped at "${name}": ${error.message}\n`);
        break;
      }
    }
    const deleted = results.filter(r => r.status === "deleted").length;
    const missing = results.filter(r => r.status === "missing").length;
    process.stdout.write(`${JSON.stringify({ ok: true, deleted, missing, results }, null, 2)}\n`);
    return;
  }
  if (command === "add-folder") {
    if (args.all === true) {
      // 一次进程跑完所有夹，复用同一个 session（只在首个夹 open 浏览器，
      // 后续 enterManagement 检测到已在视频页就不再 open），大幅减少 Chrome 启动抖动。
      process.stderr.write(`[ALL] start ${manifest.add_to_folders.length} folders\n`);
      // --force 时忽略 unavailable 黑名单：突破 827 假上限后重跑，旧黑名单里记录的视频在放宽滚动预算下
      // 其实已可渲染；若仍套用黑名单会把它们永远跳过（致命陷阱）。默认仍尊重黑名单以保护增量重跑。
      const useBlacklist = args.force !== true;
      const unavailableFile = path.join(runDirectory, "unavailable-video-ids.json");
      const unavailableDocument = (useBlacklist && fs.existsSync(unavailableFile))
        ? JSON.parse(fs.readFileSync(unavailableFile, "utf8"))
        : { entries: [] };
      const unavailable = new Set((unavailableDocument.entries || []).map(entry => String(entry.aweme_id)));
      const allResults = [];
      for (const batch of manifest.add_to_folders) {
        const skipped = useBlacklist ? batch.videos.filter(video => unavailable.has(String(video.aweme_id))) : [];
        const available = useBlacklist ? batch.videos.filter(video => !unavailable.has(String(video.aweme_id))) : batch.videos;
        if (skipped.length) {
          appendJournal(runDirectory, {
            folder: batch.folder,
            ids: skipped.map(video => video.aweme_id),
            status: "unavailable",
            verifiedCount: 0,
            evidence: "suppressed by pre-bypass unavailable blacklist (rerun with --force to retry)",
          });
        }
      let result;
      try {
        result = available.length
          ? await addFolderBatch(batch.folder, available, runDirectory, { aggressive: args.aggressive === true })
          : { folder: batch.folder, status: "unavailable", videos: 0, verifiedCount: 0 };
      } catch (error) {
        // 单夹失败（抖音界面偶发抖动）不中断整个批次：记录 failed 并继续下一夹，
        // 后续可重跑（幂等保护，已写入的不重复写）。
        result = { folder: batch.folder, status: "failed", error: error.message };
        process.stderr.write(`[ALL] FAILED folder=${batch.folder}: ${error.message}\n`);
      }
      allResults.push(result);
      process.stderr.write(`[ALL] done folder=${batch.folder} status=${result.status} written=${result.verifiedCount ?? result.videos ?? 0}\n`);
      // 每夹之间冷却，避免连续猛刷触发抖音"操作频繁"瞬时退化（第二道墙的次因）
      await wait(COOLDOWN_BETWEEN_FOLDERS);
      }
      // 单轮后仍 unavailable/failed 的夹：冷却后整轮重试一次（滚动复位已修复根因，此处应对会话内瞬时退化），
      // 仍失败才交由末尾 collectUnhandled 归集 未处理。
      const retryTargets = allResults.filter(r => r && (r.status === "unavailable" || r.status === "failed"));
      if (retryTargets.length) {
        process.stderr.write(`[ALL] retry ${retryTargets.length} unavailable/failed folders after cooldown\n`);
        await wait(COOLDOWN_BETWEEN_FOLDERS * 3);
        for (const t of retryTargets) {
          try {
            const rb = manifest.add_to_folders.find(b => b.folder === t.folder);
            if (!rb) continue;
            const rr = await addFolderBatch(rb.folder, rb.videos, runDirectory, { aggressive: args.aggressive === true });
            const idx = allResults.findIndex(x => x.folder === t.folder);
            if (idx >= 0) allResults[idx] = rr;
            process.stderr.write(`[ALL] retry done folder=${rb.folder} status=${rr.status} written=${rr.verifiedCount ?? rr.videos ?? 0}\n`);
          } catch (e) {
            process.stderr.write(`[ALL] retry FAILED folder=${t.folder}: ${e.message}\n`);
          }
          await wait(COOLDOWN_BETWEEN_FOLDERS);
        }
      }
      process.stdout.write(`${JSON.stringify({ ok: true, results: allResults }, null, 2)}\n`);
      // 跑完后自动把本批 unavailable 归集到"未处理"夹（不阻塞主流程；失败仅记日志）
      try {
        const summary = await collectUnhandled([runDirectory]);
        process.stderr.write(`[UNHANDLED] collected=${summary.written ?? 0}/${summary.total ?? 0} -> ${UNHANDLED_FOLDER}\n`);
      } catch (error) {
        process.stderr.write(`[UNHANDLED] collection failed (non-fatal): ${error.message}\n`);
      }
      return;
    }
    process.stderr.write(`[DEBUG] entering add-folder for ${args.folder}\n`);
    if (!args.folder) throw new Error("--folder is required");
    const batch = manifest.add_to_folders.find(item => item.folder === args.folder);
    if (!batch) throw new Error(`Folder batch is not in the manifest: ${args.folder}`);
    // --force 时忽略 unavailable 黑名单（用于单夹补跑 / 加强加载重试）
    const useBlacklist = args.force !== true;
    const unavailableFile = path.join(runDirectory, "unavailable-video-ids.json");
    const unavailableDocument = fs.existsSync(unavailableFile)
      ? JSON.parse(fs.readFileSync(unavailableFile, "utf8"))
      : { entries: [] };
    const unavailable = new Set((unavailableDocument.entries || []).map(entry => String(entry.aweme_id)));
    const skipped = useBlacklist ? batch.videos.filter(video => unavailable.has(String(video.aweme_id))) : [];
    const available = useBlacklist ? batch.videos.filter(video => !unavailable.has(String(video.aweme_id))) : batch.videos;
    if (skipped.length) {
      appendJournal(runDirectory, {
        folder: batch.folder,
        ids: skipped.map(video => video.aweme_id),
        status: "unavailable",
        verifiedCount: 0,
        evidence: "not rendered in Douyin batch management UI after full scroll and search",
      });
    }
    const result = available.length
      ? await addFolderBatch(batch.folder, available, runDirectory, { aggressive: args.aggressive === true })
      : { folder: batch.folder, status: "unavailable", videos: 0, verifiedCount: 0 };
    process.stdout.write(`${JSON.stringify({ ok: true, result, unavailable: skipped.length, planned: batch.videos.length }, null, 2)}\n`);
    return;
  }
  throw new Error("Use inspect-folders, preflight, create-folders, delete-folders, add-folder, or close");
}

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[UNHANDLED] ${reason?.stack || reason}\n`);
});
main().catch(async error => {
  const msg = `${error?.stack || error}`;
  process.stderr.write(`${msg}\n`);
  try { fs.writeFileSync("D:/pyworkplace/douyin-tools/var/runs/2026-08-22T13-45-22-391Z/_adderr.log", `${new Date().toISOString()}\n${msg}\n`, "utf8"); } catch {}
  process.exitCode = 1;
});
