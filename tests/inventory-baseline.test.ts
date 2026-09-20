import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeInventoryPolicy } from "../src/main/backup/safety";
import {
  recordedInventoryBaseline,
  repairRecordedDirectoryScope,
  validateFileRecordMatrix,
} from "../src/main/inventory-baseline";
import type { BackupTask, HashAlgorithm } from "../src/main/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

function taskFor(algorithm: HashAlgorithm, checksum: string): BackupTask {
  return {
    id: `task-${algorithm}`,
    name: `CARD-${algorithm}`,
    sourcePath: "/Volumes/SOURCE/CARD",
    devices: ["A机"],
    destinations: [],
    hashAlgorithm: algorithm,
    namingTemplate: "{name}",
    status: "completed",
    totalFiles: 1,
    completedFiles: 1,
    totalBytes: 12,
    transferredBytes: 12,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords: [
      {
        name: "clip.mov",
        relativePath: "DCIM/clip.mov",
        size: 12,
        srcChecksum: checksum,
        destinations: [],
      },
    ],
    createdAt: 1,
  };
}

function freezeComplete(task: BackupTask) {
  const policy = completeInventoryPolicy(true, 1);
  task.inventoryPolicy = policy;
  task.inventoryScope = {
    policy,
    capturedAt: 2,
    sourcePath: task.sourcePath,
    fingerprint: "f".repeat(64),
    includedFiles: task.totalFiles,
    includedBytes: task.totalBytes,
    includedDirectories: 1,
    includedDirectoryPaths: ["DCIM"],
    excludedFiles: 0,
    excludedDirectories: 0,
    excludedBytes: 0,
    exclusions: [],
  };
}

function taskWithDestination(): BackupTask {
  const task = taskFor("sha256", "a".repeat(64)),
    root = "/Volumes/BACKUP/CARD";
  task.destinations = [
    {
      id: "backup",
      path: root,
      resolvedPath: root,
      label: "BACKUP",
      verified: true,
      bytesWritten: task.totalBytes,
    },
  ];
  task.fileRecords[0].destinations = [
    {
      path: `${root}/DCIM/clip.mov`,
      checksum: "a".repeat(64),
      verified: true,
    },
  ];
  return task;
}

