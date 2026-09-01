import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArchiveTask } from "../src/main/archive-verification";
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
