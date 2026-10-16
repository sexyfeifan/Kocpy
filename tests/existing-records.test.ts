import { describe, expect, it } from "vitest";
import type { BackupTask } from "../src/main/types";
import {
  consolidateExistingRecords,
  deduplicateBoundRoots,
} from "../src/main/existing-records";
import { projectCellStatus } from "../src/main/project-closeout";

function importedTask(
  id: string,
  options: {
    sourcePath?: string;
    status?: BackupTask["status"];
    confidence?: BackupTask["confidence"];
    provenance?: BackupTask["provenance"];
    checksum?: string;
    importedAt?: number;
  } = {},
): BackupTask {
  const checksum = options.checksum || "";
  return {
    id,
    projectId: "project",
    name: "Untitled_202608260150",
    sourcePath: options.sourcePath || "/Volumes/Disk/20260825/FX3/CARD01",
    shootingDate: "2026-08-25",
    devices: ["FX3"],
    provenance: options.provenance || "unverified-import",
    confidence: options.confidence || "unverified",
    importedAt: options.importedAt || 1,
    destinations: [
      {
        id: `destination-${id}`,
        path: options.sourcePath || "/Volumes/Disk/20260825/FX3/CARD01",
        resolvedPath:
          options.sourcePath || "/Volumes/Disk/20260825/FX3/CARD01",
        label: "CARD01",
        verified: options.status === "completed",
        bytesWritten: 0,
        verifiedBytes: options.status === "completed" ? 18_889_601_274 : 0,
      },
    ],
    hashAlgorithm: "sha256",
    namingTemplate: "CARD01",
    status: options.status || "unverified",
    totalFiles: 76,
    completedFiles: 76,
    totalBytes: 18_889_601_274,
    transferredBytes: 18_889_601_274,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords: [
      {
        name: "clip.mov",
        relativePath: "M4ROOT/CLIP/clip.mov",
        size: 18_889_601_274,
        srcChecksum: checksum,
        destinations: [
          {
            path: `${options.sourcePath || "/Volumes/Disk/20260825/FX3/CARD01"}/M4ROOT/CLIP/clip.mov`,
            checksum,
            verified: options.status === "completed",
          },
        ],
      },
    ],
  };
}

