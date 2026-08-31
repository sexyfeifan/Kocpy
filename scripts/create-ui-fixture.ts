// Explicitly synthetic, isolated desktop acceptance data. Never reads production records.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { volumeIdentity } from "../src/main/system";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-acceptance-"));
  const data = path.join(root, "data"), source = path.join(root, "合成素材_不是正式素材");
  const target = path.join(root, "备份父目录"), other = path.join(root, "第二个备份父目录");
  for (const dir of [data, source, target, other]) await fs.mkdir(dir);
  const file = await fs.open(path.join(source, "synthetic-large.bin"), "wx");
  try {
    const block = randomBytes(8 * 1024 * 1024);
    for (let i = 0; i < 128; i++) await file.writeFile(block);
  } finally { await file.close(); }
  for (let i = 0; i < 300; i++)
    await fs.writeFile(path.join(source, `合成_${String(i).padStart(4, "0")}.txt`), `Synthetic UI test ${i}\n`, { flag: "wx" });
  const engine = new BackupEngine();
  const task = engine.createTask({ name: "合成·原盘身份恢复测试", sourcePath: source,
    destinationPaths: [target, other], devices: ["FX3"], shootingDate: "2026-09-01",
    namingTemplate: "synthetic", copyMode: "mirror", hashAlgorithm: "sha256", generateThumbnails: false });
  const sourceId = await volumeIdentity(source);
  task.sourceVolumeId = sourceId.id; task.sourceVolumeUuid = sourceId.uuid;
  for (const destination of task.destinations) {
    const identity = await volumeIdentity(destination.path);
    destination.volumeId = identity.id; destination.volumeUuid = identity.uuid;
    destination.volumeName = "合成验收目标（同一系统盘）";
  }
  task.status = "failed";
  task.errorMessage = "磁盘 UUID 已变化，已停止操作（合成旧错误，用于原盘恢复验收）";
  task.projectId = "synthetic-project";
  const project = { id: task.projectId, name: "合成验收项目·长中文名称与核心流程检查", folderName: "合成验收项目",
    devices: ["FX3", "音频"], volumePrefix: "CARD", requiredCopies: 1,
    shootingDateStart: "2026-09-01", shootingDateEnd: "2026-09-02",
    expectedDevicesByDate: { "2026-09-01": ["FX3"] }, backupRoot: target };
  await fs.writeFile(path.join(data, "projects.json"), JSON.stringify([project]));
  await fs.writeFile(path.join(data, "tasks.json"), JSON.stringify([task]));
  console.log(JSON.stringify({ root, data, source, targets: [target, other], taskId: task.id }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
