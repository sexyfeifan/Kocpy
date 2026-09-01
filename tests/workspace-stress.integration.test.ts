import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CatalogDatabase } from "../src/main/catalog";
import { Storage } from "../src/main/storage";
import type { BackupTask } from "../src/main/types";
import { WorkspaceRepository } from "../src/main/workspace";

const count = Number(process.env.KOCPY_WORKSPACE_LARGE_TEST || 0);

function stressTask(fileCount: number): BackupTask {
  const fileRecords = Array.from({ length: fileCount }, (_, index) => {
    const name = `CLIP_${String(index).padStart(7, "0")}.mov`;
    return {
      name,
      relativePath: `DAY01/A/CARD01/${name}`,
      size: 1024 + index,
      srcChecksum: String(index).padStart(64, "0"),
      destinations: [
        {
          path: `/Volumes/ARCHIVE/DAY01/A/CARD01/${name}`,
          checksum: String(index).padStart(64, "0"),
          verified: true,
        },
      ],
    };
  });
  return {
    id: "stress-task",
    projectId: "stress-project",
    name: "CARD01",
    sourcePath: "/Volumes/SYNTHETIC",
    devices: [],
    destinations: [],
    hashAlgorithm: "sha256",
    namingTemplate: "{name}",
    status: "completed",
    totalFiles: fileCount,
    completedFiles: fileCount,
    totalBytes: fileRecords.reduce((total, file) => total + file.size, 0),
    transferredBytes: fileRecords.reduce((total, file) => total + file.size, 0),
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords,
    createdAt: 1,
  };
}

describe.skipIf(!count)("large workspace persistence", () => {
  it(
    `commits, checkpoints and reopens ${count.toLocaleString()} file records`,
    async () => {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "kocpy-workspace-large-"),
      );
      try {
        const storage = new Storage(root),
          catalog = new CatalogDatabase(root),
          workspace = new WorkspaceRepository(storage, catalog);
        await workspace.initialize();
        const synthetic = stressTask(count),
          commitStarted = performance.now();
        await workspace.commit({ tasks: [synthetic], syncCatalog: true });
        const commitMs = performance.now() - commitStarted,
          checkpointStarted = performance.now();
        await workspace.commitTasks(
          [{ ...synthetic, lastCheckpointAt: Date.now() }],
          false,
          false,
        );
        const checkpointMs = performance.now() - checkpointStarted,
          recoveryReopenStarted = performance.now(),
          reopened = await new WorkspaceRepository(
            new Storage(root),
            new CatalogDatabase(root),
          ).initialize(),
          recoveryReopenMs = performance.now() - recoveryReopenStarted,
          cleanReopenStarted = performance.now(),
          cleanReopened = await new WorkspaceRepository(
            new Storage(root),
            new CatalogDatabase(root),
          ).initialize(),
          cleanReopenMs = performance.now() - cleanReopenStarted,
          stateBytes = (await fs.stat(path.join(root, "workspace-state.json")))
            .size;
        expect(reopened.state.tasks[0].fileRecords).toHaveLength(count);
        expect(cleanReopened.state.digest).toBe(reopened.state.digest);
        expect((await new CatalogDatabase(root).stats()).files).toBe(count);
        console.log(
          JSON.stringify({
            files: count,
            commitMs: Math.round(commitMs),
            checkpointMs: Math.round(checkpointMs),
            recoveryReopenMs: Math.round(recoveryReopenMs),
            cleanReopenMs: Math.round(cleanReopenMs),
            stateBytes,
          }),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    Math.max(120_000, count * 4),
  );
});
