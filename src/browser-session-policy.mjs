const DOUYIN_FAVORITES_URL = "https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection";

export function douyinFavoritesUrl() {
  return DOUYIN_FAVORITES_URL;
}

export function browserWindowMode(command) {
  return command === "inspect-folders" || command === "close"
    ? "background"
    : "foreground";
}

export function browserSessionPolicy(command) {
  // 默认复用现有 session（不每次暴力 close+open），只有 ensureSession 检测到
  // 页面不在抖音收藏界面时才重新 open。避免把活着的 session 搞死 / 新窗口起不来崩溃。
  return {
    windowMode: browserWindowMode(command),
    resetExisting: false,
  };
}
