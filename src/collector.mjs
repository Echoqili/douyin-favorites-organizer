import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { ensureDirectory, sha256, timestampId, writeJson } from "./io.mjs";
import { limits, normalizeLimit } from "../opencli-plugin/lib/saved-core.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_OPENCLI = path.join(PROJECT_ROOT, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");

export function hasDouyinSavedCommand(output) {
  return /^\s{2}saved(?:\s|\[)/mu.test(String(output || ""));
}

// 把 OpenCLI 的底层报错转成干净的中文提示（登录缺失/浏览器桥未连接），过滤 UNDICI 警告噪音。
export function cleanOpencliError(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .filter(line => !/UNDICI|EnvHttpProxyAgent|trace-warnings/u.test(line.trim()));
  const cleaned = lines.join("\n").trim();
  if (/BROWSER_CONNECT/u.test(cleaned)) {
    return "浏览器桥未连接：请打开 Chrome/Chromium 并启用 OpenCLI 扩展（chrome://extensions → 开发者模式 → 加载已解压扩展），保持浏览器常驻后重试。";
  }
  if (/AUTH_REQUIRED/u.test(cleaned)) {
    return "抖音登录态缺失：请在已连接浏览器桥的 Chrome 中登录 https://www.douyin.com 后重试。";
  }
  return cleaned || "OpenCLI 执行失败，且无更多错误信息。";
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: { ...process.env, ...options.env },
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
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(cleanOpencliError(stdout, stderr)));
    });
  });
}

export function sanitizeFavorite(row, rank) {
  return {
    rank: Number(row.rank || rank),
    aweme_id: String(row.aweme_id || ""),
    title: String(row.title || "").trim(),
    author: String(row.author || "").trim(),
    duration: Number(row.duration || 0),
    create_time: Number(row.create_time || 0),
    source_url: String(row.source_url || ""),
  };
}

export async function collectFavorites({ limit = limits.default, outputDirectory } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  if (!fs.existsSync(LOCAL_OPENCLI)) {
    throw new Error("Project-local OpenCLI is missing. Run npm install first.");
  }
  const help = await run(process.execPath, [LOCAL_OPENCLI, "douyin", "--help"]);
  if (!hasDouyinSavedCommand(`${help.stdout}\n${help.stderr}`)) {
    throw new Error(
      "OpenCLI command `douyin saved` is unavailable. Run `npm run setup` from the project root, then retry.",
    );
  }
  const { stdout, stderr } = await run(process.execPath, [
    LOCAL_OPENCLI,
    "douyin",
    "saved",
    "--limit",
    String(normalizedLimit),
    "-f",
    "json",
  ]);
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("No favorites were returned. Confirm Browser Bridge and Douyin login first.");
  }
  const favorites = parsed.map(sanitizeFavorite).filter(item => item.aweme_id);
  const ids = new Set(favorites.map(item => item.aweme_id));
  if (ids.size !== favorites.length) throw new Error("Duplicate aweme_id values were returned");

  const directory = outputDirectory || path.join(PROJECT_ROOT, "var", "runs", timestampId());
  ensureDirectory(directory);
  const sourceHash = sha256(favorites);
  const source = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    source: "opencli douyin saved",
    requested_limit: normalizedLimit,
    count: favorites.length,
    coverage_warning: false,
    coverage: {
      complete: true,
      reason: "source_exhausted",
    },
    source_sha256: sourceHash,
    favorites,
  };
  writeJson(path.join(directory, "favorites.json"), source);
  writeJson(path.join(directory, "classification-input.json"), {
    schema_version: 1,
    source_sha256: sourceHash,
    guidance: {
      target_folder_count: "8-15 when content diversity supports it",
      folder_name_max_characters: 15,
      one_primary_folder_per_video: true,
      low_confidence_destination: "待确认",
      preserve_existing_folders: true,
    },
    videos: favorites.map(({ aweme_id, title, author, duration, source_url }) => ({
      aweme_id, title, author, duration, source_url,
    })),
  });
  return { directory, source, stderr: stderr.trim() };
}
