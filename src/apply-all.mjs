function batchIds(batch) {
  return (batch.videos || []).map(video => String(video.aweme_id)).filter(Boolean);
}

export async function applyAllFolderBatches({
  batches,
  browser,
  journal,
  isBatchVerified = () => false,
  recordUnavailable = () => {},
}) {
  const folderNames = batches.map(batch => String(batch.folder));
  const baselines = await browser.readFolderCounts(folderNames);
  const pendingBatches = batches.filter(batch => !isBatchVerified(batch));
  const allIds = [...new Set(pendingBatches.flatMap(batchIds))];
  const availability = allIds.length
    ? await browser.scanTargets(allIds)
    : { available: [], missing: [], mapped: 0, attempts: 0 };
  const missing = new Set((availability.missing || []).map(String));
  const results = [];

  for (const batch of batches) {
    const folder = String(batch.folder);
    const ids = batchIds(batch);
    const baselineCount = Number(baselines[folder]);
    if (isBatchVerified(batch)) {
      results.push({
        folder,
        status: "already-verified",
        videos: ids.length,
        baseline_count: baselineCount,
        final_count: baselineCount,
      });
      continue;
    }
    const unavailableIds = ids.filter(id => missing.has(id));
    const availableIds = ids.filter(id => !missing.has(id));

    if (unavailableIds.length) {
      recordUnavailable(folder, unavailableIds);
      journal({
        folder,
        ids: unavailableIds,
        status: "unavailable",
        verifiedCount: 0,
        evidence: "not rendered in Douyin batch management UI after one shared bounded scan",
      });
    }
    if (!availableIds.length) {
      results.push({
        folder,
        status: "unavailable",
        videos: 0,
        baseline_count: baselineCount,
        final_count: baselineCount,
      });
      continue;
    }

    journal({
      folder,
      ids: availableIds,
      status: "started",
      verifiedCount: 0,
      baselineCount,
      evidence: "shared browser scan completed and folder batch opened",
    });
    let submitStarted = false;
    try {
      const initialWriterState = await browser.verifyWriterReady();
      if (!initialWriterState?.ready) {
        throw new Error(`Writer page is not ready before selecting folder: ${folder}`);
      }
      await browser.selectTargets(availableIds);
      await browser.submitToFolder(folder);
      submitStarted = true;
      const writerState = await browser.verifyWriterReady();
      if (!writerState?.ready) {
        throw new Error(`Writer page is not ready after submitting folder: ${folder}`);
      }
      const expectedCount = baselineCount + availableIds.length;
      if (!await browser.verifyFolderCount(folder, expectedCount)) {
        throw new Error(`Folder count did not reach the expected value: ${folder}`);
      }
      journal({
        folder,
        ids: availableIds,
        status: "verified",
        verifiedCount: availableIds.length,
        baselineCount,
        finalCount: expectedCount,
        evidence: "independent verifier tab observed the expected folder item count",
      });
      results.push({
        folder,
        status: "verified",
        videos: availableIds.length,
        baseline_count: baselineCount,
        final_count: expectedCount,
      });
    } catch (error) {
      journal({
        folder,
        ids: availableIds,
        status: submitStarted ? "unknown" : "failed",
        verifiedCount: 0,
        baselineCount,
        evidence: submitStarted
          ? "submit completed but independent verification did not reach a known result"
          : "stopped before destination confirmation",
      });
      throw error;
    }
  }

  return {
    ok: true,
    scan_passes: allIds.length ? 1 : 0,
    mapped_videos: Number(availability.mapped || availability.available?.length || 0),
    unavailable_videos: missing.size,
    results,
  };
}
