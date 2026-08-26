import { EventEmitter } from "node:events";
import { promises as fs, constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { BackupTask, TaskConfig, HashAlgorithm, FileRecord, Destination } from "../types";
import { canonical, scan, segment, safeChild, validatePaths } from "./safety";

export async function hashFile(file: string, algorithm: HashAlgorithm, signal?: AbortSignal): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024, signal })) hash.update(chunk);
  return hash.digest("hex");
}

class SpeedMeter {
  private samples: Array<[number, number]> = [];
  add(bytes: number) {
    const now = Date.now();
    this.samples.push([now, bytes]);
    this.samples = this.samples.filter(([time]) => now - time <= 3000);
  }
  rate() {
    if (!this.samples.length) return 0;
    const now = Date.now(), cutoff = now - 2000;
    const useful = this.samples.filter(([time]) => time >= cutoff);
    const elapsed = Math.max(0.35, (now - (useful[0]?.[0] || now)) / 1000);
    return useful.reduce((sum, [, bytes]) => sum + bytes, 0) / elapsed;
  }
}

async function validPrefix(sourcePath: string, partialPath: string, size: number) {
  if (!size) return true;
  const source = await fs.open(sourcePath, "r"), partial = await fs.open(partialPath, "r");
  try {
    const a = Buffer.allocUnsafe(Math.min(size, 1024 * 1024)), b = Buffer.allocUnsafe(a.length);
    let position = 0;
    while (position < size) {
      const length = Math.min(a.length, size - position);
      const [ra, rb] = await Promise.all([source.read(a, 0, length, position), partial.read(b, 0, length, position)]);
      if (ra.bytesRead !== length || rb.bytesRead !== length || !a.subarray(0, length).equals(b.subarray(0, length))) return false;
      position += length;
    }
    return true;
  } finally { await source.close(); await partial.close(); }
}

type CopyTarget = { destination: Destination; finalPath: string; tempPath: string; offset: number };

