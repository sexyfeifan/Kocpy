import { describe, expect, it } from "vitest";
import type { BackupSelectionPlan } from "../src/common/backup-selection";
import { retainConfirmedSelection, discardConfirmedSelections } from "../src/main/backup-selection-cache";

describe("confirmed selection lifetime", () => {
  it("retains every confirmation beyond eight sources until explicit consumption/discard", () => {
    const cache = new Map<string, BackupSelectionPlan>();
    for (let index = 0; index < 12; index++) {
      // The cache owns lifetime only; the finalizer validates real plans.
      const fixture = { id: String(index), includedPaths: [String(index)] } as BackupSelectionPlan;
      retainConfirmedSelection(cache, fixture);
      fixture.includedPaths.push("mutated caller");
    }
    expect(cache.size).toBe(12);
    for (let index = 0; index < 12; index++) expect(cache.get(String(index))?.includedPaths).toEqual([String(index)]);
    discardConfirmedSelections(cache, ["0", "5", "unknown"]);
    expect(cache.size).toBe(10); expect(cache.has("1")).toBe(true);
    discardConfirmedSelections(cache, [...cache.keys()]);
    expect(cache.size).toBe(0);
  });
  it("validates a discard request before deleting any active scope", () => {
    const cache = new Map<string, BackupSelectionPlan>([["one", { id: "one" } as BackupSelectionPlan]]);
    expect(() => discardConfirmedSelections(cache, ["one", 42])).toThrow();
    expect(cache.has("one")).toBe(true);
  });
});
