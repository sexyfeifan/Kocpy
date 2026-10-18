import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BackupTask, ProjectConfig } from "./types";
import { projectFileDateRecords } from "../common/shooting-day-records";
import { taskTrustState } from "../common/task-trust";
import { createExclusiveArtifactDirectory } from "./completion-automation";
import { segment } from "./backup/safety";

export function projectReportCsv(project: ProjectConfig, tasks: BackupTask[]): string {
  const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return "\ufeff" + [
    "任务原始拍摄日,设备,机位,素材卷,文件数,素材大小,可信状态,有校验记录目标,可计数副本,项目要求副本,已确认归属日,归属待确认文件数",
    ...tasks.map(task => {
      const records = projectFileDateRecords(task);
      return [task.shootingDate, task.devices.join("/"), task.cameraPosition, task.name,
        task.totalFiles, task.totalBytes, taskTrustState(task).label,
        task.destinations.filter(destination => destination.verified).length,
        taskTrustState(task).countableCopies, project.requiredCopies || 2,
        [...new Set(records.flatMap(record => record.shootingDate ? [record.shootingDate] : []))].sort().join("；"),
        records.filter(record => !record.shootingDate).length].map(cell).join(",");
    }),
  ].join("\n");
}

/** Full identities, never a short display prefix, determine artifact names. */
export function projectManifestNames(tasks: Pick<BackupTask, "id" | "name">[]): string[] {
  const ids = new Set<string>();
  const names = tasks.map(task => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(task.id) || ids.has(task.id.toLowerCase()))
      throw new Error("项目任务标识重复或无效，未生成归档包");
    ids.add(task.id.toLowerCase());
    return `${segment(task.name).slice(0, 40)}_${task.id}.mhl`;
  });
  if (new Set(names.map(name => name.normalize("NFC").toLowerCase())).size !== names.length)
    throw new Error("归档清单文件名重复，未生成归档包");
  return names;
}

/** Exclusive writes and a final commit marker: an interrupted directory is not a completed package. */
export async function publishProjectArchive(parent: string, name: string,
  artifacts: Array<{ name: string; write: (file: string) => Promise<void> }>): Promise<string> {
  const reserved = ["SHA256SUMS.txt", "KOCPY_ARCHIVE_COMPLETE.json", "KOCPY_ARCHIVE_INCOMPLETE.json"];
  const names = artifacts.map(item => item.name);
  if (names.some(item => !item || item !== path.basename(item) || item === "." || item === ".." || reserved.some(key => key.toLowerCase() === item.toLowerCase())) ||
    new Set(names.map(item => item.normalize("NFC").toLowerCase())).size !== names.length)
    throw new Error("归档产物文件名不唯一或无效");
  const folder = await createExclusiveArtifactDirectory(await fs.realpath(parent), name);
  const binding = await fs.lstat(folder);
  const assertBinding = async () => {
    const current = await fs.lstat(folder);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== binding.dev ||
      current.ino !== binding.ino || await fs.realpath(folder) !== folder)
      throw new Error("归档包目录在生成期间已改变，停止发布");
  };
  const writeMetadata = async (filename: string, data: string) => {
    await assertBinding();
    const handle = await fs.open(path.join(folder, filename), "wx");
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await assertBinding();
  };
  const incomplete = path.join(folder, reserved[2]);
  await writeMetadata(reserved[2], JSON.stringify({ status: "incomplete", expectedFiles: names }));
  try {
    const checksums: string[] = [];
    for (const artifact of artifacts) {
      const file = path.join(folder, artifact.name);
      await assertBinding();
      // Writers are required to use exclusive creation (including the streaming JSON writer).
      await artifact.write(file);
      await assertBinding();
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("归档产物不是实际文件");
      const hash = createHash("sha256");
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
          throw new Error("归档产物在读取前发生变化");
        await handle.sync();
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      }
      finally { await handle.close(); }
      checksums.push(`${hash.digest("hex")}  ${artifact.name}`);
    }
    const checksumData = checksums.join("\n") + "\n";
    await writeMetadata(reserved[0], checksumData);
    await writeMetadata(reserved[1], JSON.stringify({ schema: 1, status: "complete", files: names,
      checksumsSha256: createHash("sha256").update(checksumData).digest("hex") }, null, 2));
    await assertBinding();
    await fs.unlink(incomplete);
    const directory = await fs.open(folder, "r");
    try { await directory.sync().catch(error => {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code || "")) throw error;
    }); } finally { await directory.close(); }
    return folder;
  } catch (cause) {
    throw new Error(`归档包未完整生成，未覆盖已有文件。保留目录供检查：${folder}`, { cause });
  }
}
