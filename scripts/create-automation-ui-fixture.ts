// Explicitly synthetic, isolated desktop acceptance data. Never reads production records.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupTask, ProjectConfig, ProjectRuleDefinition } from "../src/main/types";

const rules: ProjectRuleDefinition = {
  projectFolderName: "20260902_合成自动化验收项目",
  shootingDateStart: "2026-09-02",
  shootingDateEnd: "2026-09-02",
  devices: ["A Cam"],
  volumePrefix: "A_",
  volumePrefixByDevice: { "A Cam": "A_" },
  devicePositions: { "A Cam": ["A"] },
  destinationPaths: [],
  requiredCopies: 1,
  namingRule: "{shootingDate}/{device}/{position}/{card}",
  completionActions: ["report", "delivery", "proxy", "eject"],
  checklists: [],
};

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-automation-ui-")),
    data = path.join(root, "data"),
    source = path.join(root, "合成离线素材卡"),
    destination = path.join(root, "合成已校验副本", "A001"),
    relativePath = "DCIM/A001_0001.mov",
    copy = path.join(destination, relativePath),
    content = Buffer.from("Kocpy synthetic completion automation fixture\n"),
    checksum = createHash("sha256").update(content).digest("hex"),
    totalBytes = content.length;
  await Promise.all([
    fs.mkdir(data, { recursive: true }),
    fs.mkdir(path.dirname(copy), { recursive: true }),
  ]);
  await fs.writeFile(copy, content, { flag: "wx" });
  const task: BackupTask = {
    id: "automation-ui-task",
    projectId: "automation-ui-project",
    projectRuleSnapshotId: "automation-rule-1",
    name: "A001_合成完成动作验收",
    sourcePath: source,
    devices: ["A Cam"],
    destinations: [
      {
        id: "verified-copy",
        path: destination,
        resolvedPath: destination,
        label: "合成已校验副本",
        verified: true,
        bytesWritten: totalBytes,
        copyProgress: 100,
        verifyProgress: 100,
      },
    ],
    hashAlgorithm: "sha256",
    namingTemplate: "A001",
    shootingDate: "2026-09-02",
    status: "completed",
    totalFiles: 1,
    completedFiles: 1,
    totalBytes,
    transferredBytes: totalBytes,
    verifiedBytes: totalBytes,
    copyProgress: 100,
    verifyProgress: 100,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: ["合成副本 SHA-256 一致"],
    createdAt: Date.now() - 10_000,
    completedAt: Date.now() - 5_000,
    fileRecords: [
      {
        name: path.basename(relativePath),
        relativePath,
        size: totalBytes,
        srcChecksum: checksum,
        destinations: [{ path: copy, checksum, verified: true }],
      },
    ],
  };
  const project: ProjectConfig = {
    id: task.projectId!,
    name: "合成自动化验收项目",
    projectFolderName: rules.projectFolderName,
    devices: ["A Cam"],
    volumePrefix: "A_",
    requiredCopies: 1,
    shootingDateStart: "2026-09-02",
    shootingDateEnd: "2026-09-02",
    completionActions: [...rules.completionActions],
    activeRuleSnapshotId: "automation-rule-1",
    ruleSnapshots: [
      {
        id: "automation-rule-1",
        revision: 1,
        createdAt: Date.now() - 20_000,
        operator: "合成验收操作人",
        reason: "project-created",
        sha256: createHash("sha256").update(JSON.stringify(rules)).digest("hex"),
        rules,
      },
    ],
  };
  await Promise.all([
    fs.writeFile(path.join(data, "tasks.json"), JSON.stringify([task])),
    fs.writeFile(path.join(data, "projects.json"), JSON.stringify([project])),
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
  console.log(JSON.stringify({ root, data, taskId: task.id, destination }));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
