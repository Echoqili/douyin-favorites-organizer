import assert from "node:assert/strict";
import test from "node:test";
import { cleanOpencliError, hasDouyinSavedCommand } from "../src/collector.mjs";

test("detects the required douyin saved command in OpenCLI help", () => {
  assert.equal(hasDouyinSavedCommand("  collections [options]\n  saved [options]  [read] List saved videos\n"), true);
});

test("rejects the stock OpenCLI command list without douyin saved", () => {
  assert.equal(hasDouyinSavedCommand("  collections [options]\n  videos [options]\n"), false);
});

test("turns an AUTH_REQUIRED OpenCLI failure into a clean, actionable message", () => {
  const stdout = "ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: Could not resolve the logged-in Douyin account.\n  exitCode: 77\n";
  const stderr = "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n(Use `node --trace-warnings ...`)\n";
  const message = cleanOpencliError(stdout, stderr);
  assert.match(message, /登录态缺失/u);
  assert.doesNotMatch(message, /UNDICI|EnvHttpProxyAgent/u);
});

test("turns a BROWSER_CONNECT failure into a clean, actionable message", () => {
  const stdout = "ok: false\nerror:\n  code: BROWSER_CONNECT\n  message: Browser Bridge extension not connected\n  exitCode: 69\n";
  const message = cleanOpencliError(stdout, "");
  assert.match(message, /浏览器桥未连接/u);
});
