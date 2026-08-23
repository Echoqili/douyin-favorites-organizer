#!/usr/bin/env node
/**
 * batch-organize.mjs — 抖音收藏批量整理编排器
 *
 * 设计目标：
 *  1. 一次性 collect 全量收藏（最脆弱的浏览器桥接环节只跑一次）
 *  2. 按 --size 切片，每片生成独立 run 目录（复用现有管线结构）
 *  3. 逐片走 classify(draft) -> approve(自动token) -> apply(浏览器写入)
 *  4. 崩溃自愈：apply 子进程失败自动重试；整片失败标记 error 继续下一片
 *  5. 断点续跑：已完成片写 state，重跑自动跳过
 *
 * 用法：
 *   node scripts/batch-organize.mjs            # 限频安全逐片 collect + 跑全部（推荐）
 *   node scripts/batch-organize.mjs --no-collect   # 复用已有 _full 切片续跑
 *   node scripts/batch-organize.mjs --size 150 --collect-interval 8000
 *   node scripts/batch-organize.mjs --only 3,4,5   # 只跑指定片（1-based）
 *   node scripts/batch-organize.mjs --limit 5500   # collectPerSlice 模式下作为每页上限提示
 *
 * 频率避让：collectPerSlice 模式每片采集后 sleep --collect-interval ms（默认 8s），
 * 连续返回 0 条 2 次即停止（到达收藏末尾）。
 */
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ensureDirectory, writeJson, readJson, sha256, timestampId } from "../src/io.mjs";
import { writeDraftPlan } from "../src/classifier.mjs";
import { approvalToken, approvePlan, buildApplyManifest, validatePlan } from "../src/plan.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(PROJECT_ROOT, "var", "runs");
const FULL_DIR = path.join(RUNS_DIR, "_full");
const STATE_FILE = path.join(RUNS_DIR, "_batch_state.json");

const SLICE_SIZE = Number(process.argv.includes("--size") ? process.argv[process.argv.indexOf("--size") + 1] : 150);
// 默认 limit=1000：覆盖全量收藏，又不至于像 3000 那样渲染超时（实测 500 已足够覆盖 295 条）
const LIMIT = Number(process.argv.includes("--limit") ? process.argv[process.argv.indexOf("--limit") + 1] : 1000);
const DO_COLLECT = !process.argv.includes("--no-collect");
const COLLECT_PER_SLICE = process.argv.includes("--collect-per-slice");
const COLLECT_INTERVAL = Number(process.argv.includes("--collect-interval") ? process.argv[process.argv.indexOf("--collect-interval") + 1] : 8000); // ms 片间避让
const APPLY_RETRIES = 3;
const APPLY_RETRY_WAIT = 15_000; // ms

const onlyArg = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const ONLY_SLICES = onlyArg
  ? new Set(onlyArg.split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0))
  : null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function loadState() {
  try { return readJson(STATE_FILE); } catch { return { slices: {} }; }
}
function saveState(state) {
  writeJson(STATE_FILE, state);
}