export class BackupEngine extends EventEmitter {
  private tasks = new Map<string, BackupTask>();
  private queue: string[] = [];
  private active = new Map<string, AbortController>();
  private paused = new Set<string>();
  private pauseWaiters = new Map<string, Array<() => void>>();
  getTask(id: string) { return this.tasks.get(id); }
  getAllTasks() { return [...this.tasks.values()].reverse(); }
  loadTask(task: BackupTask) {
    const complete = task.status === "completed";
    task.copyProgress = complete ? 100 : task.copyProgress ?? (task.totalBytes ? Math.min(100, task.transferredBytes / task.totalBytes * 100) : 0);
    task.verifyProgress = complete ? 100 : task.verifyProgress ?? (task.verifyTotalFiles ? Math.min(100, (task.verifyCompletedFiles || 0) / task.verifyTotalFiles * 100) : 0);
    task.physicalWrittenBytes ??= task.destinations.reduce((sum, d) => sum + d.bytesWritten, 0);
    task.verifiedBytes ??= complete ? task.totalBytes * task.destinations.length : 0;
    for (const d of task.destinations) {
      d.copiedBytes ??= complete ? task.totalBytes : d.bytesWritten;
      d.verifiedBytes ??= d.verified ? task.totalBytes : 0;
      d.copyProgress = complete ? 100 : d.copyProgress ?? Math.min(100, (d.copiedBytes || 0) / Math.max(1, task.totalBytes) * 100);
      d.verifyProgress = d.verified ? 100 : d.verifyProgress ?? 0;
    }
    this.tasks.set(task.id, task);
  }
  hasActive() { return this.active.size > 0; }
  createTask(config: TaskConfig): BackupTask {
    if (!["sha256", "sha1", "md5"].includes(config.hashAlgorithm)) throw new Error("不支持的哈希算法");
    if (!config.destinationPaths?.length || config.destinationPaths.length > 4) throw new Error("请选择 1–4 个目的地");
    if (!path.isAbsolute(config.sourcePath) || config.destinationPaths.some((p) => !path.isAbsolute(p))) throw new Error("请选择有效的文件夹路径");
    const id = randomUUID();
    const timestamp = new Date().toLocaleString("sv-SE", { hour12: false }).replace(/[^0-9]/g, "").slice(0, 14);
    const name = segment(config.namingTemplate || config.name || path.basename(config.sourcePath));
    const folder = `${name}_${timestamp}_${id.slice(0, 4)}`;
    const projectFolder = config.projectName ? path.join(segment(config.projectName), segment(config.shootingDate || new Date().toLocaleDateString("sv-SE")), ...config.devices.slice(0, 1).map(segment)) : "";
    const task: BackupTask = {
      id, name, sourcePath: config.sourcePath, devices: config.devices || [], projectId: config.projectId,
      createdAt: Date.now(), hashAlgorithm: config.hashAlgorithm, namingTemplate: folder,
      shootingDateFolder: projectFolder, copyMode: config.copyMode || "normal", status: "pending",
      totalFiles: 0, completedFiles: 0, totalBytes: 0, transferredBytes: 0,
      physicalWrittenBytes: 0, verifiedBytes: 0, copyProgress: 0, verifyProgress: 0,
      speedBps: 0, aggregateSpeedBps: 0, eta: 0, currentFile: "", verifyLog: [], fileRecords: [],
      priority: config.priority || false, duplicateStrategy: config.duplicateStrategy || "skip",
      includeHidden: config.includeHidden ?? true,
      destinations: config.destinationPaths.map((p) => ({ id: randomUUID(), path: p, label: path.basename(p), verified: false, bytesWritten: 0, copiedBytes: 0, verifiedBytes: 0, copyProgress: 0, verifyProgress: 0, speedBps: 0 })),
    };
    this.tasks.set(id, task);
    return task;
  }
  enqueueTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    if (this.active.has(id) || this.queue.includes(id)) throw new Error("任务已在队列中");
    if (task.status === "completed") throw new Error("已完成任务不能重复启动，请使用重新校验");
    task.status = "pending"; task.errorMessage = undefined; this.queue.push(id); this.emitProgress(task); this.processQueue();
  }
  startTask(id: string) { this.enqueueTask(id); }
  pauseTask(id: string) {
    const task = this.tasks.get(id);
    if (!task || !this.active.has(id) || !["running", "verifying"].includes(task.status)) return;
    this.paused.add(id); task.status = "paused"; task.pausedAt = Date.now(); task.speedBps = 0; task.aggregateSpeedBps = 0; this.emitProgress(task);
  }
  resumeTask(id: string) {
    const task = this.tasks.get(id); if (!task || !this.paused.has(id)) return;
    this.paused.delete(id); task.pausedAt = undefined; task.status = task.verifyProgress && task.verifyProgress > 0 ? "verifying" : "running";
    for (const wake of this.pauseWaiters.get(id) || []) wake(); this.pauseWaiters.delete(id); this.emitProgress(task);
  }
  cancelTask(id: string) {
    const task = this.tasks.get(id); if (!task) return;
    this.resumeTask(id);
    if (this.active.has(id)) this.active.get(id)!.abort(new Error("用户取消任务"));
    else if (task.status === "pending") { this.queue = this.queue.filter((x) => x !== id); task.status = "cancelled"; task.completedAt = Date.now(); this.emitProgress(task); }
  }
  deleteTask(id: string) { if (this.active.has(id) || this.queue.includes(id)) throw new Error("请先取消任务再删除记录"); this.tasks.delete(id); }
  setPriority(id: string, priority: boolean) { const task = this.tasks.get(id); if (task) { task.priority = priority; this.emitProgress(task); } }
  async reverifyTask(id: string) {
    const task = this.tasks.get(id); if (!task) throw new Error("任务不存在");
    if (this.active.has(id)) throw new Error("任务正在执行");
    const controller = new AbortController(); this.active.set(id, controller);
    task.status = "verifying"; task.verifyProgress = 0; task.verifiedBytes = 0; task.verifyCompletedFiles = 0;
    for (const d of task.destinations) { d.verified = false; d.verifiedBytes = 0; d.verifyProgress = 0; d.error = undefined; }
    this.emitProgress(task);
    try {
      await this.verifyRecords(task, controller.signal);
      if (task.destinations.some((d) => !d.verified)) throw new Error("部分目的地未通过重新校验");
      task.status = "completed"; task.lastVerifiedAt = Date.now(); task.completedAt = task.completedAt || Date.now();
    } catch (e: any) { task.status = controller.signal.aborted ? "cancelled" : "failed"; task.errorMessage = e.message || String(e); }
    finally { this.active.delete(id); task.currentFile = ""; task.speedBps = 0; task.aggregateSpeedBps = 0; this.emitProgress(task); this.emit("settled", task); }
    return task;
  }
  private async waitIfPaused(id: string, signal: AbortSignal) {
    while (this.paused.has(id)) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error("任务已取消"));
        signal.addEventListener("abort", onAbort, { once: true });
        const wake = () => { signal.removeEventListener("abort", onAbort); resolve(); };
        this.pauseWaiters.set(id, [...(this.pauseWaiters.get(id) || []), wake]);
      });
    }
    signal.throwIfAborted();
  }
  private emitProgress(task: BackupTask) { task.lastCheckpointAt = Date.now(); this.emit("progress", { ...task, taskId: task.id, fileRecords: undefined }); }
  private processQueue() {
    if (this.active.size || !this.queue.length) return;
    this.queue.sort((a, b) => Number(this.tasks.get(b)?.priority) - Number(this.tasks.get(a)?.priority));
    const id = this.queue.shift()!, controller = new AbortController(); this.active.set(id, controller);
    void this.run(id, controller.signal).finally(() => this.processQueue());
  }
  private async fanout(task: BackupTask, sourcePath: string, size: number, targets: CopyTarget[], signal: AbortSignal, meter: SpeedMeter) {
    const groups = new Map<number, CopyTarget[]>();
    for (const target of targets) groups.set(target.offset, [...(groups.get(target.offset) || []), target]);
    for (const [offset, group] of groups) {
      const source = await fs.open(sourcePath, "r"), outputs = await Promise.all(group.map((t) => fs.open(t.tempPath, t.offset ? "r+" : "w")));
      try {
        let position = offset; const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
        while (position < size) {
          await this.waitIfPaused(task.id, signal);
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position);
          if (!bytesRead) throw new Error("读取源文件时意外结束");
          const chunk = buffer.subarray(0, bytesRead);
          await Promise.all(outputs.map((handle) => handle.write(chunk, 0, bytesRead, position)));
          position += bytesRead;
          for (const target of group) { target.destination.bytesWritten += bytesRead; target.destination.copiedBytes = Math.min(size, (target.destination.copiedBytes || 0) + bytesRead); target.destination.speedBps = meter.rate(); }
          task.physicalWrittenBytes = (task.physicalWrittenBytes || 0) + bytesRead * group.length;
          meter.add(bytesRead * group.length); task.aggregateSpeedBps = meter.rate(); task.speedBps = task.aggregateSpeedBps / Math.max(1, task.destinations.length);
          task.eta = Math.max(0, (task.totalBytes - task.transferredBytes + size - position) / Math.max(1, task.speedBps));
          this.emitProgress(task);
        }
        await Promise.all(outputs.map((handle) => handle.sync()));
      } finally { await source.close(); await Promise.all(outputs.map((handle) => handle.close())); }
    }
  }
  private async publish(temp: string, finalPath: string) {
    await fs.link(temp, finalPath).catch(async (e: NodeJS.ErrnoException) => {
      if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(e.code || "")) throw e;
      await fs.copyFile(temp, finalPath, constants.COPYFILE_EXCL);
      const published = await fs.open(finalPath, "r+"); try { await published.sync(); } finally { await published.close(); }
    });
    await fs.unlink(temp).catch(() => {});
  }
  private async verifyRecords(task: BackupTask, signal: AbortSignal) {
    task.status = "verifying"; task.verifyTotalFiles = task.fileRecords.length * task.destinations.length;
    const totalVerifyBytes = task.totalBytes * task.destinations.length;
    for (const record of task.fileRecords) {
      for (const [index, result] of record.destinations.entries()) {
        await this.waitIfPaused(task.id, signal); task.status = "verifying"; task.currentFile = record.relativePath; this.emitProgress(task);
        const destination = task.destinations[index];
        if (!result.path) { destination.error ||= `${record.relativePath}: 没有可校验的副本`; continue; }
        try {
          const checksum = await hashFile(result.path, task.hashAlgorithm, signal), verified = checksum === record.srcChecksum;
          result.checksum = checksum; result.verified = verified;
          destination.verifiedBytes = (destination.verifiedBytes || 0) + record.size;
          destination.verifyProgress = Math.min(100, ((destination.verifiedBytes || 0) / Math.max(1, task.totalBytes)) * 100);
          task.verifiedBytes = (task.verifiedBytes || 0) + record.size; task.verifyCompletedFiles = (task.verifyCompletedFiles || 0) + 1;
          task.verifyProgress = Math.min(100, ((task.verifiedBytes || 0) / Math.max(1, totalVerifyBytes)) * 100);
          task.verifyLog.push(`${verified ? "✓" : "✗"} ${record.relativePath} → ${destination.label}${result.unchanged ? " · 已存在" : ""}`);
          if (!verified) destination.error = `${record.relativePath}: 目标哈希校验不一致`;
        } catch (e: any) { result.verified = false; destination.error = `${record.relativePath}: ${e.message}`; task.verifyLog.push(`✗ ${destination.label} · ${destination.error}`); }
        task.verifyLog = task.verifyLog.slice(-200); this.emitProgress(task);
      }
    }
    for (const [index, d] of task.destinations.entries()) d.verified = !d.error && task.fileRecords.length === task.totalFiles && task.fileRecords.every((r) => r.destinations[index]?.verified);
  }
  private async run(id: string, signal: AbortSignal) {
    const task = this.tasks.get(id)!;
    Object.assign(task, { status: "running", startedAt: Date.now(), completedAt: undefined, completedFiles: 0, transferredBytes: 0, physicalWrittenBytes: 0, verifiedBytes: 0, copyProgress: 0, verifyProgress: 0, fileRecords: [], verifyLog: [], verifyCompletedFiles: 0, verifyTotalFiles: 0, speedBps: 0, aggregateSpeedBps: 0, volumeWarnings: [] });
    for (const d of task.destinations) Object.assign(d, { verified: false, error: undefined, bytesWritten: 0, copiedBytes: 0, verifiedBytes: 0, copyProgress: 0, verifyProgress: 0, speedBps: 0 });
    this.emitProgress(task); const meter = new SpeedMeter();
    try {
      const { src, dests } = await validatePaths(task.sourcePath, task.destinations.map((d) => d.path));
      const currentSourceVolume = String((await fs.stat(src)).dev);
      if (task.sourceVolumeId && task.sourceVolumeId !== currentSourceVolume) throw new Error("素材源磁盘身份已变化，请新建任务以避免误读同名挂载点");
      task.sourceVolumeId = currentSourceVolume;
      const inventory = await scan(src, task.includeHidden, signal); if (!inventory.files.length) throw new Error("素材源没有可备份的文件");
      task.totalFiles = inventory.files.length; task.totalBytes = inventory.totalBytes; task.skippedFiles = inventory.skipped; task.verifyTotalFiles = task.totalFiles * task.destinations.length;
      const volumeNeeds = new Map<string, { free: number; need: number; labels: string[] }>();
      for (const [i, d] of task.destinations.entries()) {
        const root = task.copyMode === "mirror" ? dests[i] : path.join(dests[i], task.shootingDateFolder || "", task.namingTemplate);
        await safeChild(dests[i], path.relative(dests[i], root));
        if (dests[i].startsWith("/Volumes/")) await fs.access("/Volumes/" + dests[i].split("/")[2]);
        await fs.mkdir(root, { recursive: true }); d.resolvedPath = await canonical(root);
        const stat = await fs.stat(root), space = await fs.statfs(root), currentVolumeId = String(stat.dev);
        if (d.volumeId && d.volumeId !== currentVolumeId) throw new Error(`目的地磁盘身份已变化：${d.label}`);
        d.volumeId = currentVolumeId;
        const previous = volumeNeeds.get(d.volumeId) || { free: space.bavail * space.bsize, need: 0, labels: [] };
        previous.need += task.totalBytes; previous.labels.push(d.label); volumeNeeds.set(d.volumeId, previous);
        for (const rel of inventory.directories) await fs.mkdir(await safeChild(d.resolvedPath, rel), { recursive: true });
      }
      for (const [, volume] of volumeNeeds) {
        if (volume.need > volume.free) throw new Error(`目的地总空间不足：${volume.labels.join("、")} 共需 ${volume.need} 字节`);
        if (volume.labels.length > 1) task.volumeWarnings!.push(`${volume.labels.join("、")} 位于同一物理卷，不能抵御该磁盘故障`);
      }
      for (const file of inventory.files) {
        await this.waitIfPaused(id, signal); task.status = "running"; task.currentFile = file.relativePath; this.emitProgress(task);
        const srcHash = await hashFile(file.absolutePath, task.hashAlgorithm, signal);
        const record: FileRecord = { name: file.name, relativePath: file.relativePath, size: file.size, srcChecksum: srcHash, destinations: [] };
        const targets: CopyTarget[] = [];
        for (const d of task.destinations) {
          let finalPath = await safeChild(d.resolvedPath!, file.relativePath); await fs.mkdir(path.dirname(finalPath), { recursive: true });
          let exists = await fs.lstat(finalPath).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; });
          if (exists) {
            const existingHash = await hashFile(finalPath, task.hashAlgorithm, signal);
            if (existingHash === srcHash) { record.destinations.push({ path: finalPath, checksum: "", verified: false, unchanged: true }); d.copiedBytes = (d.copiedBytes || 0) + file.size; continue; }
            if (task.duplicateStrategy !== "suffix") { record.destinations.push({ path: "", checksum: "", verified: false }); d.error ||= `${file.relativePath}: 同名文件内容不同，已保留原文件`; continue; }
            const ext = path.extname(finalPath), stem = finalPath.slice(0, finalPath.length - ext.length); let n = 1;
            do { finalPath = `${stem}_copy_${n++}${ext}`; exists = await fs.lstat(finalPath).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; }); } while (exists);
          }
          const tempPath = finalPath + `.kocpy-${id}.partial`;
          const foundTempSize = await fs.stat(tempPath).then((s) => Math.min(s.size, file.size), (e) => { if (e.code === "ENOENT") return -1; throw e; });
          let tempSize = Math.max(0, foundTempSize);
          if (tempSize && !(await validPrefix(file.absolutePath, tempPath, tempSize))) {
            await fs.truncate(tempPath, 0); tempSize = 0;
          }
          if (foundTempSize >= 0 && tempSize === file.size) { await this.publish(tempPath, finalPath); record.destinations.push({ path: finalPath, checksum: "", verified: false }); d.copiedBytes = (d.copiedBytes || 0) + file.size; continue; }
          record.destinations.push({ path: finalPath, checksum: "", verified: false }); d.copiedBytes = (d.copiedBytes || 0) + tempSize;
          targets.push({ destination: d, finalPath, tempPath, offset: tempSize });
        }
        await this.fanout(task, file.absolutePath, file.size, targets, signal, meter);
        for (const target of targets) await this.publish(target.tempPath, target.finalPath);
        task.transferredBytes += file.size; task.completedFiles++; task.copyProgress = Math.min(100, (task.transferredBytes / Math.max(1, task.totalBytes)) * 100);
        for (const d of task.destinations) d.copyProgress = Math.min(100, ((d.copiedBytes || 0) / Math.max(1, task.totalBytes)) * 100);
        task.fileRecords.push(record);
        const after = await fs.stat(file.absolutePath); if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw new Error(`备份期间素材发生变化：${file.relativePath}`);
        this.emitProgress(task);
      }
      task.speedBps = 0; task.aggregateSpeedBps = 0; task.eta = 0; await this.verifyRecords(task, signal); signal.throwIfAborted();
      if (task.destinations.some((d) => !d.verified)) throw new Error("部分目的地未通过校验。成功的副本已保留，可单独重试失败目标。");
      task.status = "completed"; task.lastVerifiedAt = Date.now();
    } catch (e: any) { task.status = signal.aborted ? "cancelled" : "failed"; task.errorMessage = e.message || String(e); }
    finally { this.paused.delete(id); this.active.delete(id); task.completedAt = Date.now(); task.speedBps = 0; task.aggregateSpeedBps = 0; task.eta = 0; task.currentFile = ""; this.emitProgress(task); this.emit("settled", task); }
  }
}
