import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/catalog";
import { Storage } from "../src/main/storage";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import { WorkspaceRepository } from "../src/main/workspace";
import {
  sealWorkspaceState,
  validateWorkspaceState,
} from "../src/main/workspace-contract";
import { updateArchiveEvidence } from "../src/main/archive-evidence";
import {
  applyCardDateAllocationDecisions,
  cardDateAllocationDigest,
} from "../src/main/mixed-day-delivery";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-workspace-"));
  roots.push(root);
  return {
    root,
    storage: new Storage(root),
    catalog: new CatalogDatabase(root),
  };
}

function task(id: string, checkpoint = 1): BackupTask {
  return {
    id,
    name: id,
    sourcePath: `/Volumes/${id}`,
    devices: [],
    destinations: [],
    hashAlgorithm: "sha256",
    namingTemplate: "{name}",
    status: "completed",
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords: [],
    createdAt: 1,
    lastCheckpointAt: checkpoint,
  };
}

function taskWithFiles(id: string, names: string[]): BackupTask {
  const next = task(id);
  next.projectId = "project-files";
  next.destinations = [
    {
      id: `destination-${id}`,
      path: `/Volumes/BACKUP/${id}`,
      resolvedPath: `/Volumes/BACKUP/${id}`,
      label: "BACKUP",
      verified: true,
      bytesWritten: 0,
    },
  ];
  next.fileRecords = names.map((name, index) => ({
    name,
    relativePath: `DCIM/${name}`,
    size: index + 1,
    srcChecksum: String(index + 1).padStart(64, "0"),
    destinations: [
      {
        path: `/Volumes/BACKUP/${id}/DCIM/${name}`,
        checksum: String(index + 1).padStart(64, "0"),
        verified: true,
      },
    ],
  }));
  next.totalFiles = next.completedFiles = next.fileRecords.length;
  next.totalBytes = next.transferredBytes = next.fileRecords.reduce(
    (total, file) => total + file.size,
    0,
  );
  next.destinations[0].bytesWritten = next.totalBytes;
  return next;
}

function project(id: string): ProjectConfig {
  return { id, name: id, devices: ["A"], volumePrefix: "A_" };
}

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const allocationGroupId = (relativePaths: string[]) =>
  createHash("sha256")
    .update([...relativePaths].sort().join("\0"))
    .digest("hex")
    .slice(0, 24);

function mixedDayTask(): BackupTask {
  const value = task("mixed-day-authority"),
    sourceRoot = "/Volumes/VERIFIED/A001",
    destinationParent = "/Volumes/DELIVERY",
    runId = "11111111-1111-4111-8111-111111111111",
    records = [
      { relativePath: "DCIM/20260915/C001.MOV", size: 11 },
      { relativePath: "DCIM/20260915/C001.XML", size: 7 },
      { relativePath: "DCIM/20260915/C002.MOV", size: 13 },
    ].map((record) => {
      const checksum = digest(record.relativePath);
      return {
        name: path.basename(record.relativePath),
        ...record,
        srcChecksum: checksum,
        destinations: [
          {
            path: path.join(sourceRoot, record.relativePath),
            checksum,
            verified: true,
          },
        ],
      };
    }),
    facts = records
      .map((record) => ({
        relativePath: record.relativePath.normalize("NFC"),
        size: record.size,
        checksum: record.srcChecksum,
      }))
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      ),
    group = (relativePaths: string[]) => ({
      id: allocationGroupId(relativePaths),
      label: path.basename(relativePaths[0], path.extname(relativePaths[0])),
      relativePaths,
      files: relativePaths.length,
      bytes: records
        .filter((record) => relativePaths.includes(record.relativePath))
        .reduce((sum, record) => sum + record.size, 0),
      suggestionBasis: "user-confirmed" as const,
      suggestionConfidence: "high" as const,
      evidence: [],
      assignedDate: "2026-09-15",
      confirmedAt: 2,
      confirmedBy: "DIT",
    });
  value.projectId = "project-mixed-day";
  value.name = "A001";
  value.destinations = [
    {
      id: "verified-copy",
      path: "/Volumes/VERIFIED",
      resolvedPath: sourceRoot,
      label: "工作盘",
      verified: true,
      bytesWritten: 31,
    },
  ];
  value.fileRecords = records;
  value.totalFiles = value.completedFiles = records.length;
  value.totalBytes = value.transferredBytes = 31;
  value.dateAllocation = {
    schemaVersion: 1,
    sourceTaskId: value.id,
    sourceEvidenceDigest: createHash("sha256")
      .update(JSON.stringify(facts))
      .digest("hex"),
    generatedAt: 1,
    updatedAt: 2,
    groups: [
      group(["DCIM/20260915/C001.MOV", "DCIM/20260915/C001.XML"]),
      group(["DCIM/20260915/C002.MOV"]),
    ],
  };
  const finalPath = path.join(destinationParent, "20260915_A001_当日交付"),
    reportDirectory = path.join(finalPath, "Kocpy报告"),
    base = `Kocpy_20260915_${runId.slice(0, 8)}`;
  value.dailyDeliveryRuns = [
    {
      id: runId,
      sourceTaskId: value.id,
      projectId: value.projectId,
      projectNameSnapshot: "测试项目",
      shootingDate: "2026-09-15",
      operator: "DIT",
      createdAt: 3,
      startedAt: 4,
      completedAt: 6,
      status: "completed",
      sourceDestinationId: "verified-copy",
      sourceRoot,
      sourceVolumeId: "source-volume-id",
      destinationParent,
      finalPath,
      destinationVolumeId: "destination-volume-id",
      hashAlgorithm: "sha256",
      allocationDigest: cardDateAllocationDigest(value.dateAllocation),
      totalFiles: records.length,
      totalBytes: 31,
      completedFiles: records.length,
      completedBytes: 31,
      files: records.map((record) => ({
        relativePath: record.relativePath,
        size: record.size,
        sourceChecksum: record.srcChecksum,
        sourceVerifiedAt: 5,
        deliveredChecksum: record.srcChecksum,
        verified: true,
      })),
      manifestPaths: [
        path.join(reportDirectory, `${base}_当日交付清单.json`),
        path.join(reportDirectory, `${base}_当日交付清单.mhl`),
      ],
      reportStatus: "completed",
      reportPaths: [path.join(reportDirectory, `${base}_当日交付报告.pdf`)],
      reportSha256: {
        [path.join(reportDirectory, `${base}_当日交付报告.pdf`)]:
          digest("report"),
      },
    },
  ];
  return value;
}

