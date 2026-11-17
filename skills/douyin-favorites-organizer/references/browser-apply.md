# Browser apply contract

## Preflight

1. Confirm the intended Douyin account is signed in without inspecting authentication data.
2. Open `https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection`.
3. Verify `收藏夹`, `视频`, `批量管理`, and `新建收藏夹` are present.
4. Run `inspect-folders` before classification and use the returned current names.
5. Verify the approved plan fingerprint matches the manifest.
6. Stop on UI drift, CAPTCHA, or ambiguous state.

## Create folders

For each missing manifest folder:

1. Open `收藏夹` and click the unique `新建收藏夹` control.
2. Fill the exact name, at most 15 characters.
3. Set `设置为公开` to the manifest visibility. Recurring adaptive folders are public.
4. Submit once.
5. Verify the dialog closed, the exact name is visible, and the private-lock indicator agrees with the requested visibility.

Never rename, delete, merge, or change visibility of an existing folder.

## Add videos

Use `apply-all` as the primary path.

1. Keep the original browser tab as the writer and create one verifier tab in the same signed-in browser session.
2. Read every target folder's baseline `共 N 作品` count from the verifier tab before writing.
3. On the writer tab, open `视频` → `批量管理` once.
4. Form the union of every unverified target `aweme_id`, then match cards by exact numeric `/video/<aweme_id>` links, not titles.
5. Scroll bounded internal containers once until the union is mapped or the list stabilizes. Record persistently absent IDs against their planned folders as `unavailable`; never use a private endpoint to force a write.
6. For each folder batch, require a clean writer state, select only that folder's available IDs, and verify the selected count.
7. Click `加入收藏夹`; never click `取消收藏`. Select the exact folder and submit once.
8. Require the writer tab to return to a clean batch-management state with zero selected video checkboxes.
9. Refresh only the verifier tab and verify the folder count equals its baseline plus the verified batch size. Do not navigate the writer tab away from the loaded video list.
10. Journal baseline, final count, IDs, and status before moving to the next folder. Stop on the first ambiguous writer or verifier result.
11. Close the verifier tab at the end. Use one bounded `add-folder` command only to resume a remaining batch after a stopped `apply-all` run.

An exact batch already marked `verified` in the journal may be skipped. Do not infer success from count alone after an unknown submit.

## Failure handling

- Stop on ambiguous selectors, count mismatches, unknown dialogs, CAPTCHA, missing IDs, or uncertain submit results.
- Do not repeat a submit until visible state proves the first attempt did not apply.
- Resume only from current page state plus the local journal. `apply-all` skips an exact folder-and-ID batch already journaled as `verified`.
- Hand CAPTCHA and login recovery to the user.
- Never use undocumented private endpoints as a fallback.
