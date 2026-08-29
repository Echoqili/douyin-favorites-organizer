// apply-search.mjs —— 搜索式写入：批量管理态用"搜索你收藏的作品"按标题定位缺失视频，
// 勾选后逐夹提交。绕开列表虚拟化（DOM 恒定 ~20 个节点，滚动累计已失效）。
// --probe：先验证勾选态跨搜索持久化。
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPENCLI = path.join(ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const SESSION = "douyin-organizer-apply";
const SELF_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";
const RUN_DIR = path.join(ROOT, "var", "runs", "final-apply");
const PROBE = process.argv.includes("--probe");
let titleOf = new Map(); // video_id -> title，供模块级 checkTarget 使用

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
const log = m => process.stderr.write(`[SEARCH] ${m}\n`);

const mappingExpression = `(() => {
  // 精确映射：从 checkbox 向上找第一个"恰好只含 1 个视频链接"的祖先，
  // 该祖先内的唯一链接即本卡片链接（避免爬进共享祖先取到别人的卡片）。
  const output = [];
  const pattern = new RegExp('video/(\\\\d{15,})');
  for (const checkbox of document.querySelectorAll('input[type=checkbox]')) {
    let current = checkbox; let resolved = '';
    for (let depth = 0; depth < 12 && current; depth += 1, current = current.parentElement) {
      const anchors = current.querySelectorAll ? current.querySelectorAll('a[href*="video/"]') : [];
      if (anchors.length === 1) { const m = (anchors[0].getAttribute('href') || '').match(pattern); if (m) { resolved = m[1]; break; } }
      if (anchors.length > 1) break; // 爬进共享容器，之前的层级才是正确卡片
    }
    if (resolved) output.push({ id: resolved, checked: checkbox.checked });
  }
  return output;
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
  if (!onVideoPage) { await browser("open", `${SELF_URL}&showSubTab=favorite_video`, "--window", "foreground"); await wait(2.5); }
  await clickTab("semiTabvideo");
  const active = await evaluate("(() => document.body.innerText.includes('退出管理'))()").catch(() => false);
  if (active) { await clickExactText("退出管理"); await wait(0.8); }
  await clickExactText("批量管理");
  await wait(1.0);
  let controls = null;
  for (let probe = 0; probe < 10; probe += 1) {
    controls = await evaluate("(() => ({exit:document.body.innerText.includes('退出管理'),add:document.body.innerText.includes('加入收藏夹'),cancel:document.body.innerText.includes('取消收藏')}))()").catch(() => null);
    if (controls && controls.exit && controls.add && controls.cancel) break;
    await wait(1.0);
  }
  if (!controls || !controls.exit || !controls.add || !controls.cancel) throw new Error(`Management controls changed: ${JSON.stringify(controls)}`);
  log("management mode ON");
}

async function search(query) {
  const setVal = await evaluate(`(() => {
    const inp = [...document.querySelectorAll('input')].find(i => (i.getAttribute('placeholder') || '') === '搜索你收藏的作品');
    if (!inp) return { ok: false };
    const oldValue = inp.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(query)});
    if (inp._valueTracker) inp._valueTracker.setValue(oldValue);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return { ok: true, value: inp.value };
  })()`);
  if (!setVal.ok) throw new Error("search input not found");
  // 哨兵：页面出现"找到你收藏的 N 个相关视频"，或 checkbox 集合变化
  let mapped = [];
  for (let i = 0; i < 16; i += 1) {
    await wait(0.7);
    const s = await evaluate(`(() => ({ hit: document.body.innerText.includes('找到你收藏的'), n: document.querySelectorAll('input[type=checkbox]').length }))()`).catch(() => ({ hit: false, n: 0 }));
    mapped = await evaluate(mappingExpression).catch(() => []);
    if (s.hit || (mapped.length > 0 && i > 2)) break;
  }
  await wait(0.4);
  mapped = await evaluate(mappingExpression).catch(() => []);
  return mapped;
}

// 标题匹配定位：目标标题片段（去话题标签/空白后取前 12 字）。
// 遍历每个 checkbox，向上爬找包含片段的最浅祖先；最浅者即目标卡片（列表容器的文本
// 也包含片段但深度大得多）。返回该 checkbox 的勾选状态并可选点击。
const CHECK_JS = (frag, doClick) => `(() => {
  const frag = ${JSON.stringify(frag)};
  let best = null; // { depth, cb }
  for (const cb of document.querySelectorAll('input[type=checkbox]')) {
    let cur = cb;
    for (let d = 1; d <= 10 && cur; d += 1, cur = cur.parentElement) {
      if (cur.innerText && cur.innerText.includes(frag)) { if (!best || d < best.depth) best = { depth: d, cb }; break; }
    }
  }
  if (!best) return { ok: false };
  if (doClick && !best.cb.checked) best.cb.click();
  return { ok: true, depth: best.depth, checked: best.cb.checked };
})()`;

function fragOf(title) {
  const clean = String(title || "").replace(/#[^\s#]+/g, " ").replace(/@[^\s@]+/g, " ").replace(/\s+/gu, " ").trim();
  return clean.slice(0, 12);
}

async function checkTarget(id) {
  const title = titleOf.get(id) || "";
  const frag = fragOf(title);
  if (!frag) throw new Error(`no title fragment for ${id}`);
  const r = await evaluate(CHECK_JS(frag, true));
  if (!r.ok) throw new Error(`target ${id} (frag=${frag}) not in current results`);
  await wait(0.3);
  const confirm = await evaluate(CHECK_JS(frag, false));
  if (confirm.checked !== true) throw new Error(`target ${id} check did not stick`);
}

async function submitToFolder(folder) {
  await clickExactText("加入收藏夹");
  await wait(0.8);
  const chosen = await evaluate(`(() => {
    const candidates = [...document.querySelectorAll('*')]
      .filter(element => element.innerText?.trim() === ${JSON.stringify(folder)} && (element.offsetWidth || element.offsetHeight));
    if (candidates.length !== 1) return { ok: false, error: 'ambiguous', matches: candidates.length };
    const row = candidates[0].parentElement?.parentElement;
    const control = row?.querySelector('span.semi-checkbox');
    if (!control) return { ok: false, error: 'missing folder checkbox' };
    control.setAttribute('data-organizer-folder-checkbox', 'destination');
    return { ok: true };
  })()`);
  if (!chosen.ok) throw new Error(`Choose folder failed: ${JSON.stringify(chosen)}`);
  const folderClick = await browser("click", '[data-organizer-folder-checkbox="destination"]');
  if (!folderClick.clicked || folderClick.matches_n !== 1) throw new Error(`Folder checkbox click failed`);
  await wait(0.4);
  const confirmation = await evaluate(`(() => {
    const destination = document.querySelector('[data-organizer-folder-checkbox="destination"] input[type=checkbox]');
    const buttons = [...document.querySelectorAll('button')]
      .filter(element => element.innerText.trim() === '确定' && (element.offsetWidth || element.offsetHeight));
    if (!destination?.checked || buttons.length !== 1 || buttons[0].disabled) return { ready: false };
    buttons[0].setAttribute('data-organizer-confirm', 'destination');
    return { ready: true };
  })()`);
  if (!confirmation.ready) throw new Error(`Confirm ambiguous`);
  await browser("click", '[data-organizer-confirm="destination"]');
  await wait(1.5);
}

function buildQuery(title) {
  const clean = String(title || "").replace(/#[^\s#]+/g, " ").replace(/\\s+/gu, " ").trim();
  const stop = [...clean].findIndex(ch => /[，。！？、；：,.!?;:\n]/.test(ch));
  const base = stop > 5 ? clean.slice(0, stop) : clean.slice(0, 16);
  return base.trim().slice(0, 16);
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const missingReport = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "missing-report.json"), "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "_ai_classify_merged.json"), "utf8"));
  const favsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "var", "runs", "_full", "favorites.json"), "utf8"));
  const favs = Array.isArray(favsRaw) ? favsRaw : (favsRaw.aweme_list || favsRaw.favorites || Object.values(favsRaw)[0]);
  titleOf = new Map(favs.map(v => [String(v.aweme_id || v.id), v.title || v.desc || ""]));

  const UNREADABLE = new Set(["健身与运动", "内容创作与自媒体"]);
  const addPlan = [];
  for (const f of missingReport.folders) {
    if (UNREADABLE.has(f.folder)) continue;
    if (f.missingIds.length) addPlan.push({ folder: f.folder, ids: f.missingIds.map(String) });
  }
  const planByFolder = {};
  for (const [vid, folder] of Object.entries(plan)) (planByFolder[folder] ||= []).push(String(vid));
  for (const folder of UNREADABLE) {
    const ids = planByFolder[folder] || [];
    if (ids.length) addPlan.push({ folder, ids });
  }
  log(`add plan: ${addPlan.length} folders, ${addPlan.reduce((s, b) => s + b.ids.length, 0)} videos`);
  if (PROBE) {
    // 持久化探测：搜 A 勾选 -> 搜 B 勾选 -> 再搜 A，看是否仍勾选
    await enterManagement();
    const all = addPlan.flatMap(b => b.ids).filter(id => (titleOf.get(id) || "").length > 5).slice(0, 2);
    if (all.length < 2) { console.log(JSON.stringify({ error: "not enough titled targets" })); return; }
    const [idA, idB] = all;
    await search(buildQuery(titleOf.get(idA)));
    await checkTarget(idA);
    log(`checked A=${idA}`);
    await search(buildQuery(titleOf.get(idB)));
    await checkTarget(idB);
    log(`checked B=${idB}`);
    const again = await search(buildQuery(titleOf.get(idA)));
    const a = again.find(x => x.id === idA);
    log(`re-search A: present=${!!a}, checked=${a?.checked}`);
    // 清理：退出管理态（不提交）
    await clickExactText("退出管理").catch(() => {});
    console.log(JSON.stringify({ idA, idB, persisted: a?.checked ?? null }, null, 2));
    return;
  }
  // 正式流程
  await enterManagement();
  const results = [];
  for (const b of addPlan) {
    const entry = { folder: b.folder, intended: b.ids.length, checked: 0, notFound: [], errors: [] };
    let anyChecked = false;
    for (const id of b.ids) {
      const title = titleOf.get(id) || "";
      const q = buildQuery(title);
      if (!q) { entry.notFound.push({ id, reason: "no-title" }); continue; }
      try {
        const mapped = await search(q);
        const hit = mapped.find(x => x.id === id);
        if (!hit) {
          // 备选查询：更长前缀
          const q2 = String(title).replace(/#[^\s#]+/g, " ").replace(/\s+/gu, " ").trim().slice(0, 24);
          const mapped2 = q2 !== q ? await search(q2) : [];
          const hit2 = mapped2.find(x => x.id === id);
          if (!hit2) { entry.notFound.push({ id, reason: "search-miss", q }); continue; }
        }
        await checkTarget(id);
        entry.checked += 1;
        anyChecked = true;
      } catch (e) {
        entry.errors.push({ id, error: String(e.message).slice(0, 160) });
      }
      await wait(0.4);
    }
    if (anyChecked) {
      try {
        await submitToFolder(b.folder);
        entry.status = "submitted";
      } catch (e) {
        entry.status = "submit-error";
        entry.submitError = String(e.message).slice(0, 200);
      }
    } else {
      entry.status = "nothing-checked";
    }
    log(`${b.folder}: ${entry.status} checked=${entry.checked} notFound=${entry.notFound.length}`);
    results.push(entry);
    fs.writeFileSync(path.join(RUN_DIR, "search-apply-progress.json"), JSON.stringify(results, null, 2));
    await wait(2);
  }
  try { await clickExactText("退出管理"); } catch (_) {}
  fs.writeFileSync(path.join(RUN_DIR, "search-apply-summary.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results.map(r => ({ folder: r.folder, status: r.status, checked: r.checked, notFound: r.notFound.length })), null, 2));
}
main().catch(e => { log(`FATAL ${e.message}`); process.exit(1); });
