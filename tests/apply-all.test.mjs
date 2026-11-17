import test from "node:test";
import assert from "node:assert/strict";
import { applyAllFolderBatches } from "../src/apply-all.mjs";

test("applies multiple folder batches after one saved-video scan", async () => {
  const folderCounts = new Map([
    ["AI工具", 10],
    ["视频创作", 20],
  ]);
  let selectedIds = [];
  let scanPasses = 0;

  const result = await applyAllFolderBatches({
    batches: [
      { folder: "AI工具", videos: [{ aweme_id: "100000000000001" }, { aweme_id: "100000000000002" }] },
      { folder: "视频创作", videos: [{ aweme_id: "100000000000003" }] },
    ],
    browser: {
      readFolderCounts: async folders => Object.fromEntries(folders.map(folder => [folder, folderCounts.get(folder)])),
      scanTargets: async ids => {
        scanPasses += 1;
        return { available: ids, missing: [], mapped: ids.length, attempts: 4 };
      },
      selectTargets: async ids => { selectedIds = [...ids]; },
      submitToFolder: async folder => {
        folderCounts.set(folder, folderCounts.get(folder) + selectedIds.length);
        selectedIds = [];
      },
      verifyWriterReady: async () => ({ ready: selectedIds.length === 0 }),
      verifyFolderCount: async (folder, expected) => folderCounts.get(folder) === expected,
    },
    journal: () => {},
  });

  assert.deepEqual(result, {
    ok: true,
    scan_passes: 1,
    mapped_videos: 3,
    deferred_videos: 0,
    unavailable_videos: 0,
    results: [
      { folder: "AI工具", status: "verified", videos: 2, baseline_count: 10, final_count: 12 },
      { folder: "视频创作", status: "verified", videos: 1, baseline_count: 20, final_count: 21 },
    ],
  });
  assert.equal(scanPasses, 1);
});

test("resumes by skipping an exact batch already verified in the journal", async () => {
  const scanned = [];
  const submitted = [];
  const counts = new Map([["已完成", 8], ["待处理", 3]]);

  const result = await applyAllFolderBatches({
    batches: [
      { folder: "已完成", videos: [{ aweme_id: "100000000000011" }] },
      { folder: "待处理", videos: [{ aweme_id: "100000000000012" }] },
    ],
    isBatchVerified: batch => batch.folder === "已完成",
    browser: {
      readFolderCounts: async folders => Object.fromEntries(folders.map(folder => [folder, counts.get(folder)])),
      scanTargets: async ids => {
        scanned.push(...ids);
        return { available: ids, missing: [], mapped: ids.length, attempts: 1 };
      },
      selectTargets: async () => {},
      submitToFolder: async folder => { submitted.push(folder); counts.set(folder, counts.get(folder) + 1); },
      verifyWriterReady: async () => ({ ready: true }),
      verifyFolderCount: async (folder, expected) => counts.get(folder) === expected,
    },
    journal: () => {},
  });

  assert.deepEqual({ scanned, submitted, results: result.results }, {
    scanned: ["100000000000012"],
    submitted: ["待处理"],
    results: [
      { folder: "已完成", status: "already-verified", videos: 1, baseline_count: 8, final_count: 8 },
      { folder: "待处理", status: "verified", videos: 1, baseline_count: 3, final_count: 4 },
    ],
  });
});

test("stops before the next folder when the writer page is no longer clean", async () => {
  const submitted = [];
  const journalStatuses = [];
  const readyStates = [true, true, false];
  const counts = new Map([["第一批", 1], ["第二批", 2]]);

  await assert.rejects(() => applyAllFolderBatches({
    batches: [
      { folder: "第一批", videos: [{ aweme_id: "100000000000021" }] },
      { folder: "第二批", videos: [{ aweme_id: "100000000000022" }] },
    ],
    browser: {
      readFolderCounts: async folders => Object.fromEntries(folders.map(folder => [folder, counts.get(folder)])),
      scanTargets: async ids => ({ available: ids, missing: [], mapped: ids.length, attempts: 1 }),
      selectTargets: async () => {},
      submitToFolder: async folder => { submitted.push(folder); counts.set(folder, counts.get(folder) + 1); },
      verifyWriterReady: async () => ({ ready: readyStates.shift() }),
      verifyFolderCount: async (folder, expected) => counts.get(folder) === expected,
    },
    journal: entry => { journalStatuses.push(`${entry.folder}:${entry.status}`); },
  }), /not ready before selecting folder/u);

  assert.deepEqual({ submitted, journalStatuses }, {
    submitted: ["第一批"],
    journalStatuses: [
      "第一批:started",
      "第一批:verified",
      "第二批:started",
      "第二批:failed",
    ],
  });
});

test("defers videos missing from a bounded scan and still applies available videos", async () => {
  const deferred = [];
  const submittedSelections = [];
  let selected = [];
  let count = 4;

  const result = await applyAllFolderBatches({
    batches: [{
      folder: "混合批次",
      videos: [{ aweme_id: "100000000000031" }, { aweme_id: "100000000000032" }],
    }],
    browser: {
      readFolderCounts: async () => ({ 混合批次: count }),
      scanTargets: async () => ({
        available: ["100000000000032"],
        missing: ["100000000000031"],
        mapped: 1,
        attempts: 8,
      }),
      selectTargets: async ids => { selected = [...ids]; },
      submitToFolder: async () => { submittedSelections.push([...selected]); count += selected.length; selected = []; },
      verifyWriterReady: async () => ({ ready: selected.length === 0 }),
      verifyFolderCount: async (_folder, expected) => count === expected,
    },
    recordDeferred: (folder, ids) => { deferred.push({ folder, ids }); },
    journal: () => {},
  });

  assert.deepEqual({ deferred, submittedSelections, summary: result }, {
    deferred: [{ folder: "混合批次", ids: ["100000000000031"] }],
    submittedSelections: [["100000000000032"]],
    summary: {
      ok: true,
      scan_passes: 1,
      mapped_videos: 1,
      deferred_videos: 1,
      unavailable_videos: 0,
      results: [
        { folder: "混合批次", status: "verified", videos: 1, baseline_count: 4, final_count: 5 },
      ],
    },
  });
});