function sealTask(value: BackupTask) {
  return sealWorkspaceState({
    schemaVersion: 1,
    revision: 1,
    committedAt: 1,
    tasks: [value],
    projects: [],
    taskTombstones: [],
    projectTombstones: [],
  });
}

function completeScopeTask() {
  const value = taskWithFiles("complete-scope", ["A.mov", "B.mov"]);
  value.inventoryPolicy = {
    version: "complete-v2",
    mode: "complete",
    createdAt: 1,
    includeHidden: true,
    includeAppleDouble: true,
    includeSystemMetadata: true,
    includeEmptyDirectories: true,
    symlinkPolicy: "fail",
    specialFilePolicy: "fail",
  };
  value.inventoryScope = {
    policy: value.inventoryPolicy,
    capturedAt: 2,
    sourcePath: value.sourcePath,
    fingerprint: "a".repeat(64),
    includedFiles: value.totalFiles,
    includedBytes: value.totalBytes,
    includedDirectories: 2,
    includedDirectoryPaths: ["DCIM", "DCIM/EMPTY"],
    excludedFiles: 0,
    excludedDirectories: 0,
    excludedBytes: 0,
    exclusions: [],
  };
  return value;
}

describe("workspace authority and reconciliation", () => {
  it("rejects malformed file identities and destination matrices for generic tasks", () => {
    const traversal = taskWithFiles("traversal", ["A.mov"]);
    traversal.fileRecords[0].relativePath = "DCIM/../A.mov";
    expect(() => sealTask(traversal)).toThrow(/文件记录或目的地矩阵无效/);

    const nameMismatch = taskWithFiles("name-mismatch", ["A.mov"]);
    nameMismatch.fileRecords[0].name = "B.mov";
    expect(() => sealTask(nameMismatch)).toThrow(
      /文件记录或目的地矩阵无效/,
    );

    const duplicate = taskWithFiles("duplicate", ["A.mov"]);
    duplicate.fileRecords.push(structuredClone(duplicate.fileRecords[0]));
    expect(() => sealTask(duplicate)).toThrow(/文件记录或目的地矩阵无效/);

    const nfcConflict = taskWithFiles("nfc-conflict", ["\u00e9.mov"]),
      decomposed = structuredClone(nfcConflict.fileRecords[0]);
    decomposed.name = "e\u0301.mov";
    decomposed.relativePath = "DCIM/e\u0301.mov";
    decomposed.destinations[0].path =
      "/Volumes/BACKUP/nfc-conflict/DCIM/e\u0301.mov";
    nfcConflict.fileRecords.push(decomposed);
    expect(() => sealTask(nfcConflict)).toThrow(
      /文件记录或目的地矩阵无效/,
    );

    const missingDestination = taskWithFiles("missing-result", ["A.mov"]);
    missingDestination.fileRecords[0].destinations = [];
    expect(() => sealTask(missingDestination)).toThrow(
      /文件记录或目的地矩阵无效/,
    );

    const escapedDestination = taskWithFiles("escaped-result", ["A.mov"]);
    escapedDestination.fileRecords[0].destinations[0].path =
      "/Volumes/OTHER/A.mov";
    expect(() => sealTask(escapedDestination)).toThrow(
      /文件记录或目的地矩阵无效/,
    );
  });

  it("retains legitimate interrupted destination placeholders", () => {
    const interrupted = taskWithFiles("interrupted-placeholder", ["A.mov"]);
    interrupted.status = "failed";
    interrupted.fileRecords[0].destinations[0] = {
      path: "",
      checksum: "",
      verified: false,
    };
    expect(() => sealTask(interrupted)).not.toThrow();
  });

  it("round-trips canonical mixed-day allocation and delivery checkpoints", () => {
    const completed = mixedDayTask();
    expect(() => sealTask(completed)).not.toThrow();

    const pending = structuredClone(completed),
      pendingRun = pending.dailyDeliveryRuns![0];
    pendingRun.status = "pending";
    pendingRun.startedAt = undefined;
    pendingRun.completedAt = undefined;
    pendingRun.completedFiles = 0;
    pendingRun.completedBytes = 0;
    pendingRun.files = [];
    pendingRun.manifestPaths = undefined;
    pendingRun.reportStatus = undefined;
    pendingRun.reportPaths = undefined;
    pendingRun.reportSha256 = undefined;
    expect(() => sealTask(pending)).not.toThrow();

    const publishing = structuredClone(completed),
      publishingRun = publishing.dailyDeliveryRuns![0],
      nextPath = publishing.fileRecords[1].relativePath,
      output = path.join(publishingRun.finalPath, "Media", nextPath);
    publishingRun.status = "running";
    publishingRun.completedAt = undefined;
    publishingRun.files = publishingRun.files.slice(0, 1);
    publishingRun.completedFiles = 1;
    publishingRun.completedBytes = publishingRun.files[0].size;
    publishingRun.manifestPaths = undefined;
    publishingRun.reportStatus = undefined;
    publishingRun.reportPaths = undefined;
    publishingRun.reportSha256 = undefined;
    publishingRun.publicationInProgress = {
      relativePath: nextPath,
      finalPath: output,
      stagingPath: `${output}.partial-${publishingRun.id}`,
    };
    expect(() => sealTask(publishing)).not.toThrow();

    const failedAfterManifest = structuredClone(completed),
      failedRun = failedAfterManifest.dailyDeliveryRuns![0];
    failedRun.status = "failed";
    failedRun.error = "最终工作区检查点未能提交";
    failedRun.reportStatus = undefined;
    failedRun.reportPaths = undefined;
    failedRun.reportSha256 = undefined;
    expect(() => sealTask(failedAfterManifest)).not.toThrow();

    const movedSourceAfterCompletion = structuredClone(completed);
    movedSourceAfterCompletion.destinations[0].resolvedPath =
      "/Volumes/RELINKED/A001";
    movedSourceAfterCompletion.destinations[0].verified = false;
    movedSourceAfterCompletion.destinations[0].available = false;
    for (const record of movedSourceAfterCompletion.fileRecords) {
      record.destinations[0].path = path.join(
        "/Volumes/RELINKED/A001",
        record.relativePath,
      );
      record.destinations[0].verified = false;
    }
    expect(() => sealTask(movedSourceAfterCompletion)).not.toThrow();
  });

  it("preserves completed delivery evidence across same and changed date re-confirmation", () => {
    const sameAssignment = mixedDayTask(),
      sameHistorical = structuredClone(sameAssignment.dailyDeliveryRuns![0]),
      sameOldDigest = sameHistorical.allocationDigest;
    applyCardDateAllocationDecisions(
      sameAssignment,
      sameAssignment.dateAllocation!,
      sameAssignment.dateAllocation!.groups.map((group) => ({
        groupId: group.id,
        shootingDate: group.assignedDate,
      })),
      "复核 DIT",
      10,
    );
    expect(cardDateAllocationDigest(sameAssignment.dateAllocation!)).not.toBe(
      sameOldDigest,
    );
    const sameReloaded = validateWorkspaceState(
      JSON.parse(JSON.stringify(sealTask(sameAssignment))),
    );
    expect(sameReloaded.tasks[0].dailyDeliveryRuns![0]).toEqual(sameHistorical);

    const changedAssignment = mixedDayTask(),
      historical = structuredClone(changedAssignment.dailyDeliveryRuns![0]),
      [, movedGroup] = changedAssignment.dateAllocation!.groups;
    applyCardDateAllocationDecisions(
      changedAssignment,
      changedAssignment.dateAllocation!,
      changedAssignment.dateAllocation!.groups.map((group) => ({
        groupId: group.id,
        shootingDate: group.id === movedGroup.id ? "2026-09-16" : "2026-09-15",
      })),
      "复核 DIT",
      11,
    );
    const newDigest = cardDateAllocationDigest(
        changedAssignment.dateAllocation!,
      ),
      pending = structuredClone(historical);
    pending.id = "22222222-2222-4222-8222-222222222222";
    pending.shootingDate = "2026-09-16";
    pending.operator = "复核 DIT";
    pending.createdAt = 12;
    pending.startedAt = undefined;
    pending.completedAt = undefined;
    pending.status = "pending";
    pending.finalPath = path.join(
      pending.destinationParent,
      "20260916_A001_当日交付",
    );
    pending.allocationDigest = newDigest;
    pending.totalFiles = 1;
    pending.totalBytes = 13;
    pending.completedFiles = 0;
    pending.completedBytes = 0;
    pending.files = [];
    pending.publicationInProgress = undefined;
    pending.recoveryArtifacts = undefined;
    pending.manifestPaths = undefined;
    pending.reportStatus = undefined;
    pending.reportPaths = undefined;
    pending.reportSha256 = undefined;
    pending.reportError = undefined;
    pending.error = undefined;
    changedAssignment.dailyDeliveryRuns!.push(pending);

    const changedReloaded = validateWorkspaceState(
      JSON.parse(JSON.stringify(sealTask(changedAssignment))),
    );
    expect(changedReloaded.tasks[0].dailyDeliveryRuns![0]).toEqual(historical);
    expect(
      changedReloaded.tasks[0].dailyDeliveryRuns![1].allocationDigest,
    ).toBe(newDigest);
    expect(historical.allocationDigest).not.toBe(newDigest);

    const staleActive = structuredClone(changedAssignment);
    staleActive.dailyDeliveryRuns![1].allocationDigest =
      historical.allocationDigest;
    expect(() => sealTask(staleActive)).toThrow(/结构、标识或路径无效/);
  });

  it("cross-checks complete-v2 scope totals and canonical directory paths", () => {
    expect(() => sealTask(completeScopeTask())).not.toThrow();
    const cases: Array<{
      name: string;
      mutate: (value: BackupTask) => void;
    }> = [
      {
        name: "included file count",
        mutate: (value) => {
          value.inventoryScope!.includedFiles++;
        },
      },
      {
        name: "included byte count",
        mutate: (value) => {
          value.inventoryScope!.includedBytes++;
        },
      },
      {
        name: "duplicate directory",
        mutate: (value) => {
          value.inventoryScope!.includedDirectoryPaths = ["DCIM", "DCIM"];
        },
      },
      {
        name: "unicode-normalized duplicate directory",
        mutate: (value) => {
          value.inventoryScope!.includedDirectoryPaths = ["é", "e\u0301"];
        },
      },
      {
        name: "directory traversal",
        mutate: (value) => {
          value.inventoryScope!.includedDirectoryPaths[1] = "../escape";
        },
      },
      {
        name: "non-canonical directory",
        mutate: (value) => {
          value.inventoryScope!.includedDirectoryPaths[1] = "DCIM/./EMPTY";
        },
      },
    ];
    for (const item of cases) {
      const value = completeScopeTask();
      item.mutate(value);
      expect(() => sealTask(value), item.name).toThrow(/文件范围快照无效/);
    }
  });

  it("rejects forged or non-canonical mixed-day allocation evidence", () => {
    const cases: Array<{
      name: string;
      mutate: (value: BackupTask) => void;
      message: RegExp;
    }> = [
      {
        name: "source digest",
        mutate: (value) => {
          value.dateAllocation!.sourceEvidenceDigest = "0".repeat(64);
        },
        message: /文件证据不一致/,
      },
      {
        name: "group id",
        mutate: (value) => {
          value.dateAllocation!.groups[0].id = "0".repeat(24);
        },
        message: /分组与任务文件记录不一致/,
      },
      {
        name: "unknown traversal path",
        mutate: (value) => {
          value.dateAllocation!.groups[0].relativePaths[0] = "../escape.mov";
        },
        message: /分组与任务文件记录不一致/,
      },
      {
        name: "duplicate path",
        mutate: (value) => {
          value.dateAllocation!.groups[1].relativePaths = [
            value.dateAllocation!.groups[0].relativePaths[0],
          ];
          value.dateAllocation!.groups[1].id = allocationGroupId(
            value.dateAllocation!.groups[1].relativePaths,
          );
        },
        message: /分组与任务文件记录不一致/,
      },
      {
        name: "forged totals",
        mutate: (value) => {
          value.dateAllocation!.groups[0].bytes++;
        },
        message: /分组与任务文件记录不一致/,
      },
      {
        name: "regrouped sidecar",
        mutate: (value) => {
          const [first, second] = value.dateAllocation!.groups,
            moved = first.relativePaths.pop()!;
          second.relativePaths.unshift(moved);
          for (const group of [first, second]) {
            group.id = allocationGroupId(group.relativePaths);
            group.files = group.relativePaths.length;
            group.bytes = value.fileRecords
              .filter((record) =>
                group.relativePaths.includes(record.relativePath),
              )
              .reduce((sum, record) => sum + record.size, 0);
            group.label = path.basename(
              group.relativePaths[0],
              path.extname(group.relativePaths[0]),
            );
          }
        },
        message: /分组与任务文件记录不一致/,
      },
    ];
    for (const item of cases) {
      const value = mixedDayTask();
      item.mutate(value);
      expect(() => sealTask(value), item.name).toThrow(item.message);
    }
  });

  it("rejects forged daily-delivery identity, paths, counts, and file evidence", () => {
    const cases: Array<{
      name: string;
      mutate: (value: BackupTask) => void;
      message: RegExp;
    }> = [
      {
        name: "invalid id",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].id = "delivery-one";
        },
        message: /结构、标识或路径无效/,
      },
      {
        name: "duplicate id",
        mutate: (value) => {
          value.dailyDeliveryRuns!.push(
            structuredClone(value.dailyDeliveryRuns![0]),
          );
        },
        message: /结构、标识或路径无效/,
      },
      {
        name: "unknown source destination",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].sourceDestinationId = "unknown-copy";
        },
        message: /来源目的地标识无效或不唯一/,
      },
      {
        name: "relative source",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].sourceRoot = "relative/source";
        },
        message: /结构、标识或路径无效/,
      },
      {
        name: "escaped final path",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].finalPath = "/Volumes/ESCAPE";
        },
        message: /结构、标识或路径无效/,
      },
      {
        name: "forged selected totals",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].totalBytes++;
        },
        message: /历史当日交付范围超过任务文件证据/,
      },
      {
        name: "forged completed count",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].completedFiles--;
        },
        message: /状态与完成计数不一致/,
      },
      {
        name: "unknown delivered file",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].files[0].relativePath =
            "DCIM/unknown.mov";
        },
        message: /文件证据无效/,
      },
      {
        name: "mismatched sha256",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].files[0].deliveredChecksum = "f".repeat(
            64,
          );
        },
        message: /文件证据无效/,
      },
    ];
    for (const item of cases) {
      const value = mixedDayTask();
      item.mutate(value);
      expect(() => sealTask(value), item.name).toThrow(item.message);
    }
  });

  it("rejects unsafe daily-delivery publication, recovery, and report evidence", () => {
    const cases: Array<{
      name: string;
      mutate: (value: BackupTask) => void;
      message: RegExp;
    }> = [
      {
        name: "publication outside media root",
        mutate: (value) => {
          const run = value.dailyDeliveryRuns![0];
          run.publicationInProgress = {
            relativePath: value.fileRecords[0].relativePath,
            stagingPath: "/tmp/escape.partial",
            finalPath: "/tmp/escape.mov",
          };
        },
        message: /发布恢复记录不安全/,
      },
      {
        name: "recovery outside media root",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].recoveryArtifacts = [
            "/tmp/escape.invalid-9-12345678",
          ];
        },
        message: /恢复文件路径不安全/,
      },
      {
        name: "manifest outside report root",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].manifestPaths![0] = "/tmp/list.json";
        },
        message: /清单路径无效/,
      },
      {
        name: "report outside report root",
        mutate: (value) => {
          const run = value.dailyDeliveryRuns![0];
          run.reportPaths = ["/tmp/report.pdf"];
          run.reportSha256 = { "/tmp/report.pdf": digest("report") };
        },
        message: /报告路径或 SHA-256 摘要无效/,
      },
      {
        name: "invalid report digest",
        mutate: (value) => {
          const run = value.dailyDeliveryRuns![0];
          run.reportSha256![run.reportPaths![0]] = "not-sha256";
        },
        message: /报告路径或 SHA-256 摘要无效/,
      },
      {
        name: "completed without manifests",
        mutate: (value) => {
          value.dailyDeliveryRuns![0].manifestPaths = undefined;
        },
        message: /完成状态与清单记录不一致/,
      },
    ];
    for (const item of cases) {
      const value = mixedDayTask();
      item.mutate(value);
      expect(() => sealTask(value), item.name).toThrow(item.message);
    }
  });

  it("round-trips new scope/report snapshots without upgrading legacy tasks", async () => {
    const { root, storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const current = task("complete-v2");
    current.inventoryPolicy = {
      version: "complete-v2",
      mode: "complete",
      createdAt: 1,
      includeHidden: true,
      includeAppleDouble: true,
      includeSystemMetadata: true,
      includeEmptyDirectories: true,
      symlinkPolicy: "fail",
      specialFilePolicy: "fail",
    };
    current.inventoryScope = {
      policy: current.inventoryPolicy,
      capturedAt: 2,
      sourcePath: current.sourcePath,
      fingerprint: "a".repeat(64),
      includedFiles: 0,
      includedBytes: 0,
      includedDirectories: 0,
      includedDirectoryPaths: [],
      excludedFiles: 0,
      excludedDirectories: 0,
      excludedBytes: 0,
      exclusions: [],
    };
    current.reportContext = {
      capturedAt: 1,
      projectId: "project-1",
      projectName: "项目一",
      projectNameSource: "project-selection",
      shootingDate: "2026-09-19",
      shootingDateSource: "task-input",
    };
    current.automaticReport = {
      schema: 1,
      enabled: false,
      requestedAt: 1,
      operationAttemptId: current.id,
      status: "disabled",
      attempts: 0,
      targets: [],
    };
    current.operationAttemptId = current.id;
    const legacy = task("legacy");
    await workspace.commitTasks([current, legacy], true);
    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    const saved = reopened.state.tasks.find((item) => item.id === current.id)!;
    expect(saved.inventoryScope).toEqual(current.inventoryScope);
    expect(saved.reportContext).toEqual(current.reportContext);
    expect(saved.automaticReport).toEqual(current.automaticReport);
    const savedLegacy = reopened.state.tasks.find(
      (item) => item.id === legacy.id,
    )!;
    expect(savedLegacy.inventoryPolicy).toBeUndefined();
    expect(savedLegacy.inventoryScope).toBeUndefined();
    expect(savedLegacy.automaticReport).toBeUndefined();
  });

  it("rejects an automatic report path outside its recorded destination", async () => {
    const { storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const value = task("unsafe-report");
    value.destinations = [
      {
        id: "destination-1",
        path: "/Volumes/BACKUP",
        resolvedPath: "/Volumes/BACKUP/A001",
        label: "BACKUP",
        verified: true,
        bytesWritten: 0,
      },
    ];
    value.automaticReport = {
      schema: 1,
      enabled: true,
      requestedAt: 1,
      operationAttemptId: value.id,
      status: "failed",
      attempts: 1,
      targets: [
        {
          destinationId: "destination-1",
          destinationPath: "/Volumes/BACKUP/A001",
          reportDirectory: "/Volumes/BACKUP/A001/Kocpy报告",
          outputPath: "/tmp/escape.pdf",
          status: "failed",
          attempts: 1,
          error: "injected",
        },
      ],
    };
    value.operationAttemptId = value.id;
    await expect(workspace.commitTasks([value])).rejects.toThrow(
      "自动报告目标无效",
    );
  });

  it("upgrades schema 1 once and imports legacy archive evidence into the authority", async () => {
    const { root, storage, catalog } = await fixture(),
      legacy = sealWorkspaceState({
        schemaVersion: 1,
        revision: 7,
        committedAt: 10,
        tasks: [task("legacy-task")],
        projects: [project("legacy-project")],
        taskTombstones: [],
        projectTombstones: [],
      });
    await fs.writeFile(
      path.join(root, "workspace-state.json"),
      JSON.stringify(legacy),
    );
    await storage.write("archive-health.json", [
      {
        id: "health-1",
        projectId: "legacy-project",
        checkedAt: 11,
        taskCount: 1,
        healthyTasks: 1,
        failedTasks: 0,
        missingCopies: 0,
        notes: [],
      },
    ]);
    await storage.write("archive-changes.json", [
      {
        id: "change-1",
        projectId: "legacy-project",
        at: 11,
        kind: "verified",
        note: "旧版记录",
      },
    ]);
    await storage.write("archive-reminders.json", [
      {
        id: "reminder-1",
        projectId: "legacy-project",
        intervalDays: 180,
        nextAt: 100,
        enabled: true,
      },
    ]);

    const upgraded = await new WorkspaceRepository(
      storage,
      catalog,
    ).initialize();
    expect(upgraded.state.schemaVersion).toBe(2);
    expect(upgraded.state.revision).toBe(8);
    expect(upgraded.state.archiveEvidence?.healthRecords).toHaveLength(1);
    expect(upgraded.state.archiveEvidence?.changes[0]).toMatchObject({
      operator: "旧版本未记录",
      outcome: "completed",
    });
    expect(upgraded.state.archiveEvidence?.reminders).toHaveLength(1);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.revision).toBe(8);
    expect(reopened.state.archiveEvidence?.digest).toBe(
      upgraded.state.archiveEvidence?.digest,
    );
  });

  it("migrates authoritative legacy JSON once without reviving extra catalog rows", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("tasks.json", [task("json-new", 20)]);
    await storage.write("projects.json", [project("json-project")]);
    await catalog.rebuild(
      [task("catalog-only", 10)],
      [project("catalog-project")],
    );

    const first = await new WorkspaceRepository(storage, catalog).initialize();
    expect(first.source).toBe("legacy");
    expect(first.state.revision).toBe(1);
    expect(first.state.tasks.map((item) => item.id)).toEqual(["json-new"]);
    expect(first.state.projects.map((item) => item.id)).toEqual([
      "json-project",
    ]);
    validateWorkspaceState(
      JSON.parse(
        await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
      ),
    );

    const second = await new WorkspaceRepository(
      storage,
      new CatalogDatabase(root),
    ).initialize();
    expect(second.source).toBe("primary");
    expect(second.state.revision).toBe(1);
    expect(second.state.migration).toEqual(first.state.migration);
  });

  it("uses a valid catalog only when the corresponding legacy JSON mirror is absent", async () => {
    const { storage, catalog } = await fixture();
    await catalog.rebuild([task("catalog-task")], [project("catalog-project")]);
    const loaded = await new WorkspaceRepository(storage, catalog).initialize();
    expect(loaded.state.tasks.map((item) => item.id)).toEqual(["catalog-task"]);
    expect(loaded.state.projects.map((item) => item.id)).toEqual([
      "catalog-project",
    ]);
  });

  it("treats an explicit empty legacy JSON array as authoritative", async () => {
    const { storage, catalog } = await fixture();
    await storage.write("tasks.json", []);
    await storage.write("projects.json", []);
    await catalog.rebuild([task("stale")], [project("stale")]);
    const loaded = await new WorkspaceRepository(storage, catalog).initialize();
    expect(loaded.state.tasks).toEqual([]);
    expect(loaded.state.projects).toEqual([]);
    expect(await catalog.loadTasks()).toEqual([]);
  });

  it("serializes concurrent task and project commits without losing either domain", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await Promise.all([
      workspace.commitTasks([task("task-a")]),
      workspace.commitProjects([project("project-a")]),
    ]);
    expect(workspace.getTasks().map((item) => item.id)).toEqual(["task-a"]);
    expect(workspace.getProjects().map((item) => item.id)).toEqual([
      "project-a",
    ]);
    expect(workspace.snapshot.revision).toBe(3);
  });

  it("does not resurrect a deleted record when the SQLite index is restored to an older revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("keep"), task("delete-me")],
      projects: [project("project")],
      syncCatalog: true,
    });
    const oldCatalog = await fs.readFile(path.join(root, "catalog.sqlite"));
    await workspace.commit({ tasks: [task("keep")], syncCatalog: true });
    await fs.writeFile(path.join(root, "catalog.sqlite"), oldCatalog);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.tasks.map((item) => item.id)).toEqual(["keep"]);
    expect(reopened.state.taskTombstones.map((item) => item.id)).toContain(
      "delete-me",
    );
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["keep"]);
  });

  it("atomically applies explicitly confirmed workstation tombstones", async () => {
    const { root, storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("keep")],
      projects: [project("keep-project")],
      syncCatalog: true,
    });
    const committed = await workspace.commit({
      tasks: [task("keep")],
      projects: [project("keep-project")],
      taskTombstones: [
        { id: "remote-deleted-task", deletedAt: 20, revision: 99 },
      ],
      projectTombstones: [
        { id: "remote-deleted-project", deletedAt: 21, revision: 88 },
      ],
      syncCatalog: true,
    });
    expect(committed.state.taskTombstones).toEqual([
      {
        id: "remote-deleted-task",
        deletedAt: 20,
        revision: committed.state.revision,
      },
    ]);
    expect(committed.state.projectTombstones[0]).toMatchObject({
      id: "remote-deleted-project",
      revision: committed.state.revision,
    });
    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.taskTombstones.map((item) => item.id)).toEqual([
      "remote-deleted-task",
    ]);
    expect(reopened.state.projectTombstones.map((item) => item.id)).toEqual([
      "remote-deleted-project",
    ]);
    const unchangedRevision = reopened.state.taskTombstones[0].revision,
      withAnotherDeletion = new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      );
    await withAnotherDeletion.initialize();
    const next = await withAnotherDeletion.commit({
      taskTombstones: [
        reopened.state.taskTombstones[0],
        { id: "another-remote-task", deletedAt: 22, revision: 100 },
      ],
      projectTombstones: reopened.state.projectTombstones,
    });
    expect(
      next.state.taskTombstones.find(
        (item) => item.id === "remote-deleted-task",
      )?.revision,
    ).toBe(unchangedRevision);
    expect(
      next.state.taskTombstones.find(
        (item) => item.id === "another-remote-task",
      )?.revision,
    ).toBe(next.state.revision);
  });

  it("recovers the newest complete catalog snapshot when the primary state is corrupt", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("newest")], syncCatalog: true });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.source).toBe("catalog");
    expect(reopened.state.tasks.map((item) => item.id)).toEqual(["newest"]);
    validateWorkspaceState(
      JSON.parse(
        await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
      ),
    );
  });

  it("detects unsupported legacy writes instead of guessing how to merge them", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("canonical")], syncCatalog: true });
    await storage.write("tasks.json", [task("legacy-change")]);

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("旧版本或外部程序");
  });

  it("does not choose between two valid but divergent snapshots at the same revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("primary")], syncCatalog: true });
    const primary = JSON.parse(
      await fs.readFile(path.join(root, "workspace-state.json"), "utf8"),
    );
    primary.tasks = [task("other-valid")];
    const { digest: _digest, ...body } = primary;
    const conflicting = sealWorkspaceState(body);
    await fs.writeFile(
      path.join(root, "workspace-state.json.bak"),
      JSON.stringify(conflicting),
    );

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("多个互相冲突");
  });

  it("does not overwrite a compatibility mirror that records a newer revision", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("older")], syncCatalog: false });
    await workspace.commit({ tasks: [task("newer")], syncCatalog: false });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("兼容镜像记录的修订高于");
  });

  it("keeps the authoritative commit when index synchronization is interrupted", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const original = catalog.applyWorkspaceState.bind(catalog);
    let fail = true;
    catalog.applyWorkspaceState = async (state) => {
      if (fail) {
        fail = false;
        throw new Error("injected index interruption");
      }
      return original(state);
    };
    const committed = await workspace.commit({
      tasks: [task("committed-before-index")],
      syncCatalog: true,
    });
    expect(committed.indexSynchronized).toBe(false);
    expect(committed.indexError).toContain("injected index interruption");

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.tasks.map((item) => item.id)).toEqual([
      "committed-before-index",
    ]);
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["committed-before-index"]);
  });

  it("retries compatibility mirrors after an interruption without advancing the revision", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const original = storage.write.bind(storage);
    let fail = true;
    storage.write = ((name: string, value: unknown) => {
      if (fail && name === "tasks.json") {
        fail = false;
        return Promise.reject(new Error("injected mirror interruption"));
      }
      return original(name, value);
    }) as Storage["write"];
    const committed = await workspace.commitTasks([task("canonical")]);
    expect(committed.compatibilitySynchronized).toBe(false);
    const retried = await workspace.commitTasks([task("canonical")]);
    expect(retried.state.revision).toBe(committed.state.revision);
    expect(retried.compatibilitySynchronized).toBe(true);
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toHaveLength(1);
  });

  it("keeps an authoritative archive evidence commit when an archive mirror write fails", async () => {
    const { root, storage, catalog } = await fixture(),
      workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const evidence = updateArchiveEvidence(
        workspace.getArchiveEvidence(),
        {
          changes: [
            {
              id: "archive-authority-change",
              projectId: "project-a",
              operator: "DIT 测试员",
              at: 20,
              kind: "verified",
              outcome: "completed",
              note: "权威提交",
            },
          ],
        },
        20,
      ),
      original = storage.write.bind(storage);
    let fail = true;
    storage.write = ((name: string, value: unknown) => {
      if (fail && name === "archive-changes.json") {
        fail = false;
        return Promise.reject(
          new Error("injected archive mirror interruption"),
        );
      }
      return original(name, value);
    }) as Storage["write"];
    const committed = await workspace.commitArchiveEvidence(evidence);
    expect(committed.compatibilitySynchronized).toBe(false);
    expect(workspace.getArchiveEvidence().changes).toHaveLength(1);

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.archiveEvidence?.changes[0].id).toBe(
      "archive-authority-change",
    );
  });

  it("can defer the legacy mirror while keeping each active checkpoint authoritative", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const committed = await workspace.commitTasks(
      [task("active-checkpoint")],
      false,
      false,
    );
    expect(committed.compatibilitySynchronized).toBe(false);
    expect(workspace.snapshot.tasks[0].id).toBe("active-checkpoint");
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toEqual([]);

    const synchronized = await workspace.commitTasks([
      task("active-checkpoint"),
    ]);
    expect(synchronized.state.revision).toBe(committed.state.revision);
    expect(synchronized.compatibilitySynchronized).toBe(true);
    expect(await storage.read<BackupTask[]>("tasks.json", [])).toHaveLength(1);
  });

  it("does not publish an in-memory revision when the canonical write fails", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const before = workspace.snapshot,
      original = storage.writeSerialized.bind(storage);
    storage.writeSerialized = ((name: string, value: string) => {
      if (name === "workspace-state.json")
        return Promise.reject(new Error("injected authority interruption"));
      return original(name, value);
    }) as Storage["writeSerialized"];
    await expect(
      workspace.commitTasks([task("not-committed")]),
    ).rejects.toThrow("injected authority interruption");
    expect(workspace.snapshot.revision).toBe(before.revision);
    expect(workspace.snapshot.tasks).toEqual(before.tasks);
  });

  it("removes catalog drift even when its stored workspace metadata still matches", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("canonical")], syncCatalog: true });
    await catalog.upsertTask(task("ghost"));

    await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(
      (await new CatalogDatabase(root).loadTasks()).map((item) => item.id),
    ).toEqual(["canonical"]);
  });

  it("repairs same-count file-row drift instead of trusting index metadata", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("canonical-media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    const db = await catalog.open();
    db.run(
      "UPDATE files SET relative_path='DCIM/TAMPERED.mov',size=999 WHERE task_id='canonical-media' AND relative_path='DCIM/A.mov'",
    );
    await catalog.flush();

    await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    const repaired = await new CatalogDatabase(root).pageFiles({
      projectId: "project-files",
      limit: 10,
    });
    expect(repaired.map((file) => file.relativePath)).toEqual([
      "DCIM/A.mov",
      "DCIM/B.mov",
    ]);
    expect(repaired.map((file) => file.size)).toEqual([1, 2]);
  });

  it("does not rewrite a clean matching catalog during startup", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("clean-media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    const file = path.join(root, "catalog.sqlite"),
      fixed = new Date(1_700_000_000_000);
    await fs.utimes(file, fixed, fixed);
    const before = (await fs.stat(file)).mtimeMs;

    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.indexRebuilt).toBe(false);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it("reconciles file rows when a committed task changes and when it is removed", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [taskWithFiles("media", ["A.mov", "B.mov"])],
      projects: [{ ...project("project-files"), id: "project-files" }],
      syncCatalog: true,
    });
    expect((await catalog.stats()).files).toBe(2);
    expect(
      (await catalog.pageFiles({ projectId: "project-files", limit: 10 })).map(
        (file) => file.relativePath,
      ),
    ).toEqual(["DCIM/A.mov", "DCIM/B.mov"]);

    await workspace.commit({
      tasks: [taskWithFiles("media", ["C.mov"])],
      syncCatalog: true,
    });
    expect((await catalog.stats()).files).toBe(1);
    expect(
      (await catalog.pageFiles({ projectId: "project-files", limit: 10 })).map(
        (file) => file.relativePath,
      ),
    ).toEqual(["DCIM/C.mov"]);

    await workspace.commit({ tasks: [], syncCatalog: true });
    expect(await catalog.stats()).toMatchObject({ tasks: 0, files: 0 });
  });

  it("keeps task and project tombstones through index rebuilds", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({
      tasks: [task("deleted-task")],
      projects: [project("deleted-project")],
      syncCatalog: true,
    });
    await workspace.commit({ tasks: [], projects: [], syncCatalog: true });
    const reopened = await new WorkspaceRepository(
      new Storage(root),
      new CatalogDatabase(root),
    ).initialize();
    expect(reopened.state.taskTombstones.map((item) => item.id)).toEqual([
      "deleted-task",
    ]);
    expect(reopened.state.projectTombstones.map((item) => item.id)).toEqual([
      "deleted-project",
    ]);
    expect(await new CatalogDatabase(root).loadTasks()).toEqual([]);
    expect(await new CatalogDatabase(root).loadProjects()).toEqual([]);
  });

  it("does not advance a revision for an identical checkpoint", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const first = await workspace.commitTasks([task("same")]);
    const second = await workspace.commitTasks([task("same")]);
    expect(second.state.revision).toBe(first.state.revision);
  });

  it("keeps committed snapshots isolated from later engine and UI mutations", async () => {
    const { storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    const mutableTask = task("mutable", 1),
      mutableProject = project("mutable-project");
    await workspace.commit({
      tasks: [mutableTask],
      projects: [mutableProject],
    });
    mutableTask.lastCheckpointAt = 2;
    mutableProject.name = "changed outside";
    const read = workspace.getProjects();
    read[0].name = "changed through getter";
    expect(workspace.snapshot.tasks[0].lastCheckpointAt).toBe(1);
    expect(workspace.snapshot.projects[0].name).toBe("mutable-project");
    const updated = await workspace.commitTasks([mutableTask]);
    expect(updated.state.tasks[0].lastCheckpointAt).toBe(2);
  });

  it("refuses an unknown newer workspace schema instead of falling back to legacy mirrors", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("workspace-state.json", {
      schemaVersion: 99,
      revision: 99,
      committedAt: 1,
      tasks: [],
      projects: [],
      taskTombstones: [],
      projectTombstones: [],
      digest: "0".repeat(64),
    });
    await expect(
      new WorkspaceRepository(new Storage(root), catalog).initialize(),
    ).rejects.toThrow("不支持工作区格式版本 99");
  });

  it("refuses to reset revisions from legacy mirrors after every authority copy is corrupt", async () => {
    const { root, storage, catalog } = await fixture();
    const workspace = new WorkspaceRepository(storage, catalog);
    await workspace.initialize();
    await workspace.commit({ tasks: [task("protected")], syncCatalog: true });
    await fs.writeFile(path.join(root, "workspace-state.json"), "{broken");
    await fs.writeFile(path.join(root, "workspace-state.json.bak"), "{broken");
    const db = await catalog.open();
    db.run("UPDATE workspace_state SET json='{broken' WHERE id=1");
    await catalog.flush();
    for (const suffix of [".bak", ".bak2", ".bak3"])
      await fs.writeFile(path.join(root, `catalog.sqlite${suffix}`), "broken");

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("停止启动以避免从旧镜像猜测恢复");
  });

  it("treats a corrupt compatibility marker as evidence of a prior migration", async () => {
    const { root, storage, catalog } = await fixture();
    await storage.write("tasks.json", [task("legacy-mirror")]);
    await storage.write("projects.json", []);
    await fs.writeFile(
      path.join(root, "workspace-compatibility.json"),
      "{broken",
    );

    await expect(
      new WorkspaceRepository(
        new Storage(root),
        new CatalogDatabase(root),
      ).initialize(),
    ).rejects.toThrow("停止启动以避免从旧镜像猜测恢复");
  });
});
