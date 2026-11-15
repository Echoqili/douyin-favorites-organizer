import test from "node:test";
import assert from "node:assert/strict";
import { browserSessionPolicy, browserWindowMode, douyinFavoritesUrl } from "../src/browser-session-policy.mjs";

test("account-write browser commands require a foreground window", () => {
  assert.equal(browserWindowMode("inspect-folders"), "background");
  assert.equal(browserWindowMode("preflight"), "foreground");
  assert.equal(browserWindowMode("create-folders"), "foreground");
  assert.equal(browserWindowMode("add-folder"), "foreground");
});

test("account-write commands reuse the existing session and require a foreground window", () => {
  assert.deepEqual(browserSessionPolicy("inspect-folders"), {
    windowMode: "background",
    resetExisting: false,
  });
  assert.deepEqual(browserSessionPolicy("preflight"), {
    windowMode: "foreground",
    resetExisting: false,
  });
  assert.deepEqual(browserSessionPolicy("create-folders"), {
    windowMode: "foreground",
    resetExisting: false,
  });
  assert.deepEqual(browserSessionPolicy("add-folder"), {
    windowMode: "foreground",
    resetExisting: false,
  });
});

test("browser sessions enter Douyin through the real favorites route", () => {
  assert.equal(
    douyinFavoritesUrl(),
    "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection",
  );
});