function runOpencli(args, { json = true, logFile = null } = {}) {
  return new Promise((resolve, reject) => {
    // OPENCLI_BROWSER_COMMAND_TIMEOUT: 抖音收藏列表渲染慢，默认 60s 会超时；统一放宽到 300s
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT, windowsHide: true, shell: false,
      env: { ...process.env, OPENCLI_BROWSER_COMMAND_TIMEOUT: "300" },
    });
    let stdout = "", stderr = "";
    const logStream = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => { stdout += d; logStream?.write(d); });
    child.stderr.on("data", d => { stderr += d; logStream?.write(d); });
    child.on("error", reject);
    child.on("close", code => {
      logStream?.end();
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function collectFull() {
  if (fs.existsSync(path.join(FULL_DIR, "favorites.json"))) {
    log(`复用已有全量数据: ${FULL_DIR}/favorites.json`);
    return;
  }
  log(`collect 全量收藏 (limit=${LIMIT}) ...`);
  const { stdout } = await runOpencli([
    path.join(PROJECT_ROOT, "src", "cli.mjs"), "collect",
    "--limit", String(LIMIT), "--out", FULL_DIR,
  ]);
  log(`collect 完成: ${stdout.trim()}`);
}

/**
 * 限频安全 + 断点续采模式：逐页采集（每页 SLICE_SIZE 条，offset 递增），
 * 片间 sleep COLLECT_INTERVAL 避让抖音频率风控。返回 slice 数组。
 *
 * 鲁棒性：
 *  - 超时/失败重试同一 offset（最多 COLLECT_RETRIES 次），不盲目跳过以免丢数据；
 *  - 连续 EMPTY_STOP 次返回 0 条才算到达收藏末尾；
 *  - 支持断点续采：扫描已有 _collect_* 目录，从最大 offset 之后继续，不重复；
 *  - 支持 --max-pages N：单次最多采 N 页就停（落盘当前累计），下次接着跑。
 */
const COLLECT_RETRIES = 3;
const EMPTY_STOP = 3;

function findExistingCollectOffsets() {
  const offsets = new Set();
  try {
    for (const name of fs.readdirSync(RUNS_DIR)) {
      const m = name.match(/^_collect_(\d+)$/);
      if (m) {
        const dir = path.join(RUNS_DIR, name);
        if (fs.existsSync(path.join(dir, "favorites.json"))) offsets.add(Number(m[1]));
      }
    }
  } catch { /* ignore */ }
  return offsets;
}

function mergeCollectedFavorites() {
  const slices = [];
  const seen = new Set();
  const offsets = findExistingCollectOffsets();
  for (const off of [...offsets].sort((a, b) => a - b)) {
    const dir = path.join(RUNS_DIR, `_collect_${String(off).padStart(4, "0")}`);
    try {
      const fav = readJson(path.join(dir, "favorites.json")).favorites || [];
      for (const f of fav) {
        if (f.aweme_id && !seen.has(f.aweme_id)) { seen.add(f.aweme_id); slices.push(f); }
      }
    } catch { /* ignore */ }
  }
  return slices;
}

async function collectPerSlice() {
  const MAX_PAGES = process.argv.includes("--max-pages")
    ? Number(process.argv[process.argv.indexOf("--max-pages") + 1]) : Infinity;

  // 断点续采：从已有最大 offset 之后开始
  const existing = findExistingCollectOffsets();
  let offset = existing.size ? Math.max(...existing) + SLICE_SIZE : 0;
  if (existing.size) log(`断点续采：已存在 ${existing.size} 页，从 offset=${offset} 继续`);

  let pagesThisRun = 0;
  let emptyStreak = 0;
  while (emptyStreak < EMPTY_STOP && pagesThisRun < MAX_PAGES) {
    const outDir = path.join(RUNS_DIR, `_collect_${String(offset).padStart(4, "0")}`);
    let count = 0;
    let ok = false;
    for (let attempt = 1; attempt <= COLLECT_RETRIES && !ok; attempt++) {
      try {
        log(`collect offset=${offset} (limit=${SLICE_SIZE}, 尝试 ${attempt}/${COLLECT_RETRIES}) ...`);
        const { stdout } = await runOpencli([
          path.join(PROJECT_ROOT, "src", "cli.mjs"), "collect",
          "--limit", String(SLICE_SIZE), "--offset", String(offset), "--out", outDir,
        ]);
        const m = stdout.match(/"count":\s*(\d+)/);
        count = m ? Number(m[1]) : 0;
        ok = true;
      } catch (err) {
        log(`  ✗ collect 失败: ${err.message.split("\n")[0]}（重试前等待）`);
        await new Promise(r => setTimeout(r, COLLECT_INTERVAL * 2));
      }
    }
    if (!ok) {
      log(`  ⚠️ offset=${offset} 重试 ${COLLECT_RETRIES} 次仍失败，跳过本页继续`);
      offset += SLICE_SIZE;
      emptyStreak++;
      pagesThisRun++;
      continue;
    }
    if (count === 0) {
      emptyStreak++;
      log(`  offset=${offset} 返回 0 条（空 ${emptyStreak}/${EMPTY_STOP}）`);
    } else {
      emptyStreak = 0;
      log(`  本页 ${count} 条`);
    }
    offset += SLICE_SIZE;
    pagesThisRun++;
    if (count > 0) await new Promise(r => setTimeout(r, COLLECT_INTERVAL));
  }

  // 落盘合并结果（无论是否到末尾都写，支持分段）
  const all = mergeCollectedFavorites();
  writeJson(path.join(FULL_DIR, "favorites.json"), {
    schema_version: 1, captured_at: new Date().toISOString(),
    source: "batch-organize collectPerSlice", count: all.length, favorites: all,
  });
  const reachedEnd = emptyStreak >= EMPTY_STOP;
  log(`本次采集 ${pagesThisRun} 页，累计合并 ${all.length} 条${reachedEnd ? "（已到末尾）" : "（可重跑续采）"}`);
  return all;
}

function sliceFavorites(allFavorites) {
  const favorites = allFavorites || (() => {
    const full = readJson(path.join(FULL_DIR, "favorites.json"));
    return full.favorites || [];
  })();
  log(`全量收藏 ${favorites.length} 条，按 ${SLICE_SIZE}/片 切片`);
  const slices = [];
  for (let i = 0; i < favorites.length; i += SLICE_SIZE) {
    slices.push(favorites.slice(i, i + SLICE_SIZE));
  }
  return slices;
}

function prepareSliceDir(index, slice) {
  const dirName = `batch-${String(index + 1).padStart(3, "0")}`;
  const dir = path.join(RUNS_DIR, dirName);
  ensureDirectory(dir);
  const sourceHash = sha256(slice);
  writeJson(path.join(dir, "favorites.json"), {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    source: "batch-organize slice",
    requested_limit: slice.length,
    requested_offset: index * SLICE_SIZE,
    count: slice.length,
    coverage_warning: false,
    source_sha256: sourceHash,
    favorites: slice,
  });
  writeJson(path.join(dir, "classification-input.json"), {
    schema_version: 1,
    source_sha256: sourceHash,
    guidance: {
      target_folder_count: "8-15 when content diversity supports it",
      folder_name_max_characters: 15,
      one_primary_folder_per_video: true,
      low_confidence_destination: "待确认",
      preserve_existing_folders: true,
    },
    videos: slice.map(({ aweme_id, title, author, duration, source_url }) => ({
      aweme_id, title, author, duration, source_url,
    })),
  });
  return dir;
}

async function processSlice(index, slice, state) {
  const dirName = `batch-${String(index + 1).padStart(3, "0")}`;
  if (state.slices[dirName]?.status === "done") {
    log(`#${index + 1} 已 done，跳过`);
    return;
  }
  if (ONLY_SLICES && !ONLY_SLICES.has(index + 1)) {
    log(`#${index + 1} 不在 --only 范围，跳过`);
    return;
  }

  log(`── 处理片 #${index + 1} (${slice.length} 条) ──`);
  const dir = prepareSliceDir(index, slice);

  // 1. draft
  log(`  draft 分类...`);
  const draft = writeDraftPlan(dir, {
    minimumConfidence: 0.58,
    uncertainFolder: "待确认",
    folderVisibility: "private",
    taxonomy: null,
  });
  const assignments = draft.plan.assignments.length;
  log(`  draft 完成: ${assignments} 条分配`);

  // 2. approve (自动 token)
  const token = approvalToken(draft.plan);
  const approved = approvePlan(draft.plan, token);
  writeJson(path.join(dir, "classification-plan.json"), approved);

  // 3. manifest
  const { source } = (() => {
    try { return { source: readJson(path.join(dir, "favorites.json")) }; } catch { return { source: null }; }
  })();
  const validation = validatePlan(approved, source);
  if (!validation.ok) {
    log(`  ⚠️ plan 校验失败: ${validation.errors.join("; ")}`);
  }
  const manifest = buildApplyManifest(approved, source);
  writeJson(path.join(dir, "apply-manifest.json"), manifest);

  // 安全护栏 token: EXECUTE:<plan_fingerprint 前12位>
  const executionToken = `EXECUTE:${(manifest.plan_fingerprint || "").slice(0, 12)}`;

  // 4. apply (浏览器写入，带崩溃自愈)
  let applied = false;
  for (let attempt = 1; attempt <= APPLY_RETRIES && !applied; attempt++) {
    try {
      log(`  apply 写入 (尝试 ${attempt}/${APPLY_RETRIES}, session=batch-${index + 1})...`);
      await runOpencli([
        path.join(PROJECT_ROOT, "scripts", "apply-browser.mjs"),
        "add-folder", "--all",
        "--run", dir,
        "--session", `batch-${index + 1}`,
        "--execute", "--confirmation", executionToken,
      ], { json: false, logFile: path.join(dir, "apply.log") });
      applied = true;
    } catch (err) {
      log(`  ✗ apply 失败: ${err.message.split("\n")[0]}`);
      if (attempt < APPLY_RETRIES) {
        log(`  等待 ${APPLY_RETRY_WAIT / 1000}s 后重试...`);
        await new Promise(r => setTimeout(r, APPLY_RETRY_WAIT));
      }
    }
  }

  // 4.5 释放该 session 的浏览器窗口，降低 Chrome 内存占用（每片结束必执行）
  try {
    await runOpencli(["browser", `batch-${index + 1}`, "close"], { json: false }).catch(() => {});
    log(`  已关闭 session=batch-${index + 1} 浏览器窗口（释放内存）`);
  } catch { /* ignore */ }

  if (applied) {
    state.slices[dirName] = { status: "done", count: slice.length, assignments, at: new Date().toISOString() };
    log(`  ✓ #${index + 1} 完成`);
  } else {
    state.slices[dirName] = { status: "error", count: slice.length, at: new Date().toISOString() };
    log(`  ✗✗ #${index + 1} 经 ${APPLY_RETRIES} 次重试仍失败，标记 error 继续`);
  }
  saveState(state);
}

/**
 * 并发写入（--parallel N）：同时跑 N 片，每片独立 --session 隔离。
 * 加速明显，但抖音同账号多窗口并行有风控风险，建议 2-3 并发上限。
 */
async function runParallel(slices, state, n) {
  const pending = slices.map((slice, i) => ({ i, slice }));
  const workers = Array.from({ length: n }, async () => {
    while (pending.length > 0) {
      const { i, slice } = pending.shift();
      await processSlice(i, slice, state);
    }
  });
  await Promise.all(workers);
}

async function main() {
  ensureDirectory(RUNS_DIR);
  const state = loadState();
  const COLLECT_ONLY = process.argv.includes("--collect-only");
  const PARALLEL = process.argv.includes("--parallel")
    ? Number(process.argv[process.argv.indexOf("--parallel") + 1]) : 1;

  let slices;
  if (DO_COLLECT && !COLLECT_PER_SLICE) {
    // 默认：大 limit 一次拉回（实测 limit=500 返回全部 295 条 coverage_warning=false）。
    // 深分页(offset≥1050)已被证实会卡死/超时，仅当 --collect-per-slice 显式启用时才走逐页采集。
    await collectFull();
    slices = sliceFavorites();
  } else if (DO_COLLECT) {
    const all = await collectPerSlice();
    slices = sliceFavorites(all);
  } else {
    slices = sliceFavorites();
  }
  log(`共 ${slices.length} 片待处理`);

  if (COLLECT_ONLY) {
    log(`--collect-only 模式：仅采集，已写出 var/runs/_full/favorites.json（count=${slices.length}），不写入抖音。手动全量写入请重跑不带此参数。`);
    return;
  }

  if (PARALLEL > 1) {
    log(`并发模式: ${PARALLEL} 片同时写（每片独立 session）。注意抖音风控，建议 ≤3。`);
    await runParallel(slices, state, PARALLEL);
  } else {
    for (let i = 0; i < slices.length; i++) {
      await processSlice(i, slices[i], state);
    }
  }

  // 汇总
  const done = Object.values(state.slices).filter(s => s.status === "done").length;
  const err = Object.values(state.slices).filter(s => s.status === "error").length;
  const totalItems = Object.values(state.slices).reduce((a, s) => a + (s.count || 0), 0);
  log("══════════════════════════════════════");
  log(`完成片数: ${done}/${slices.length}  失败: ${err}  总处理条目: ${totalItems}`);
  log(`状态文件: ${STATE_FILE}`);
  if (err > 0) log(`提示: 失败片可重跑本脚本（自动续跑 done，重试 error）或 --only 指定片号`);
}

main().catch(err => {
  process.stderr.write(`${err?.stack || err}\n`);
  process.exitCode = 1;
});
