import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendJournal } from "../src/journal.mjs";
import { applyAllFolderBatches } from "../src/apply-all.mjs";
import { browserSessionPolicy, douyinFavoritesUrl } from "../src/browser-session-policy.mjs";
import { mergeObservedMappedIds, mappedIdSignature, partitionMappedTargets, targetCheckboxSelector } from "../src/browser-selection.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = douyinFavoritesUrl();

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
const browserOn = (targetPage, ...args) => targetPage
  ? runOpencli(["browser", SESSION, ...args, "--tab", targetPage])
  : browser(...args);
const evaluateOn = (targetPage, js) => browserOn(targetPage, "eval", js);
const waitOn = (targetPage, seconds) => targetPage
  ? runOpencli(["browser", SESSION, "wait", "time", String(seconds), "--tab", targetPage], { json: false })
  : wait(seconds);

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

async function clickTab(id, targetPage = null) {
  const result = await evaluateOn(targetPage, `(() => {
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
  if (!result.clicked) throw new Error(`Required tab is missing: ${id}`);
  await waitOn(targetPage, 1.5);
  const selected = await evaluateOn(targetPage, `(() => document.getElementById(${JSON.stringify(id)})?.getAttribute('aria-selected'))()`);
  if (selected !== "true" && selected !== true) throw new Error(`Tab did not become selected: ${id}`);
}

async function clickExactText(text, targetPage = null) {
  const result = await evaluateOn(targetPage, `(() => {
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

async function preflight(manifest, windowMode = "background") {
  await ensureSession(windowMode);
  await clickTab("semiTabfavorite_collection");
  const managementOpen = await evaluate("(() => document.body.innerText.includes('退出管理'))()");
  if (managementOpen) {
    await clickExactText("退出管理");
    await wait(0.8);
  }
  let state = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    state = await evaluate(`(() => ({
      loggedIn: !!document.getElementById('semiTabfavorite_collection'),
      folderTab: !!document.getElementById('semiTabfavorite_folder'),
      videoTab: !!document.getElementById('semiTabvideo'),
      batchManage: document.body.innerText.includes('批量管理'),
      addActionKnown: true,
      cancelActionGuard: true
    }))()`);
    if (state.folderTab && state.videoTab && state.batchManage) break;
    await wait(0.4);
  }
  if (!state.loggedIn || !state.folderTab || !state.videoTab || !state.batchManage) {
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

async function folderCount(name, targetPage = null) {
  await clickTab("semiTabfavorite_folder", targetPage);
  return evaluateOn(targetPage, `(() => {
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

const mappingExpression = `(() => {
  const output = [];
  const pattern = new RegExp('video/(\\\\d{15,})', 'g');
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
    let current = checkbox;
    let resolved = '';
    for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
      pattern.lastIndex = 0;
      const ids = [...new Set([...String(current.outerHTML || '').matchAll(pattern)].map(match => match[1]))];
      if (ids.length === 1) { resolved = ids[0]; break; }
    }
    if (resolved) output.push({ id: resolved, checked: checkbox.checked });
  }
  return output;
})()`;

async function enterManagement() {
  await clickTab("semiTabvideo");
  const active = await evaluate("(() => document.body.innerText.includes('退出管理'))()");
  if (active) {
    await clickExactText("退出管理");
    await wait(0.5);
  }
  await clickExactText("批量管理");
  await wait(0.7);
  const controls = await evaluate("(() => ({exit:document.body.innerText.includes('退出管理'),add:document.body.innerText.includes('加入收藏夹'),cancel:document.body.innerText.includes('取消收藏')}))()");
  if (!controls.exit || !controls.add || !controls.cancel) throw new Error(`Management controls changed: ${JSON.stringify(controls)}`);
}

async function scrollManagementForward() {
  await evaluate(`(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox]')];
    const last = boxes.at(-1)?.parentElement?.parentElement?.parentElement;
    last?.scrollIntoView({ block: 'end', inline: 'nearest' });
    const scrollers = [...document.querySelectorAll('*')].filter(element => {
      if (element.scrollHeight <= element.clientHeight + 100 || element.clientHeight < 200) return false;
      const overflow = getComputedStyle(element).overflowY;
      return overflow === 'auto' || overflow === 'scroll';
    });
    for (const scroller of scrollers) {
      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(500, Math.floor(scroller.clientHeight * 0.85)));
    }
    return { boxes: boxes.length, scrollers: scrollers.length };
  })()`);
}

async function rewindManagementList() {
  await evaluate(`(() => {
    window.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    const scrollers = [...document.querySelectorAll('*')].filter(element => {
      if (element.scrollHeight <= element.clientHeight + 100 || element.clientHeight < 200) return false;
      const overflow = getComputedStyle(element).overflowY;
      return overflow === 'auto' || overflow === 'scroll';
    });
    for (const scroller of scrollers) scroller.scrollTop = 0;
    document.querySelector('input[type=checkbox]')?.scrollIntoView({ block: 'start', inline: 'nearest' });
    return scrollers.length;
  })()`);
  await wait(0.45);
}

async function loadTargetIds(targetIds) {
  let stable = 0;
  let previousSignature = "";
  let observedIds = [];
  let attempts = 0;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    attempts = attempt + 1;
    const mapped = await evaluate(mappingExpression);
    observedIds = mergeObservedMappedIds(observedIds, mapped);
    const ids = new Set(observedIds);
    if (targetIds.every(id => ids.has(id))) {
      return { ...partitionMappedTargets(targetIds, ids), mapped: ids.size, attempts };
    }
    const signature = mappedIdSignature(observedIds);
    if (signature === previousSignature) stable += 1;
    else stable = 0;
    previousSignature = signature;
    if (stable >= 7) break;
    await scrollManagementForward();
    await wait(0.45);
  }
  const final = await evaluate(mappingExpression);
  observedIds = mergeObservedMappedIds(observedIds, final);
  const ids = new Set(observedIds);
  return { ...partitionMappedTargets(targetIds, ids), mapped: ids.size, attempts };
}

async function selectTargetIds(targetIds) {
  const current = new Set((await evaluate(mappingExpression)).map(item => String(item.id)));
  if (!targetIds.every(id => current.has(String(id)))) {
    await rewindManagementList();
    await loadTargetIds(targetIds);
  }
  const marked = await evaluate(`(() => {
    const targets = new Set(${JSON.stringify(targetIds)});
    const pattern = new RegExp('video/(\\\\d{15,})', 'g');
    const mapped = new Map();
    for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
      let current = checkbox;
      let resolved = '';
      for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
        pattern.lastIndex = 0;
        const ids = [...new Set([...String(current.outerHTML || '').matchAll(pattern)].map(match => match[1]))];
        if (ids.length === 1) { resolved = ids[0]; break; }
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
    const pattern = new RegExp('video/(\\\\d{15,})', 'g');
    const checked = [];
    for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
      let current = checkbox;
      let resolved = '';
      for (let depth = 0; depth < 10 && current; depth += 1, current = current.parentElement) {
        pattern.lastIndex = 0;
        const ids = [...new Set([...String(current.outerHTML || '').matchAll(pattern)].map(match => match[1]))];
        if (ids.length === 1) { resolved = ids[0]; break; }
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

async function submitSelectedToFolder(folder) {
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
}

async function writerReadyState() {
  return evaluate(`(() => {
    const managementOpen = document.body.innerText.includes('退出管理');
    const addAction = document.body.innerText.includes('加入收藏夹');
    const cancelGuard = document.body.innerText.includes('取消收藏');
    const dialogOpen = [...document.querySelectorAll('[role=dialog]')]
      .some(element => element.offsetWidth || element.offsetHeight);
    const checked = [...document.querySelectorAll('input[type=checkbox]')]
      .filter(element => element.checked).length;
    if (!dialogOpen && checked === 0) {
      for (const element of document.querySelectorAll('[data-organizer-target]')) {
        element.removeAttribute('data-organizer-target');
      }
    }
    return {
      ready: managementOpen && addAction && cancelGuard && !dialogOpen && checked === 0,
      managementOpen,
      addAction,
      cancelGuard,
      dialogOpen,
      checked,
    };
  })()`);
}

function exactBatchVerified(runDirectory, folder, ids) {
  const journalFile = path.join(runDirectory, "apply-journal.jsonl");
  if (!fs.existsSync(journalFile)) return false;
  const expected = JSON.stringify([...ids].map(String).sort());
  return fs.readFileSync(journalFile, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .some(entry => {
      const recorded = [...(entry.aweme_ids || [])].map(String).sort();
      return entry.status === "verified" && entry.folder === folder
        && JSON.stringify(recorded) === expected;
    });
}

function recordDeferredIds(runDirectory, folder, ids) {
  if (!ids.length) return;
  const file = path.join(runDirectory, "deferred-video-ids.json");
  const document = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema_version: 1, entries: [] };
  const entries = new Map((document.entries || []).map(entry => [String(entry.aweme_id), entry]));
  for (const id of ids) {
    entries.set(String(id), {
      aweme_id: String(id),
      folder,
      reason: "not found during a bounded Douyin batch-management scan; retry on the next run",
    });
  }
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 1, entries: [...entries.values()] }, null, 2)}\n`, "utf8");
}

async function addFolderBatch(folder, videos, runDirectory) {
  const ids = videos.map(video => String(video.aweme_id));
  const priorVerified = exactBatchVerified(runDirectory, folder, ids);
  if (priorVerified) {
    appendJournal(runDirectory, { folder, ids, status: "verified", verifiedCount: ids.length, evidence: "exact batch already verified in journal" });
    return { folder, status: "already-verified", videos: ids.length, verifiedCount: ids.length };
  }
  const beforeCount = await folderCount(folder);
  if (beforeCount < 0) throw new Error(`Folder is missing or unreadable: ${folder}`);
  appendJournal(runDirectory, { folder, ids, status: "started", verifiedCount: 0, baselineCount: beforeCount, evidence: "browser batch opened" });
  let submitStarted = false;
  let attemptedIds = ids;
  try {
    await enterManagement();
    const availability = await loadTargetIds(ids);
    attemptedIds = availability.available;
    if (availability.missing.length) {
      recordDeferredIds(runDirectory, folder, availability.missing);
      appendJournal(runDirectory, {
        folder,
        ids: availability.missing,
        status: "deferred",
        verifiedCount: 0,
        evidence: "not found during a bounded browser scan; retry on the next run",
      });
    }
    if (!attemptedIds.length) {
      await clickExactText("退出管理");
      await wait(0.5);
      return {
        folder,
        status: "deferred",
        videos: 0,
        verifiedCount: 0,
        deferred: availability.missing.length,
        baselineCount: beforeCount,
        finalCount: beforeCount,
      };
    }
    const expectedCount = beforeCount + attemptedIds.length;
    await selectTargetIds(attemptedIds);
    await submitSelectedToFolder(folder);
    submitStarted = true;
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
        return {
          folder,
          status: "verified",
          videos: attemptedIds.length,
          verifiedCount: attemptedIds.length,
          deferred: availability.missing.length,
          baselineCount: beforeCount,
          finalCount: afterCount,
        };
      }
    }
    appendJournal(runDirectory, { folder, ids: attemptedIds, status: "unknown", verifiedCount: 0, evidence: "submit completed but folder count did not match" });
    throw new Error(`Batch result is unknown after confirmation: ${folder}`);
  } catch (error) {
    if (!submitStarted) {
      appendJournal(runDirectory, { folder, ids: attemptedIds, status: "failed", verifiedCount: 0, evidence: "stopped before destination confirmation" });
    }
    throw error;
  }
}

async function createVerifierTab() {
  const created = await browser("tab", "new", SELF_URL);
  const targetPage = String(created?.page || "").trim();
  if (!targetPage) throw new Error(`Could not create an independent verifier tab: ${JSON.stringify(created)}`);
  await browserOn(targetPage, "open", SELF_URL);
  await waitOn(targetPage, 1);
  return targetPage;
}

async function readFolderCounts(targetPage, folders) {
  const counts = {};
  for (const folder of [...new Set(folders.map(String))]) {
    const count = await folderCount(folder, targetPage);
    if (count < 0) throw new Error(`Folder is missing or unreadable in verifier tab: ${folder}`);
    counts[folder] = count;
  }
  return counts;
}

async function verifyFolderCountInTab(targetPage, folder, expectedCount) {
  await browserOn(targetPage, "open", SELF_URL);
  await waitOn(targetPage, 0.5);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const actualCount = await folderCount(folder, targetPage);
    if (actualCount === expectedCount) return true;
    await waitOn(targetPage, 0.45);
  }
  return false;
}

async function applyAllBatches(manifest, runDirectory) {
  const verifierTab = await createVerifierTab();
  try {
    return await applyAllFolderBatches({
      batches: manifest.add_to_folders,
      browser: {
        readFolderCounts: folders => readFolderCounts(verifierTab, folders),
        scanTargets: async ids => {
          await enterManagement();
          return loadTargetIds(ids);
        },
        selectTargets: selectTargetIds,
        submitToFolder: async folder => {
          await submitSelectedToFolder(folder);
          await wait(0.7);
        },
        verifyWriterReady: writerReadyState,
        verifyFolderCount: (folder, expectedCount) => verifyFolderCountInTab(verifierTab, folder, expectedCount),
      },
      journal: entry => appendJournal(runDirectory, entry),
      recordDeferred: (folder, ids) => recordDeferredIds(runDirectory, folder, ids),
      isBatchVerified: batch => exactBatchVerified(
        runDirectory,
        batch.folder,
        batch.videos.map(video => String(video.aweme_id)),
      ),
    });
  } finally {
    await browser("tab", "close", verifierTab).catch(() => {});
  }
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

  if (command === "inspect-folders") {
    process.stdout.write(`${JSON.stringify(await inspectFolders(), null, 2)}\n`);
    return;
  }
  if (command === "close") {
    await runOpencli(["browser", SESSION, "close"], { json: false }).catch(() => {});
    process.stdout.write(`${JSON.stringify({ ok: true, closed: true }, null, 2)}\n`);
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
  await preflight(manifest, browserSessionPolicy(command));

  if (command === "create-folders") {
    const results = [];
    for (const folder of manifest.create_folders) {
      results.push(await createFolder(folder.name, folder.visibility));
    }
    process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
    return;
  }
  if (command === "apply-all") {
    const result = manifest.add_to_folders.length
      ? await applyAllBatches(manifest, runDirectory)
      : { ok: true, scan_passes: 0, mapped_videos: 0, deferred_videos: 0, unavailable_videos: 0, results: [] };
    process.stdout.write(`${JSON.stringify({
      ...result,
      planned: manifest.add_to_folders.reduce((sum, batch) => sum + batch.videos.length, 0),
    }, null, 2)}\n`);
    return;
  }
  if (command === "add-folder") {
    if (!args.folder) throw new Error("--folder is required");
    const batch = manifest.add_to_folders.find(item => item.folder === args.folder);
    if (!batch) throw new Error(`Folder batch is not in the manifest: ${args.folder}`);
    const result = await addFolderBatch(batch.folder, batch.videos, runDirectory);
    process.stdout.write(`${JSON.stringify({ ok: true, result, planned: batch.videos.length }, null, 2)}\n`);
    return;
  }
  throw new Error("Use inspect-folders, preflight, create-folders, apply-all, add-folder, or close");
}

main().catch(async error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
