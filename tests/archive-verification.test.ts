import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArchiveTask } from "../src/main/archive-verification";
import { completeInventoryPolicy } from "../src/main/backup/safety";
import { volumeIdentity } from "../src/main/system";
import type { BackupTask } from "../src/main/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-verify-"));
  roots.push(root);
  const destinationRoot = path.join(root, "archive", "CARD_A001"),
    filePath = path.join(destinationRoot, "DCIM", "A001.mov"),
    bytes = Buffer.alloc(8192, 29);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
  const identity = await volumeIdentity(destinationRoot),
    checksum = createHash("sha256").update(bytes).digest("hex"),
    task: BackupTask = {
      id: "task-a001",
      projectId: "project-1",
      name: "A001",
      sourcePath: path.join(root, "offline-source"),
      devices: ["A Cam"],
      destinations: [
        {
          id: "destination-1",
          path: destinationRoot,
          resolvedPath: destinationRoot,
          label: "ARCHIVE",
          verified: true,
          bytesWritten: bytes.length,
          volumeId: identity.id,
          volumeUuid: identity.uuid,
        },
      ],
      hashAlgorithm: "sha256",
      namingTemplate: "{name}",
      status: "completed",
      totalFiles: 1,
      completedFiles: 1,
      totalBytes: bytes.length,
      transferredBytes: bytes.length,
      speedBps: 0,
      eta: 0,
      currentFile: "",
      verifyLog: [],
      fileRecords: [
        {
          name: "A001.mov",
          relativePath: "DCIM/A001.mov",
          size: bytes.length,
          srcChecksum: checksum,
          destinations: [{ path: filePath, checksum, verified: true }],
        },
      ],
      createdAt: 1,
    };
  return { task, filePath, destinationRoot };
}

const context = () => ({
  runId: randomUUID(),
  operator: "DIT 测试员",
  projectId: "project-1",
});

function freezeCompleteInventory(
  task: BackupTask,
  directoryPaths: string[],
) {
  const policy = completeInventoryPolicy(true, 1);
  task.inventoryPolicy = policy;
  task.inventoryScope = {
    policy,
    capturedAt: 2,
    sourcePath: task.sourcePath,
    fingerprint: "a".repeat(64),
    includedFiles: task.totalFiles,
    includedBytes: task.totalBytes,
    includedDirectories: directoryPaths.length,
    includedDirectoryPaths: directoryPaths,
    excludedFiles: 0,
    excludedDirectories: 0,
    excludedBytes: 0,
    exclusions: [],
  };
}

describe("archive verification evidence", () => {
  it("fully rereads a healthy archive without mutating the input task", async () => {
    const { task } = await fixture(),
      original = structuredClone(task),
      verified = await verifyArchiveTask(
        task,
        { kind: "project", projectId: "project-1" },
        context(),
      );
    expect(verified.result.status).toBe("healthy");
    expect(verified.result.verifiedCopies).toBe(1);
    expect(verified.result.bytesVerified).toBe(8192);
    expect(verified.changes.at(-1)?.outcome).toBe("completed");
    expect(task).toEqual(original);
  });

  it("accepts empty and directory-only complete-v2 baselines and detects missing directories", async () => {
    const empty = await fixture();
    await fs.rm(path.dirname(empty.filePath), { recursive: true });
    empty.task.fileRecords = [];
    empty.task.totalFiles = 0;
    empty.task.completedFiles = 0;
    empty.task.totalBytes = 0;
    empty.task.transferredBytes = 0;
    empty.task.destinations[0].bytesWritten = 0;
    freezeCompleteInventory(empty.task, []);
    const emptyResult = await verifyArchiveTask(
      empty.task,
      { kind: "card", taskId: empty.task.id },
      context(),
    );
    expect(emptyResult.result.status).toBe("healthy");
    expect(emptyResult.result.checkedCopies).toBe(0);
    expect(emptyResult.result.missingDirectories).toBe(0);

    const directoryOnly = await fixture();
    await fs.rm(path.dirname(directoryOnly.filePath), { recursive: true });
    await fs.mkdir(path.join(directoryOnly.destinationRoot, "EMPTY", "NESTED"), {
      recursive: true,
    });
    directoryOnly.task.fileRecords = [];
    directoryOnly.task.totalFiles = 0;
    directoryOnly.task.completedFiles = 0;
    directoryOnly.task.totalBytes = 0;
    directoryOnly.task.transferredBytes = 0;
    directoryOnly.task.destinations[0].bytesWritten = 0;
    freezeCompleteInventory(directoryOnly.task, ["EMPTY", "EMPTY/NESTED"]);
    expect(
      (
        await verifyArchiveTask(
          directoryOnly.task,
          { kind: "card", taskId: directoryOnly.task.id },
          context(),
        )
      ).result.status,
    ).toBe("healthy");
    await fs.rmdir(path.join(directoryOnly.destinationRoot, "EMPTY", "NESTED"));
    const missing = await verifyArchiveTask(
      directoryOnly.task,
      { kind: "card", taskId: directoryOnly.task.id },
      context(),
    );
    expect(missing.result.status).toBe("attention");
    expect(missing.result.missingDirectories).toBe(1);
    expect(missing.task.destinations[0].verified).toBe(false);
  });

  it("does not mark a complete-v2 file payload healthy when an empty directory is gone", async () => {
    const { task } = await fixture();
    freezeCompleteInventory(task, ["DCIM", "EMPTY"]);
    const verified = await verifyArchiveTask(
      task,
      { kind: "project", projectId: "project-1" },
      context(),
    );
    expect(verified.result.status).toBe("attention");
    expect(verified.result.missingDirectories).toBe(1);
  });

  it("distinguishes changed content, missing files and an offline archive root", async () => {
    const changed = await fixture();
    await fs.writeFile(changed.filePath, Buffer.alloc(8192, 30));
    const changedResult = await verifyArchiveTask(
      changed.task,
      { kind: "project", projectId: "project-1" },
      context(),
    );
    expect(changedResult.result.status).toBe("attention");
    expect(changedResult.result.damagedFiles).toBe(1);

    const missing = await fixture();
    await fs.unlink(missing.filePath);
    const missingResult = await verifyArchiveTask(
      missing.task,
      { kind: "project", projectId: "project-1" },
      context(),
    );
    expect(missingResult.result.missingFiles).toBe(1);

    const offline = await fixture();
    await fs.rename(offline.destinationRoot, `${offline.destinationRoot}-offline`);
    const offlineResult = await verifyArchiveTask(
      offline.task,
      { kind: "project", projectId: "project-1" },
      context(),
    );
    expect(offlineResult.result.status).toBe("offline");
    expect(offlineResult.result.offlineCopies).toBe(1);
  });

  it("refuses incomplete hash baselines", async () => {
    const { task } = await fixture();
    task.fileRecords[0].srcChecksum = "";
    await expect(
      verifyArchiveTask(
        task,
        { kind: "project", projectId: "project-1" },
        context(),
      ),
    ).rejects.toThrow("完整文件哈希基线");
  });
});
