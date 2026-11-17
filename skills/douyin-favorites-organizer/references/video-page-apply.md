# 视频页逐条收集（策略 A）Runbook

## 背景：为什么需要策略 A

抖音「收藏」批量管理界面靠虚拟化 + 无限滚动渲染列表，深埋 / 已删视频的 checkbox 根本不会被挂载出来，导致批量写入只能覆盖约 70%。策略 A 绕开批量管理，直达每条收藏的单视频详情页（`https://www.douyin.com/video/<aweme_id>`），该页面没有虚拟化，收藏夹选择器是确定性 DOM。适合补长尾（几十条），不适合全量（几千条，逐页导航更慢且更易触发风控）。

## 命令一览（`npm run video-page <command>`）

| 命令 | 作用 | 是否写 |
| --- | --- | --- |
| `inspect --run <dir>` | 只读，列出待处理视频 + 反查出的目标夹 | 否 |
| `probe --run <dir> [--id <aweme_id>]` | 只读，打开单视频页 dump 真实 DOM（校准选择器） | 否 |
| `observe --run <dir> [--id <aweme_id>]` | 只读，勾选目标夹同时观察网络流量 | 否 |
| `apply --run <dir> [--limit N] [--dry-run=false]` | 逐页写入 | 是 |

写入必须显式 `--execute --confirmation EXECUTE:<plan_fingerprint 前 12 位>`，否则拒绝执行。默认 dry-run。

## observe 判读要点（核心）

`observe` 输出里重点看四个字段：

- `marked.checkedBefore` —— 目标夹当前是否已勾选（`false` = 尚未收藏到该夹，符合预期）。
- `checkedAfter.checked` —— 勾选后 checkbox 态（`true` = UI 已勾选；但 **UI 态 ≠ 服务端态**，这是历史卡点的根因）。
- `networkAfter` —— 勾选后 6 秒内的网络请求列表（已过滤静态资源）。
- `confirmButtons` —— 弹窗内所有可见按钮（判断是否存在「保存 / 确定」提交按钮）。

### 三种情况对号入座

1. **`networkAfter` 里有 `POST` 且 URL 含 `collect` / `folder` / `commit`** → 「勾选即提交」。
   结论：`pickFolderAndConfirm` 里「等保存按钮」这一步是多余/错误的，应删除保存步骤，改用
   `wait xhr <endpoint>` 做确定性校验。

2. **`networkAfter` 为空，但 `checkedAfter=true`** → 勾选只改 UI 不提交，提交动作在别处
   （关闭弹窗 / 点「保存」/ 点空白处）。下一步在 `observe` 里补试这些动作，每次动作后再 dump 网络。

3. **`networkAfter` 为空且 `checkedAfter=false`** → 点击没生效。检查 `marked.controlTag` 是
   `span.semi-checkbox` 还是 `input`，换一个控件定位重试。

### 拿到 endpoint 后如何固化

把 `waitForSaveButton` 替换为 `browser wait xhr <endpoint-regex>`，用确定性网络屏障替代「猜保存按钮」，
并保留 `readNetwork` 证据写入 journal。

## 安全红线

- 写入必须 `--execute --confirmation`，默认 dry-run。
- 逐页导航更易触发风控，每条间隔 2~5s 随机抖动；真实写入前先 3~5 条小批量验证账号未受限。
- 永不点「取消收藏」、永不删除 / 重命名 / 合并收藏夹。
- 建议每次用 `--session <新名>` 隔离旧 session 的残留状态。

## 已验证的 DOM 定位（真机校准，若失效先跑 `probe` 复核）

- 收藏按钮：`div[data-e2e="video-player-collect"]`（纯图标无文字）。
- 弹窗勾选控件：`span.semi-checkbox`（约 15 个收藏夹，**懒加载**，靠后的夹需滚动才会渲染）。
- 目标夹行：夹名 SPAN 向上 2 层是含 `span.semi-checkbox` 的行容器。
- 勾选态：行内 `input[type=checkbox].checked`。
- `source_url` 的 `/video/` 可能重定向到 `/note/`（图文笔记）。