describe("recorded inventory baseline", () => {
  const algorithms: Array<[HashAlgorithm, string]> = [
    ["sha256", "a".repeat(64)],
    ["sha1", "b".repeat(40)],
    ["md5", "c".repeat(32)],
    ["xxhash32", "4294967295"],
  ];

  for (const [algorithm, checksum] of algorithms)
    it(`accepts ${algorithm} legacy and complete-v2 checksums`, () => {
      const legacy = taskFor(algorithm, checksum);
      expect(recordedInventoryBaseline(legacy)).toBeUndefined();
      const complete = taskFor(algorithm, checksum);
      freezeComplete(complete);
      expect(recordedInventoryBaseline(complete)).toBe(complete.inventoryScope);
    });

  it("rejects malformed or out-of-range xxhash32 evidence", () => {
    expect(() =>
      recordedInventoryBaseline(taskFor("xxhash32", "4294967296")),
    ).toThrow(/完整文件哈希基线/);
    expect(() =>
      recordedInventoryBaseline(taskFor("xxhash32", "deadbeef")),
    ).toThrow(/完整文件哈希基线/);
  });

  it("rejects non-canonical, duplicate and NFC-conflicting file identities", () => {
    const invalidPath = taskWithDestination();
    invalidPath.fileRecords[0].relativePath = "DCIM/../clip.mov";
    expect(() => validateFileRecordMatrix(invalidPath)).toThrow(/文件记录/);
    expect(() => recordedInventoryBaseline(invalidPath)).toThrow(/文件记录/);

    const mismatchedName = taskWithDestination();
    mismatchedName.fileRecords[0].name = "other.mov";
    expect(() => validateFileRecordMatrix(mismatchedName)).toThrow(/文件记录/);

    const duplicate = taskWithDestination();
    duplicate.fileRecords.push(structuredClone(duplicate.fileRecords[0]));
    expect(() => validateFileRecordMatrix(duplicate)).toThrow(/文件记录/);

    const nfcConflict = taskWithDestination(),
      decomposed = structuredClone(nfcConflict.fileRecords[0]);
    nfcConflict.fileRecords[0].name = "\u00e9.mov";
    nfcConflict.fileRecords[0].relativePath = "DCIM/\u00e9.mov";
    decomposed.name = "e\u0301.mov";
    decomposed.relativePath = "DCIM/e\u0301.mov";
    decomposed.destinations[0].path =
      "/Volumes/BACKUP/CARD/DCIM/e\u0301.mov";
    nfcConflict.fileRecords.push(decomposed);
    expect(() => validateFileRecordMatrix(nfcConflict)).toThrow(/文件记录/);
  });

  it("rejects unsafe or misaligned destination matrices", () => {
    const missingResult = taskWithDestination();
    missingResult.fileRecords[0].destinations = [];
    expect(() => validateFileRecordMatrix(missingResult)).toThrow(/目的地矩阵/);

    for (const destinationPath of [
      "DCIM/clip.mov",
      "/Volumes/OTHER/DCIM/clip.mov",
      "/Volumes/BACKUP/CARD/../OTHER/clip.mov",
      "/Volumes/BACKUP/CARD",
    ]) {
      const unsafe = taskWithDestination();
      unsafe.fileRecords[0].destinations[0].path = destinationPath;
      expect(() => validateFileRecordMatrix(unsafe)).toThrow(/目的地矩阵/);
    }
  });

  it("keeps an unverified empty checkpoint placeholder compatible", () => {
    const interrupted = taskWithDestination();
    interrupted.status = "failed";
    interrupted.fileRecords[0].destinations[0] = {
      path: "",
      checksum: "",
      verified: false,
    };
    expect(() => validateFileRecordMatrix(interrupted)).not.toThrow();
    expect(recordedInventoryBaseline(interrupted)).toBeUndefined();

    interrupted.fileRecords[0].destinations[0].verified = true;
    expect(() => validateFileRecordMatrix(interrupted)).toThrow(/目的地矩阵/);
  });

  it("keeps a legal macOS backslash filename compatible", () => {
    const legacy = taskWithDestination();
    legacy.fileRecords[0].name = "clip\\take.mov";
    legacy.fileRecords[0].relativePath = "DCIM/clip\\take.mov";
    legacy.fileRecords[0].destinations[0].path =
      "/Volumes/BACKUP/CARD/DCIM/clip\\take.mov";
    expect(() => validateFileRecordMatrix(legacy)).not.toThrow();
    expect(recordedInventoryBaseline(legacy)).toBeUndefined();
  });

  it("repairs only frozen missing directories and is idempotent after partial creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-dir-repair-")),
      healthy = path.join(root, "healthy"),
      target = path.join(root, "target"),
      task = taskFor("sha256", "a".repeat(64));
    roots.push(root);
    freezeComplete(task);
    task.inventoryScope!.includedDirectories = 2;
    task.inventoryScope!.includedDirectoryPaths = ["DCIM", "DCIM/EMPTY"];
    await fs.mkdir(path.join(healthy, "DCIM", "EMPTY"), { recursive: true });
    await fs.mkdir(path.join(target, "DCIM"), { recursive: true });
    const first = await repairRecordedDirectoryScope(task, healthy, target);
    expect(first.created).toEqual([path.join("DCIM", "EMPTY")]);
    expect((await fs.lstat(path.join(target, "DCIM", "EMPTY"))).isDirectory()).toBe(
      true,
    );
    expect(
      (await repairRecordedDirectoryScope(task, healthy, target)).created,
    ).toEqual([]);
  });

  it("refuses to replace a file or symbolic link while repairing directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-dir-conflict-")),
      healthy = path.join(root, "healthy"),
      target = path.join(root, "target"),
      task = taskFor("sha256", "a".repeat(64));
    roots.push(root);
    freezeComplete(task);
    await fs.mkdir(path.join(healthy, "DCIM"), { recursive: true });
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "DCIM"), "do not overwrite");
    await expect(
      repairRecordedDirectoryScope(task, healthy, target),
    ).rejects.toThrow(/未覆盖/);
    expect(await fs.readFile(path.join(target, "DCIM"), "utf8")).toBe(
      "do not overwrite",
    );
    await fs.unlink(path.join(target, "DCIM"));
    await fs.symlink(path.join(root, "outside"), path.join(target, "DCIM"));
    await expect(
      repairRecordedDirectoryScope(task, healthy, target),
    ).rejects.toThrow(/未覆盖/);
  });
});
