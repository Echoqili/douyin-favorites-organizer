import test from "node:test";
import assert from "node:assert/strict";
import { mergeObservedMappedIds, mappedIdSignature, partitionMappedTargets, targetCheckboxSelector } from "../src/browser-selection.mjs";

test("partitions persistently missing videos instead of failing the whole batch", () => {
  assert.deepEqual(
    partitionMappedTargets(["1", "2", "3"], ["1", "3"]),
    { available: ["1", "3"], missing: ["2"] },
  );
});

test("targets the controlled checkbox input instead of its inert wrapper", () => {
  assert.equal(
    targetCheckboxSelector("7671222361748659611"),
    '[data-organizer-target="7671222361748659611"]',
  );
});


test("accumulates mapped IDs across virtualized DOM snapshots and detects membership changes", () => {
  const first = mergeObservedMappedIds([], [{ id: "1" }, { id: "2" }]);
  const second = mergeObservedMappedIds(first, [{ id: "2" }, { id: "3" }]);
  assert.deepEqual(second, ["1", "2", "3"]);
  assert.notEqual(mappedIdSignature(["1", "2"]), mappedIdSignature(["2", "3"]));
});
