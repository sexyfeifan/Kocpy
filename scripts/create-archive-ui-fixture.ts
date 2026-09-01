// Explicitly synthetic, isolated desktop acceptance data. Never reads production records.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import { volumeIdentity } from "../src/main/system";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-ui-")),
    data = path.join(root, "data"),
    healthyRoot = path.join(root, "合成健康归档", "A001"),
    damagedRoot = path.join(root, "合成待修复归档", "A001"),
    relativePaths = ["DCIM/A001_0001.mov", "DCIM/A001_0002.mov"];
  await Promise.all([
    fs.mkdir(data, { recursive: true }),
    fs.mkdir(healthyRoot, { recursive: true }),
    fs.mkdir(damagedRoot, { recursive: true }),
  ]);
  const identity = await volumeIdentity(healthyRoot),
    fileRecords: BackupTask["fileRecords"] = [];
  for (const [index, relativePath] of relativePaths.entries()) {
    const content = Buffer.alloc(64 * 1024 + index, 70 + index),
      checksum = createHash("sha256").update(content).digest("hex"),
      healthyPath = path.join(healthyRoot, relativePath),
      damagedPath = path.join(damagedRoot, relativePath);
    await fs.mkdir(path.dirname(healthyPath), { recursive: true });
    await fs.mkdir(path.dirname(damagedPath), { recursive: true });
    await fs.writeFile(healthyPath, content);
    await fs.writeFile(damagedPath, Buffer.from(`damaged-${index}`));
    fileRecords.push({
      name: path.basename(relativePath),
      relativePath,
      size: content.length,
      srcChecksum: checksum,
      destinations: [
        { path: healthyPath, checksum, verified: true },
        {
          path: damagedPath,
          checksum: createHash("sha256")
            .update(`damaged-${index}`)
            .digest("hex"),
          verified: false,
        },
      ],
    });
  }
  const totalBytes = fileRecords.reduce((sum, item) => sum + item.size, 0),
    task: BackupTask = {
      id: "archive-ui-task",
      projectId: "archive-ui-project",
      name: "A001_长期归档验收",
      sourcePath: path.join(root, "离线合成素材源"),
      devices: ["A Cam"],
      destinations: [
        {
          id: "healthy-destination",
          path: healthyRoot,
          resolvedPath: healthyRoot,
          label: "合成健康归档",
          verified: true,
          bytesWritten: totalBytes,
          volumeId: identity.id,
          volumeUuid: identity.uuid,
        },
        {
          id: "damaged-destination",
          path: damagedRoot,
          resolvedPath: damagedRoot,
          label: "合成待修复归档",
          verified: false,
          bytesWritten: totalBytes,
          volumeId: identity.id,
          volumeUuid: identity.uuid,
          error: "合成损坏状态，仅用于界面验收",
        },
      ],
      hashAlgorithm: "sha256",
      namingTemplate: "{name}",
      status: "failed",
      totalFiles: fileRecords.length,
      completedFiles: fileRecords.length,
      totalBytes,
      transferredBytes: totalBytes * 2,
      speedBps: 0,
      eta: 0,
      currentFile: "",
      verifyLog: [],
      fileRecords,
      shootingDate: "2026-09-01",
      createdAt: Date.now(),
      errorMessage: "合成待修复副本，仅用于界面验收",
    },
    project: ProjectConfig = {
      id: task.projectId!,
      name: "合成长期归档验收项目",
      devices: ["A Cam"],
      volumePrefix: "A_",
      requiredCopies: 1,
      shootingDateStart: "2026-09-01",
      shootingDateEnd: "2026-09-01",
    };
  await Promise.all([
    fs.writeFile(path.join(data, "tasks.json"), JSON.stringify([task])),
    fs.writeFile(path.join(data, "projects.json"), JSON.stringify([project])),
    fs.writeFile(
      path.join(data, "archive-health.json"),
      JSON.stringify([
        {
          id: "legacy-health",
          projectId: project.id,
          checkedAt: Date.now() - 86_400_000,
          taskCount: 1,
          healthyTasks: 0,
          failedTasks: 1,
          missingCopies: 1,
          risk: "attention",
          notes: ["合成旧版健康记录"],
        },
      ]),
    ),
    fs.writeFile(
      path.join(data, "archive-changes.json"),
      JSON.stringify([
        {
          id: "legacy-change",
          projectId: project.id,
          taskId: task.id,
          at: Date.now() - 86_400_000,
          kind: "damaged",
          note: "合成旧版变化记录",
        },
      ]),
    ),
    fs.writeFile(
      path.join(data, "archive-reminders.json"),
      JSON.stringify([
        {
          id: "legacy-reminder",
          projectId: project.id,
          intervalDays: 180,
          nextAt: Date.now() + 180 * 86_400_000,
          enabled: true,
        },
      ]),
    ),
    fs.writeFile(
      path.join(data, "settings.json"),
      JSON.stringify({
        defaultHash: "sha256",
        defaultDuplicateStrategy: "skip",
        includeHidden: true,
        operator: "合成验收操作人",
        theme: "dark",
        reportSyncPath: "",
        thumbnailCacheGiB: 2,
        notificationSound: false,
      }),
    ),
  ]);
  process.stdout.write(`${JSON.stringify({ root, data, healthyRoot, damagedRoot })}\n`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
