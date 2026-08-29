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
      ).label,
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
    const result = consolidateExistingRecords([first, second, unknown]);
    expect(result.records).toHaveLength(2);
    expect(result.duplicateIds).toEqual(["second"]);
    expect(result.records.find((task) => task.id === "first")?.destinations)
      .toHaveLength(2);
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
});
