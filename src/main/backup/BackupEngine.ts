import { EventEmitter } from "node:events";
import {
  promises as fs,
  constants,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type {
  BackupTask,
  TaskConfig,
  HashAlgorithm,
  FileRecord,
} from "../types";
import { canonical, scan, segment, safeChild, validatePaths } from "./safety";

export async function hashFile(
  file: string,
  algorithm: HashAlgorithm,
  signal?: AbortSignal,
): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, {
    highWaterMark: 2 * 1024 * 1024,
    signal,
  }))
    hash.update(chunk);
  return hash.digest("hex");
}
export class BackupEngine extends EventEmitter {
  private tasks = new Map<string, BackupTask>();
  private queue: string[] = [];
  private active = new Map<string, AbortController>();
  getTask(id: string) {
    return this.tasks.get(id);
  }
  getAllTasks() {
    return [...this.tasks.values()].reverse();
  }
  loadTask(task: BackupTask) {
    this.tasks.set(task.id, task);
  }
  hasActive() {
    return this.active.size > 0;
  }
  createTask(config: TaskConfig): BackupTask {
    if (!["sha256", "sha1", "md5"].includes(config.hashAlgorithm))
      throw new Error("不支持的哈希算法");
    if (!config.destinationPaths?.length || config.destinationPaths.length > 4)
      throw new Error("请选择 1–4 个目的地");
    if (
      !path.isAbsolute(config.sourcePath) ||
      config.destinationPaths.some((p) => !path.isAbsolute(p))
    )
      throw new Error("请选择有效的文件夹路径");
    const id = randomUUID(),
      timestamp = new Date()
        .toLocaleString("sv-SE", { hour12: false })
        .replace(/[^0-9]/g, "")
        .slice(0, 14);
    const name = segment(
      config.namingTemplate || config.name || path.basename(config.sourcePath),
    );
    const folder = `${name}_${timestamp}_${id.slice(0, 4)}`;
    const projectFolder = config.projectName
      ? path.join(
          segment(config.projectName),
          segment(
            config.shootingDate || new Date().toLocaleDateString("sv-SE"),
          ),
          ...config.devices.slice(0, 1).map(segment),
        )
      : "";
    const task: BackupTask = {
      id,
      name,
      sourcePath: config.sourcePath,
      devices: config.devices || [],
      projectId: config.projectId,
      createdAt: Date.now(),
      destinations: config.destinationPaths.map((p) => ({
        id: randomUUID(),
        path: p,
        label: path.basename(p),
        verified: false,
        bytesWritten: 0,
      })),
      hashAlgorithm: config.hashAlgorithm,
      namingTemplate: folder,
      shootingDateFolder: projectFolder,
      copyMode: config.copyMode || "normal",
      status: "pending",
      totalFiles: 0,
      completedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      speedBps: 0,
      eta: 0,
      currentFile: "",
      verifyLog: [],
      fileRecords: [],
      priority: config.priority || false,
      duplicateStrategy: config.duplicateStrategy || "skip",
      includeHidden: config.includeHidden ?? true,
    };
    this.tasks.set(id, task);
    return task;
  }
  enqueueTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    if (this.active.has(id) || this.queue.includes(id))
      throw new Error("任务已在队列中");
    if (task.status === "completed")
      throw new Error("已完成任务不能重复启动，请新建任务");
    task.status = "pending";
    task.errorMessage = undefined;
    this.queue.push(id);
    this.emitProgress(task);
    this.processQueue();
  }
  startTask(id: string) {
    this.enqueueTask(id);
  }
  cancelTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.active.has(id))
      this.active.get(id)!.abort(new Error("用户取消任务"));
    else if (task.status === "pending") {
      this.queue = this.queue.filter((x) => x !== id);
      task.status = "cancelled";
      task.completedAt = Date.now();
      this.emitProgress(task);
    }
  }
  deleteTask(id: string) {
    if (this.active.has(id) || this.queue.includes(id))
      throw new Error("请先取消任务再删除记录");
    this.tasks.delete(id);
  }
  setPriority(id: string, priority: boolean) {
    const task = this.tasks.get(id);
    if (task) {
      task.priority = priority;
      this.emitProgress(task);
    }
  }
  private emitProgress(task: BackupTask) {
    this.emit("progress", { ...task, taskId: task.id, fileRecords: undefined });
  }
  private processQueue() {
    if (this.active.size || !this.queue.length) return;
    this.queue.sort(
      (a, b) =>
        Number(this.tasks.get(b)?.priority) -
        Number(this.tasks.get(a)?.priority),
    );
    const id = this.queue.shift()!,
      controller = new AbortController();
    this.active.set(id, controller);
    void this.run(id, controller.signal).finally(() => {
      this.processQueue();
    });
  }
  private async run(id: string, signal: AbortSignal) {
    const task = this.tasks.get(id)!;
    Object.assign(task, {
      status: "running",
      startedAt: Date.now(),
      completedAt: undefined,
      completedFiles: 0,
      transferredBytes: 0,
      fileRecords: [],
      verifyLog: [],
      verifyCompletedFiles: 0,
      verifyTotalFiles: 0,
    });
    for (const d of task.destinations) {
      d.verified = false;
      d.error = undefined;
      d.bytesWritten = 0;
    }
    this.emitProgress(task);
    let last = Date.now(),
      bytes = 0;
    try {
      const { src, dests } = await validatePaths(
        task.sourcePath,
        task.destinations.map((d) => d.path),
      );
      const inventory = await scan(src, task.includeHidden, signal);
      if (!inventory.files.length) throw new Error("素材源没有可备份的文件");
      task.totalFiles = inventory.files.length;
      task.totalBytes = inventory.totalBytes;
      task.skippedFiles = inventory.skipped;
      task.verifyTotalFiles = task.totalFiles * task.destinations.length;
      for (const [i, d] of task.destinations.entries()) {
        signal.throwIfAborted();
        const root =
          task.copyMode === "mirror"
            ? dests[i]
            : path.join(
                dests[i],
                task.shootingDateFolder || "",
                task.namingTemplate,
              );
        await safeChild(dests[i], path.relative(dests[i], root));
        // Do not silently recreate a disconnected volume under /Volumes.
        if (dests[i].startsWith("/Volumes/"))
          await fs.access("/Volumes/" + dests[i].split("/")[2]);
        await fs.mkdir(root, { recursive: true });
        d.resolvedPath = await canonical(root);
        const space = await fs.statfs(root);
        if (space.bavail * space.bsize < task.totalBytes)
          throw new Error(`目的地空间不足：${d.path}`);
        for (const rel of inventory.directories)
          await fs.mkdir(await safeChild(d.resolvedPath, rel), {
            recursive: true,
          });
      }
      this.emitProgress(task);
      for (const file of inventory.files) {
        signal.throwIfAborted();
        task.status = "running";
        task.currentFile = file.relativePath;
        this.emitProgress(task);
        const srcHash = await hashFile(
          file.absolutePath,
          task.hashAlgorithm,
          signal,
        );
        const record: FileRecord = {
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
          srcChecksum: srcHash,
          destinations: [],
        };
        const settled = await Promise.allSettled(
          task.destinations.map(async (d) => {
            let destFile = path.join(d.resolvedPath!, file.relativePath);
            try {
              destFile = await safeChild(d.resolvedPath!, file.relativePath);
              await fs.mkdir(path.dirname(destFile), { recursive: true });
              let exists = await fs.lstat(destFile).then(
                () => true,
                (e) => {
                  if (e.code === "ENOENT") return false;
                  throw e;
                },
              );
              if (exists && task.duplicateStrategy === "suffix") {
                // A retry reuses an identical verified file instead of creating redundant copies.
                if (
                  (await hashFile(destFile, task.hashAlgorithm, signal)) !==
                  srcHash
                ) {
                  const ext = path.extname(destFile),
                    stem = destFile.slice(0, destFile.length - ext.length);
                  let n = 1;
                  while (exists) {
                    destFile = `${stem}_copy_${n++}${ext}`;
                    exists = await fs.lstat(destFile).then(
                      () => true,
                      (e) => {
                        if (e.code === "ENOENT") return false;
                        throw e;
                      },
                    );
                  }
                }
              }
              if (!exists) {
                const temp = destFile + `.kocpy-${id}.partial`;
                // Only remove a stale partial owned by this task, never an original file.
                await fs.unlink(temp).catch((e) => {
                  if (e.code !== "ENOENT") throw e;
                });
                try {
                  const count = new Transform({
                    transform: (chunk, _encoding, callback) => {
                      d.bytesWritten += chunk.length;
                      task.transferredBytes +=
                        chunk.length / task.destinations.length;
                      const elapsed = (Date.now() - last) / 1000;
                      if (elapsed >= 0.3) {
                        task.speedBps =
                          (task.transferredBytes - bytes) / elapsed;
                        task.eta = Math.max(
                          0,
                          (task.totalBytes - task.transferredBytes) /
                            Math.max(1, task.speedBps),
                        );
                        last = Date.now();
                        bytes = task.transferredBytes;
                        this.emitProgress(task);
                      }
                      callback(null, chunk);
                    },
                  });
                  await pipeline(
                    createReadStream(file.absolutePath),
                    count,
                    createWriteStream(temp, { flags: "wx" }),
                    { signal },
                  );
                  const handle = await fs.open(temp, "r+");
                  try {
                    await handle.sync();
                  } finally {
                    await handle.close();
                  }
                  signal.throwIfAborted();
                  // Exclusive publication: link refuses to replace an existing file.
                  await fs.link(temp, destFile).catch(async (e) => {
                    if (
                      !["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
                        e.code,
                      )
                    )
                      throw e;
                    await fs.copyFile(temp, destFile, constants.COPYFILE_EXCL);
                    const published = await fs.open(destFile, "r+");
                    try {
                      await published.sync();
                    } finally {
                      await published.close();
                    }
                  });
                } finally {
                  await fs.unlink(temp).catch(() => {});
                }
              } else {
                task.transferredBytes += file.size / task.destinations.length;
              }
              signal.throwIfAborted();
              task.status = "verifying";
              this.emitProgress(task);
              const checksum = await hashFile(
                destFile,
                task.hashAlgorithm,
                signal,
              );
              const verified = checksum === srcHash;
              if (!verified)
                throw new Error(
                  exists
                    ? "同名文件内容不同，已保留原文件；请使用「创建副本」策略"
                    : "目标哈希校验不一致",
                );
              task.verifyCompletedFiles = (task.verifyCompletedFiles || 0) + 1;
              task.verifyLog.push(
                `✓ ${file.relativePath} → ${d.label}${exists ? " · 已存在，哈希一致" : ""}`,
              );
              return { path: destFile, checksum, verified: true };
            } catch (e: any) {
              if (signal.aborted) throw e;
              d.error = `${file.relativePath}: ${e.message}`;
              task.verifyLog.push(`✗ ${d.label} · ${d.error}`);
              return { path: destFile, checksum: "", verified: false };
            }
          }),
        );
        signal.throwIfAborted();
        const outcomes = settled.map((r) => {
          if (r.status === "rejected") throw r.reason;
          return r.value;
        });
        record.destinations = outcomes;
        task.fileRecords.push(record);
        task.completedFiles++;
        const after = await fs.stat(file.absolutePath);
        if (after.size !== file.size || after.mtimeMs !== file.mtimeMs)
          throw new Error(`备份期间素材发生变化：${file.relativePath}`);
        task.verifyLog = task.verifyLog.slice(-100);
        this.emitProgress(task);
      }
      signal.throwIfAborted();
      for (const [i, d] of task.destinations.entries())
        d.verified =
          !d.error &&
          task.fileRecords.length === task.totalFiles &&
          task.fileRecords.every((r) => r.destinations[i]?.verified);
      if (task.destinations.some((d) => !d.verified))
        throw new Error(
          "部分目的地未通过校验。成功的副本已保留，请查看目标详情。",
        );
      task.status = "completed";
    } catch (e: any) {
      task.status = signal.aborted ? "cancelled" : "failed";
      task.errorMessage = e.message || String(e);
    } finally {
      this.active.delete(id);
      task.completedAt = Date.now();
      task.speedBps = 0;
      task.eta = 0;
      task.currentFile = "";
      this.emitProgress(task);
      this.emit("settled", task);
    }
  }
}