describe("existing backup record consolidation", () => {
  it("does not collapse distinct historical mappings at the same path or with identical hashes", () => {
    const differentMappings: Array<Partial<BackupTask>> = [
      { projectId: "different-project" },
      { projectRuleSnapshotId: "different-snapshot" },
      { shootingDate: "2026-08-26" },
      { devices: ["POCKET"] },
      { devices: [] },
      { cameraPosition: "B" },
      { name: "Operator mapped roll" },
    ];
    for (const mapping of differentMappings) {
      for (const samePath of [true, false]) {
        const first = importedTask("first", { checksum: "a".repeat(64), status: "completed", confidence: "baseline", importedAt: 1 });
        const second = { ...importedTask("second", { checksum: "a".repeat(64), status: "completed", confidence: "baseline", importedAt: 2,
          sourcePath: samePath ? first.sourcePath : "/Volumes/Other/Card" }), ...mapping };
        const before = structuredClone([first, second]);
        const result = consolidateExistingRecords([first, second]);
        expect(result.records.map((task) => task.id)).toEqual(["first", "second"]);
        expect(result.duplicateIds).toEqual([]);
        expect(result.aggregateIds).toEqual([]);
        expect([first, second]).toEqual(before);
      }
    }
  });

  it("only removes a true parent union when historical project/day/device/position/rule mapping agrees", () => {
    const parentRoot = "/Volumes/Generated/20260825/FX3";
    const differentMappings: Array<Partial<BackupTask>> = [
      { projectId: "different-project" }, { projectRuleSnapshotId: "different-snapshot" },
      { shootingDate: "2026-08-26" }, { devices: ["POCKET"] }, { devices: [] }, { cameraPosition: "B" },
    ];
    for (const mapping of [{}, ...differentMappings]) {
      const child = importedTask("child", { sourcePath: `${parentRoot}/CARD01` });
      child.name = "Actual roll";
      const parent = { ...importedTask("parent", { sourcePath: parentRoot }), ...mapping };
      parent.name = "Device summary";
      parent.fileRecords = structuredClone(child.fileRecords).map((file) => ({ ...file, relativePath: `CARD01/${file.relativePath}` }));
      const result = consolidateExistingRecords([parent, child]);
      expect(result.aggregateIds).toEqual(Object.keys(mapping).length ? [] : ["parent"]);
      expect(result.records.map((task) => task.id)).toEqual(Object.keys(mapping).length ? ["parent", "child"] : ["child"]);
      expect(result.duplicateIds).toEqual([]);
    }
  });

  it("preserves different per-file assignments and selection confirmations even with identical task-level metadata", () => {
    for (const key of ["dateAllocation", "selection"] as const) {
      for (const samePath of [true, false]) {
        const first = importedTask("first", { checksum: "a".repeat(64), status: "completed", confidence: "baseline" });
        const second = importedTask("second", { checksum: "a".repeat(64), status: "completed", confidence: "baseline",
          sourcePath: samePath ? first.sourcePath : "/Volumes/Other/Card" });
        if (key === "dateAllocation") {
          first.dateAllocation = { schemaVersion: 1, sourceTaskId: first.id, sourceEvidenceDigest: "a".repeat(64), generatedAt: 1, updatedAt: 2,
            groups: [{ id: "clip", label: "clip", relativePaths: [first.fileRecords[0].relativePath], files: 1, bytes: first.fileRecords[0].size,
              suggestionBasis: "user-confirmed", suggestionConfidence: "high", evidence: [], assignedDate: "2026-08-25", confirmedAt: 2, confirmedBy: "DIT" }] };
          second.dateAllocation = structuredClone(first.dateAllocation);
          second.dateAllocation.sourceTaskId = second.id;
          second.dateAllocation.groups[0].assignedDate = "2026-08-26";
        } else {
          first.selection = { assignedDates: { clip: "2026-08-25" }, operator: "DIT", confirmedAt: 2 } as unknown as BackupTask["selection"];
          second.selection = { assignedDates: { clip: "2026-08-26" }, operator: "DIT", confirmedAt: 2 } as unknown as BackupTask["selection"];
        }
        const result = consolidateExistingRecords([first, second]);
        expect(result.records).toHaveLength(2);
        expect(result.duplicateIds).toEqual([]);
        expect(result.aggregateIds).toEqual([]);
      }
    }
  });

  it("turns five imports of the same folder into one trusted material roll", () => {
    const records = [
      importedTask("manifest", {
        provenance: "manifest-import",
        checksum: "abc",
        status: "failed",
        importedAt: 1,
      }),
      importedTask("unverified-1", { importedAt: 2 }),
      importedTask("unverified-2", { importedAt: 3 }),
      importedTask("baseline-1", {
        provenance: "external-baseline",
        confidence: "baseline",
        checksum: "abc",
        status: "completed",
        importedAt: 4,
      }),
      importedTask("baseline-2", {
        provenance: "external-baseline",
        confidence: "baseline",
        checksum: "abc",
        status: "completed",
        importedAt: 5,
      }),
    ];
    const result = consolidateExistingRecords(records);
    expect(result.records).toHaveLength(1);
    expect(result.duplicateIds).toHaveLength(4);
    expect(result.records[0]).toMatchObject({
      id: "baseline-2",
      status: "completed",
      confidence: "baseline",
      totalFiles: 76,
      totalBytes: 18_889_601_274,
    });
    expect(
      projectCellStatus(
        {
          id: "project",
          name: "project",
          devices: ["FX3"],
          volumePrefix: "CARD",
          requiredCopies: 1,
        },
        result.records,
        "2026-08-25",
        "FX3",
      ).statusLabel,
    ).toBe("已满足收工要求");
  });

  it("still merges distinct folders only when every file has matching hashes", () => {
    const first = importedTask("first", {
        sourcePath: "/Volumes/A/CARD01",
        checksum: "same",
        status: "completed",
        confidence: "baseline",
      }),
      second = importedTask("second", {
        sourcePath: "/Volumes/B/CARD01",
        checksum: "same",
        status: "completed",
        confidence: "baseline",
      }),
      unknown = importedTask("unknown", {
        sourcePath: "/Volumes/C/CARD01",
      });
    first.existingAuditTrail = [
      {
        id: "import-a",
        at: 1,
        operator: "A",
        action: "import",
        sourcePath: first.sourcePath,
        summary: "first import",
      },
    ];
    second.existingAuditTrail = [
      {
        id: "import-b",
        at: 2,
        operator: "B",
        action: "import",
        sourcePath: second.sourcePath,
        summary: "second import",
      },
    ];
    const result = consolidateExistingRecords([first, second, unknown]);
    expect(result.records).toHaveLength(2);
    expect(result.duplicateIds).toEqual(["second"]);
    expect(result.records.find((task) => task.id === "first")?.destinations)
      .toHaveLength(2);
    expect(
      result.records.find((task) => task.id === "first")?.existingAuditTrail,
    ).toHaveLength(2);
  });

  it("removes a device parent that is exactly the union of its card folders", () => {
    const root = "/Volumes/Disk/20260825/FX3",
      first = importedTask("card-1", {
        sourcePath: `${root}/CARD01`,
        status: "completed",
        confidence: "baseline",
      }),
      second = importedTask("card-2", {
        sourcePath: `${root}/CARD02`,
        status: "completed",
        confidence: "baseline",
      }),
      parent = importedTask("device-parent", { sourcePath: root });
    second.fileRecords[0].relativePath = "PRIVATE/clip2.mov";
    second.fileRecords[0].name = "clip2.mov";
    parent.fileRecords = [
      {
        ...structuredClone(first.fileRecords[0]),
        relativePath: "CARD01/M4ROOT/CLIP/clip.mov",
      },
      {
        ...structuredClone(second.fileRecords[0]),
        relativePath: "CARD02/PRIVATE/clip2.mov",
      },
      {
        name: "CARD01.mhl",
        relativePath: "CARD01/CARD01.mhl",
        size: 200,
        srcChecksum: "",
        destinations: [],
      },
    ];
    parent.totalFiles = 3;

    const result = consolidateExistingRecords([parent, first, second]);
    expect(result.aggregateIds).toEqual(["device-parent"]);
    expect(result.records.map((task) => task.id).sort()).toEqual([
      "card-1",
      "card-2",
    ]);
  });

  it("retains a flat device folder when it has no descendant card records", () => {
    const flat = importedTask("flat", {
      sourcePath: "/Volumes/Disk/20260826/POCKET",
    });
    const result = consolidateExistingRecords([flat]);
    expect(result.aggregateIds).toEqual([]);
    expect(result.records).toEqual([flat]);
  });

  it("does not mark a baseline with a real manifest difference as safe", () => {
    const task = importedTask("mismatch", {
      status: "completed",
      confidence: "baseline",
    });
    task.externalManifest = {
      path: "/Volumes/Disk/CARD01/CARD01.mhl",
      algorithm: "xxhash32",
      status: "mismatch",
      entries: 1,
      matched: 0,
      missing: ["clip.mov"],
      extra: [],
      sizeMismatches: [],
      checksumMismatches: [],
      checkedAt: Date.now(),
    };
    expect(
      projectCellStatus(
        {
          id: "project",
          name: "project",
          devices: ["FX3"],
          volumePrefix: "CARD",
          requiredCopies: 1,
        },
        [task],
        "2026-08-25",
        "FX3",
      ).complete,
    ).toBe(false);
  });

  it("keeps only the latest binding for the same adopted root", () => {
    const roots = deduplicateBoundRoots([
      { id: "old", path: "/Volumes/Disk/Project", boundAt: 1, provenance: "unverified-import" },
      { id: "new", path: "/Volumes/Disk/Project", boundAt: 2, provenance: "external-baseline" },
    ]);
    expect(roots).toEqual([
      { id: "new", path: "/Volumes/Disk/Project", boundAt: 2, provenance: "external-baseline" },
    ]);
  });

  it("keeps record counts stable across three refresh consolidations", () => {
    let records = [
      importedTask("first", {
        sourcePath: "/Volumes/A/CARD01",
        checksum: "same",
        status: "completed",
        confidence: "baseline",
      }),
      importedTask("second", {
        sourcePath: "/Volumes/B/CARD01",
        checksum: "same",
        status: "completed",
        confidence: "baseline",
      }),
    ];
    const counts: number[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const result = consolidateExistingRecords(records);
      records = result.records;
      counts.push(records.length);
    }
    expect(counts).toEqual([1, 1, 1]);
    expect(records[0].destinations).toHaveLength(2);
  });
});
