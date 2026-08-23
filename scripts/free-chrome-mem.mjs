#!/usr/bin/env node
/**
 * free-chrome-mem.mjs — 手动释放抖音整理脚本占用的 Chrome 内存
 *
 * 适用场景：
 *  - 全量写入跑了很久，Chrome 内存涨太高、开始卡顿/崩溃
 *  - 想在不杀掉自己其它 Chrome 标签页的前提下，只清掉 organize 用的浏览器窗口
 *
 * 注意：本脚本只关 opencli 管理的 session 窗口（batch-NNN / douyin-organizer-apply），
 *       不会动你手动打开的普通 Chrome 标签页。
 *
 * 用法：
 *   node scripts/free-chrome-mem.mjs              # 关闭所有 batch-NNN 写入 session
 *   node scripts/free-chrome-mem.mjs --all        # 同时关闭默认 organizer session
 *   node scripts/free-chrome-mem.mjs --kill-stray # 额外提示如何杀游离 Chrome（谨慎）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = path.join(PROJECT_ROOT, "var", "runs");
const OPENCLI = path.join(PROJECT_ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const INCLUDE_ALL = process.argv.includes("--all");
const KILL_STRAY = process.argv.includes("--kill-stray");

function runOpencliBrowserClose(session) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OPENCLI, "browser", session, "close"], {
      cwd: PROJECT_ROOT, windowsHide: true, shell: false,
    });
    child.on("close", () => resolve());
  });
}

async function main() {
  const sessions = [];
  try {
    for (const name of fs.readdirSync(RUNS_DIR)) {
      if (/^batch-\d{3}$/.test(name)) sessions.push(name);
    }
  } catch { /* ignore */ }
  if (INCLUDE_ALL) sessions.push("douyin-organizer-apply");

  if (sessions.length === 0) {
    console.log("未发现 organize 相关 session，无需清理。");
  } else {
    for (const s of sessions) {
      console.log(`关闭 session: ${s} ...`);
      await runOpencliBrowserClose(s);
    }
    console.log(`已请求关闭 ${sessions.length} 个 session 窗口。`);
  }

  if (KILL_STRAY) {
    console.log("\n⚠️ --kill-stray 提示：");
    console.log("  若上述关闭后仍内存偏高，可手动在任务管理器结束 chrome.exe，");
    console.log("  或管理员 CMD 执行: taskkill /F /IM chrome.exe");
    console.log("  （会关闭你所有 Chrome 窗口，包括普通浏览，谨慎！）");
  }

  console.log("完成。普通 Chrome 标签页不受影响。");
}

main();
