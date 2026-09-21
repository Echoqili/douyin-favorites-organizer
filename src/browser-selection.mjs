export function mergeObservedMappedIds(observedIds, mappedRows) {
  const observed = new Set((observedIds || []).map(String));
  for (const row of mappedRows || []) {
    const id = String(row?.id || "");
    if (id) observed.add(id);
  }
  return [...observed];
}

export function mappedIdSignature(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))].sort().join("|");
}

export function partitionMappedTargets(targetIds, mappedIds) {
  const mapped = new Set([...mappedIds].map(String));
  const normalized = targetIds.map(String);
  return {
    available: normalized.filter(id => mapped.has(id)),
    missing: normalized.filter(id => !mapped.has(id)),
  };
}

export function targetCheckboxSelector(awemeId) {
  const id = String(awemeId);
  if (!/^\d{15,}$/u.test(id)) throw new Error(`Invalid aweme_id: ${id}`);
  return `[data-organizer-target="${id}"]`;
}
