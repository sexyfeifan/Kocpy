import { EventEmitter } from "node:events";
import { promises as fs, constants, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BackupTask,
  TaskConfig,
  HashAlgorithm,
  FileRecord,
  Destination,
  TransferPerformance,
} from "../types";
import { canonical, inside, scan, segment, safeChild } from "./safety";
import { volumeIdentity } from "../system";
import { inspectMedia, isThumbnailMedia } from "../media";
import { makeProjectFolderName, renderProjectCardPath } from "../project-path";
import { mediaBreakdownFromFiles } from "../media-kind";
import { XxHash32 } from "./XxHash32";

export async function hashFile(
  file: string,
  algorithm: HashAlgorithm,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
): Promise<string> {
  if (algorithm === "xxhash32") {
    const hash = new XxHash32();
    for await (const chunk of createReadStream(file, {
      highWaterMark: 4 * 1024 * 1024,
      signal,
    })) {
      hash.update(chunk);
      onBytes?.(chunk.length);
    }
    return hash.digestDecimal();
  }
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file, {
    highWaterMark: 4 * 1024 * 1024,
    signal,
  })) {
    hash.update(chunk);
    onBytes?.(chunk.length);
  }
  return hash.digest("hex");
}
async function hashSource(
  file: string,
  algorithm: HashAlgorithm,
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void,
) {
  if (algorithm === "xxhash32") {
    const primary = new XxHash32(),
      md5 = createHash("md5");
    for await (const chunk of createReadStream(file, {
      highWaterMark: 4 * 1024 * 1024,
      signal,
    })) {
      primary.update(chunk);
      md5.update(chunk);
      onBytes?.(chunk.length);
    }
    return { primary: primary.digestDecimal(), md5: md5.digest("hex") };
  }
  const primary = createHash(algorithm),
    md5 = algorithm === "md5" ? primary : createHash("md5");
  for await (const chunk of createReadStream(file, {
    highWaterMark: 4 * 1024 * 1024,
    signal,
  })) {
    primary.update(chunk);
    if (md5 !== primary) md5.update(chunk);
    onBytes?.(chunk.length);
  }
  const digest = primary.digest("hex");
  return { primary: digest, md5: md5 === primary ? digest : md5.digest("hex") };
}

export class SpeedMeter {
  private pending = 0;
  private smoothed = 0;
  constructor(private lastSample = Date.now()) {}
  add(bytes: number) {
    this.pending += bytes;
  }
  sample(now = Date.now()) {
    const elapsed = (now - this.lastSample) / 1000;
    if (elapsed < 0.25) return this.smoothed;
    const raw = this.pending / Math.max(0.001, elapsed);
    this.pending = 0;
    this.lastSample = now;
    const alpha = raw > 0 ? 0.12 : 0.28;
    this.smoothed = this.smoothed
      ? this.smoothed * (1 - alpha) + raw * alpha
      : raw;
    if (this.smoothed < 1024) this.smoothed = 0;
    return this.smoothed;
  }
}

export function summarizeSpeeds(values: number[]): TransferPerformance {
  const samples = values.filter(
      (value) => Number.isFinite(value) && value >= 0,
    ),
    active = samples.filter((value) => value >= 1024),
    sorted = [...active].sort((a, b) => a - b);
  const percentile = (ratio: number) =>
    sorted.length
      ? sorted[
          Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))
        ]
      : 0;
  return {
    average: active.length
      ? active.reduce((sum, value) => sum + value, 0) / active.length
      : 0,
    peak: sorted.at(-1) || 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    samples: samples.length,
    stalls: samples.filter((value) => value < 1024).length,
  };
}

async function validPrefix(
  sourcePath: string,
  partialPath: string,
  size: number,
) {
  if (!size) return true;
  const source = await fs.open(sourcePath, "r"),
    partial = await fs.open(partialPath, "r");
  try {
    const a = Buffer.allocUnsafe(Math.min(size, 1024 * 1024)),
      b = Buffer.allocUnsafe(a.length);
    let position = 0;
    while (position < size) {
      const length = Math.min(a.length, size - position);
      const [ra, rb] = await Promise.all([
        source.read(a, 0, length, position),
        partial.read(b, 0, length, position),
      ]);
      if (
        ra.bytesRead !== length ||
        rb.bytesRead !== length ||
        !a.subarray(0, length).equals(b.subarray(0, length))
      )
        return false;
      position += length;
    }
    return true;
  } finally {
    await source.close();
    await partial.close();
  }
}

type CopyTarget = {
  destination: Destination;
  finalPath: string;
  tempPath: string;
  offset: number;
};

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r").catch((error) => {
    if (["EISDIR", "EINVAL", "ENOTSUP"].includes(error.code || ""))
      return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error) => {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code || ""))
        throw error;
    });
  } finally {
    await handle.close();
  }
}

async function syncPublishedFile(file: string) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function preserveFileMetadata(
  file: string,
  source: { mode: number; atimeMs: number; mtimeMs: number },
) {
  await fs.chmod(file, source.mode).catch(() => undefined);
  await fs
    .utimes(file, new Date(source.atimeMs), new Date(source.mtimeMs))
    .catch(() => undefined);
  await syncPublishedFile(file);
}

export class BackupEngine extends EventEmitter {
  constructor(private readonly thumbnailDir?: string) {
    super();
  }
  private tasks = new Map<string, BackupTask>();
  private queue: string[] = [];
  private active = new Map<string, AbortController>();
  private paused = new Set<string>();
  private retryTargets = new Map<string, Set<string>>();
  private pauseWaiters = new Map<string, Array<() => void>>();
  private lastProgressEmit = new Map<string, number>();
  getTask(id: string) {
    return this.tasks.get(id);
  }
  getAllTasks() {
    return [...this.tasks.values()].reverse();
  }
  loadTask(task: BackupTask) {
    const complete = task.status === "completed";
    task.copyProgress = complete
      ? 100
      : (task.copyProgress ??
        (task.totalBytes
          ? Math.min(100, (task.transferredBytes / task.totalBytes) * 100)
          : 0));
    task.verifyProgress = complete
      ? 100
      : (task.verifyProgress ??
        (task.verifyTotalFiles
          ? Math.min(
              100,
              ((task.verifyCompletedFiles || 0) / task.verifyTotalFiles) * 100,
            )
          : 0));
    task.physicalWrittenBytes ??= task.destinations.reduce(
      (sum, d) => sum + d.bytesWritten,
      0,
    );
    task.verifiedBytes ??= complete
      ? task.totalBytes * task.destinations.length
      : 0;
    task.verifySpeedBps ??= 0;
    task.verifyEta ??= 0;
    for (const d of task.destinations) {
      d.copiedBytes ??= complete ? task.totalBytes : d.bytesWritten;
      d.verifiedBytes ??= d.verified ? task.totalBytes : 0;
      d.copyProgress = complete
        ? 100
        : (d.copyProgress ??
          Math.min(
            100,
            ((d.copiedBytes || 0) / Math.max(1, task.totalBytes)) * 100,
          ));
      d.verifyProgress = d.verified ? 100 : (d.verifyProgress ?? 0);
      d.verifySpeedBps ??= 0;
    }
    this.tasks.set(task.id, task);
  }
  hasActive() {
    return this.active.size > 0;
  }
  createTask(config: TaskConfig): BackupTask {
    if (!["sha256", "sha1", "md5"].includes(config.hashAlgorithm))
      throw new Error("不支持的哈希算法");
    if (config.cameraPosition && !/^[A-E]$/.test(config.cameraPosition))
      throw new Error("机位只能选择 A–E");
    if (!config.destinationPaths?.length || config.destinationPaths.length > 4)
      throw new Error("请选择 1–4 个目的地");
    if (
      !path.isAbsolute(config.sourcePath) ||
      config.destinationPaths.some((p) => !path.isAbsolute(p))
    )
      throw new Error("请选择有效的文件夹路径");
    const id = randomUUID();
    const timestamp = new Date()
      .toLocaleString("sv-SE", { hour12: false })
      .replace(/[^0-9]/g, "")
      .slice(0, 14);
    const name = segment(
      config.namingTemplate || config.name || path.basename(config.sourcePath),
    );
    const sourceVolumeName = segment(path.basename(config.sourcePath) || name);
    const folder = config.projectId
      ? name
      : config.copyMode === "mirror"
        ? sourceVolumeName
        : `${sourceVolumeName}_${timestamp}`;
    const projectFolderName = config.projectId
      ? config.projectFolderName ||
        makeProjectFolderName(
          config.projectStartDate || config.shootingDate,
          config.projectName || "项目",
        )
      : undefined;
    const projectCardPath = projectFolderName
      ? renderProjectCardPath(config.projectNamingRule, {
          projectFolderName,
          projectName: config.projectName || "项目",
          projectStartDate: config.projectStartDate || config.shootingDate,
          shootingDate: config.shootingDate,
          device: config.devices[0] || "未指定设备",
          position: config.cameraPosition,
          card: name,
        })
      : "";
    const projectFolder = projectCardPath ? path.dirname(projectCardPath) : "",
      projectCard = projectCardPath ? path.basename(projectCardPath) : folder;
    const task: BackupTask = {
      id,
      name,
      sourcePath: config.sourcePath,
      devices: config.devices || [],
      projectId: config.projectId,
      projectFolderName,
      shootingDate: config.shootingDate,
      cameraPosition: config.cameraPosition,
      createdAt: Date.now(),
      hashAlgorithm: config.hashAlgorithm,
      namingTemplate: projectFolderName ? projectCard : folder,
      shootingDateFolder: projectFolder,
      copyMode: config.copyMode || "normal",
      status: "pending",
      totalFiles: 0,
      completedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      physicalWrittenBytes: 0,
      verifiedBytes: 0,
      copyProgress: 0,
      verifyProgress: 0,
      speedBps: 0,
      aggregateSpeedBps: 0,
      verifySpeedBps: 0,
      verifyEta: 0,
      eta: 0,
      currentFile: "",
      verifyLog: [],
      fileRecords: [],
      priority: config.priority || false,
      duplicateStrategy: config.duplicateStrategy || "skip",
      includeHidden: config.includeHidden ?? true,
      volumeNumber: config.volumeNumber,
      generateThumbnails: config.generateThumbnails ?? true,
      faultTimeline: [
        {
          at: Date.now(),
          phase: "created",
          level: "info",
          message: "任务已创建",
        },
      ],
      destinations: config.destinationPaths.map((p) => ({
        id: randomUUID(),
        path: p,
        label: path.basename(p),
        verified: false,
        bytesWritten: 0,
        copiedBytes: 0,
        verifiedBytes: 0,
        copyProgress: 0,
        verifyProgress: 0,
        speedBps: 0,
        verifySpeedBps: 0,
      })),
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
      throw new Error("已完成任务不能重复启动，请使用重新校验");
    task.status = "pending";
    task.errorMessage = undefined;
    this.queue.push(id);
    this.emitProgress(task);
    this.processQueue();
  }
  startTask(id: string) {
    this.enqueueTask(id);
  }
  retryFailedDestinations(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    if (this.active.has(id) || this.queue.includes(id))
      throw new Error("任务已在队列中");
    const failed = task.destinations
      .filter((destination) => !destination.verified)
      .map((destination) => destination.id);
    if (!failed.length) throw new Error("没有可重试的失败目标");
    this.retryTargets.set(id, new Set(failed));
    this.enqueueTask(id);
  }
  pauseTask(id: string) {
    const task = this.tasks.get(id);
    if (
      !task ||
      !this.active.has(id) ||
      !["running", "verifying"].includes(task.status)
    )
      return;
    this.paused.add(id);
    task.status = "paused";
    task.pausedAt = Date.now();
    task.speedBps = 0;
    task.aggregateSpeedBps = 0;
    task.verifySpeedBps = 0;
    this.record(task, "paused", "warning", "任务已暂停，检查点已保留");
    this.emitProgress(task);
  }
  resumeTask(id: string) {
    const task = this.tasks.get(id);
    if (!task || !this.paused.has(id)) return;
    this.paused.delete(id);
    task.pausedAt = undefined;
    task.status =
      task.verifyProgress && task.verifyProgress > 0 ? "verifying" : "running";
    this.record(task, "resumed", "info", "任务已从检查点继续");
    for (const wake of this.pauseWaiters.get(id) || []) wake();
    this.pauseWaiters.delete(id);
    this.emitProgress(task);
  }
  cancelTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.resumeTask(id);
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
  private async assertRecordedVolume(
    location: string,
    expectedUuid: string | undefined,
    expectedId: string | undefined,
    label: string,
  ) {
    const identity = await volumeIdentity(location);
    if (expectedUuid && expectedUuid !== identity.uuid)
      throw new Error(`${label}磁盘 UUID 已变化，已停止操作`);
    if (!expectedUuid && expectedId && expectedId !== identity.id)
      throw new Error(`${label}磁盘身份已变化，已停止操作`);
    return identity;
  }
  async reverifyTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("任务不存在");
    if (this.active.has(id)) throw new Error("任务正在执行");
    const controller = new AbortController();
    this.active.set(id, controller);
    task.status = "verifying";
    task.verifyProgress = 0;
    task.verifiedBytes = 0;
    task.verifyCompletedFiles = 0;
    task.verifySpeedBps = 0;
    task.verifyEta = 0;
    for (const d of task.destinations) {
      d.verified = false;
      d.verifiedBytes = 0;
      d.verifyProgress = 0;
      d.verifySpeedBps = 0;
      d.error = undefined;
    }
    this.emitProgress(task);
    try {
      for (const destination of task.destinations)
        await this.assertRecordedVolume(
          destination.resolvedPath || destination.path,
          destination.volumeUuid,
          destination.volumeId,
          `${destination.label} `,
        );
      await this.verifyRecords(task, controller.signal);
      if (task.destinations.some((d) => !d.verified))
        throw new Error("部分目的地未通过重新校验");
      task.status = "completed";
      task.lastVerifiedAt = Date.now();
      task.completedAt = task.completedAt || Date.now();
    } catch (e: any) {
      task.status = controller.signal.aborted ? "cancelled" : "failed";
      task.errorMessage = e.message || String(e);
    } finally {
      this.active.delete(id);
      task.currentFile = "";
      task.speedBps = 0;
      task.aggregateSpeedBps = 0;
      task.verifySpeedBps = 0;
      task.verifyEta = 0;
      this.emitProgress(task);
      this.emit("settled", task);
    }
    return task;
  }
  private async waitIfPaused(id: string, signal: AbortSignal) {
    while (this.paused.has(id)) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason || new Error("任务已取消"));
        signal.addEventListener("abort", onAbort, { once: true });
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        this.pauseWaiters.set(id, [...(this.pauseWaiters.get(id) || []), wake]);
      });
    }
    signal.throwIfAborted();
  }
  private emitProgress(task: BackupTask, force = false) {
    const now = Date.now(),
      previous = this.lastProgressEmit.get(task.id) || 0;
    if (!force && now - previous < 300) return;
    this.lastProgressEmit.set(task.id, now);
    task.lastCheckpointAt = now;
    this.emit("progress", { ...task, taskId: task.id, fileRecords: undefined });
  }
  private record(
    task: BackupTask,
    phase: string,
    level: "info" | "warning" | "error",
    message: string,
  ) {
    task.faultTimeline = [
      ...(task.faultTimeline || []).slice(-99),
      { at: Date.now(), phase, level, message },
    ];
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
    void this.run(id, controller.signal).finally(() => this.processQueue());
  }
  private async fanout(
    task: BackupTask,
    sourcePath: string,
    size: number,
    targets: CopyTarget[],
    signal: AbortSignal,
    meter: SpeedMeter,
    destinationMeters: Map<string, SpeedMeter>,
    sourceCopyMeter: SpeedMeter,
  ) {
    const groups = new Map<number, CopyTarget[]>();
    for (const target of targets)
      groups.set(target.offset, [...(groups.get(target.offset) || []), target]);
    for (const [offset, group] of groups) {
      const source = await fs.open(sourcePath, "r");
      const states: Array<{
        target: CopyTarget;
        handle: Awaited<ReturnType<typeof fs.open>>;
        position: number;
        active: boolean;
        pending?: Promise<void>;
      }> = [];
      for (const target of group) {
        try {
          states.push({
            target,
            handle: await fs.open(target.tempPath, target.offset ? "r+" : "w"),
            position: offset,
            active: true,
          });
        } catch (e: any) {
          target.destination.available = false;
          target.destination.error = `无法打开断点文件：${e.message}`;
        }
      }
      try {
        let position = offset;
        while (position < size) {
          await this.waitIfPaused(task.id, signal);
          if (!states.some((state) => state.active)) break;
          const buffer = Buffer.allocUnsafe(
            Math.min(4 * 1024 * 1024, size - position),
          );
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, size - position),
            position,
          );
          if (!bytesRead) throw new Error("读取源文件时意外结束");
          sourceCopyMeter.add(bytesRead);
          const chunk = buffer.subarray(0, bytesRead),
            chunkOffset = position;
          const active = states.filter((state) => state.active);
          const written = (state: (typeof states)[number]) => {
            const d = state.target.destination,
              own = destinationMeters.get(d.id)!;
            own.add(bytesRead);
            d.bytesWritten += bytesRead;
            d.copiedBytes = Math.min(
              task.totalBytes,
              (d.copiedBytes || 0) + bytesRead,
            );
            state.position = chunkOffset + bytesRead;
            const firstWrite = !task.physicalWrittenBytes;
            task.physicalWrittenBytes =
              (task.physicalWrittenBytes || 0) + bytesRead;
            meter.add(bytesRead);
            if (firstWrite) this.emitProgress(task, true);
          };
          await Promise.all(
            active.map(async (state) => {
              const actual = state.handle
                .write(chunk, 0, bytesRead, chunkOffset)
                .then(() => written(state))
                .catch((e: any) => {
                  state.active = false;
                  state.target.destination.available = false;
                  state.target.destination.error = `写入失败：${e.message}`;
                });
              if (active.length === 1) {
                await actual;
                return;
              }
              const result = await Promise.race([
                actual.then(() => "done" as const),
                new Promise<"slow">((resolve) =>
                  setTimeout(() => resolve("slow"), 2000),
                ),
              ]);
              if (result === "slow") {
                state.active = false;
                state.pending = actual;
                task.volumeWarnings?.push(
                  `${state.target.destination.label} 写入响应较慢，已从快速扇出分离，健康目标会先完成`,
                );
              }
            }),
          );
          position += bytesRead;
        }
        await Promise.all(
          states
            .filter((state) => state.active)
            .map((state) => state.handle.sync()),
        );
      } finally {
        await source.close();
        await Promise.all(
          states
            .filter((state) => state.active)
            .map((state) => state.handle.close().catch(() => {})),
        );
      }
      for (const state of states.filter(
        (state) => !state.active && state.pending,
      )) {
        await state.pending;
        await state.handle.sync().catch(() => {});
        await state.handle.close().catch(() => {});
        if (
          state.target.destination.available !== false &&
          state.position < size
        ) {
          state.target.offset = state.position;
          await this.fanout(
            task,
            sourcePath,
            size,
            [state.target],
            signal,
            meter,
            destinationMeters,
            sourceCopyMeter,
          );
        }
      }
      await Promise.all(
        states
          .filter((state) => !state.active && !state.pending)
          .map((state) => state.handle.close().catch(() => {})),
      );
    }
  }
  private async publish(temp: string, finalPath: string) {
    await fs.link(temp, finalPath).catch(async (e: NodeJS.ErrnoException) => {
      if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(e.code || ""))
        throw e;
      await fs.copyFile(temp, finalPath, constants.COPYFILE_EXCL);
      const published = await fs.open(finalPath, "r+");
      try {
        await published.sync();
      } finally {
        await published.close();
      }
    });
    await syncPublishedFile(finalPath);
    await fs.unlink(temp).catch(() => {});
    await syncDirectory(path.dirname(finalPath));
  }
  private async verifyRecords(
    task: BackupTask,
    signal: AbortSignal,
    targetIds?: Set<string>,
  ) {
    const selected = (destination: Destination) =>
      !targetIds || targetIds.has(destination.id);
    const availableCount = task.destinations.filter(
      (d) => selected(d) && d.available !== false,
    ).length;
    task.status = "verifying";
    task.verifyTotalFiles = task.fileRecords.length * availableCount;
    this.emitProgress(task, true);
    const totalVerifyBytes = task.totalBytes * availableCount;
    const meter = new SpeedMeter(),
      destinationMeters = new Map(
        task.destinations.map((d) => [d.id, new SpeedMeter()]),
      );
    let displayedEta = 0;
    const telemetry = setInterval(() => {
      if (task.status !== "verifying") return;
      task.verifySpeedBps = meter.sample();
      for (const d of task.destinations)
        d.verifySpeedBps = destinationMeters.get(d.id)?.sample() || 0;
      const rawEta = task.verifySpeedBps
        ? Math.max(0, totalVerifyBytes - (task.verifiedBytes || 0)) /
          task.verifySpeedBps
        : 0;
      displayedEta = rawEta
        ? displayedEta
          ? displayedEta * 0.9 + rawEta * 0.1
          : rawEta
        : 0;
      task.verifyEta = displayedEta;
      const at = Date.now();
      for (const d of task.destinations) {
        d.speedHistory = [
          ...(d.speedHistory || []),
          { at, copy: 0, verify: d.verifySpeedBps || 0 },
        ].slice(-30);
        if (!d.verified || (d.verifySpeedBps || 0) > 0)
          d.verifySpeedSamples = [
            ...(d.verifySpeedSamples || []),
            d.verifySpeedBps || 0,
          ].slice(-3600);
      }
      this.emitProgress(task);
    }, 1000);
    try {
      for (const record of task.fileRecords) {
        for (const [index, result] of record.destinations.entries()) {
          await this.waitIfPaused(task.id, signal);
          task.status = "verifying";
          task.currentFile = record.relativePath;
          this.emitProgress(task);
          const destination = task.destinations[index];
          if (!selected(destination)) continue;
          if (destination.available === false) continue;
          if (!result.path) {
            destination.error ||= `${record.relativePath}: 没有可校验的副本`;
            continue;
          }
          try {
            const checksum = await hashFile(
                result.path,
                task.hashAlgorithm,
                signal,
                (count) => {
                  meter.add(count);
                  destinationMeters.get(destination.id)?.add(count);
                  destination.verifiedBytes =
                    (destination.verifiedBytes || 0) + count;
                  task.verifiedBytes = (task.verifiedBytes || 0) + count;
                  destination.verifyProgress = Math.min(
                    100,
                    ((destination.verifiedBytes || 0) /
                      Math.max(1, task.totalBytes)) *
                      100,
                  );
                  task.verifyProgress = Math.min(
                    100,
                    ((task.verifiedBytes || 0) /
                      Math.max(1, totalVerifyBytes)) *
                      100,
                  );
                },
              ),
              verified = checksum === record.srcChecksum;
            result.checksum = checksum;
            result.verified = verified;
            task.verifyCompletedFiles = (task.verifyCompletedFiles || 0) + 1;
            task.verifyLog.push(
              `${verified ? "✓" : "✗"} ${record.relativePath} → ${destination.label}${result.unchanged ? " · 已存在" : ""}`,
            );
            if (!verified)
              destination.error = `${record.relativePath}: 目标哈希校验不一致`;
          } catch (e: any) {
            result.verified = false;
            destination.error = `${record.relativePath}: ${e.message}`;
            task.verifyLog.push(
              `✗ ${destination.label} · ${destination.error}`,
            );
          }
          task.verifyLog = task.verifyLog.slice(-200);
          this.emitProgress(task);
        }
      }
    } finally {
      clearInterval(telemetry);
      task.verifySpeedBps = 0;
      task.verifyEta = 0;
      for (const d of task.destinations) d.verifySpeedBps = 0;
    }
    for (const [index, d] of task.destinations.entries()) {
      if (!selected(d)) continue;
      d.verified =
        d.available !== false &&
        !d.error &&
        task.fileRecords.length === task.totalFiles &&
        task.fileRecords.every((r) => r.destinations[index]?.verified);
      if (d.verified) d.copiedBytes = task.totalBytes;
    }
  }
  private async generateTaskThumbnails(task: BackupTask, signal: AbortSignal) {
    if (!task.generateThumbnails || !this.thumbnailDir) return;
    let failures = 0;
    for (const record of task.fileRecords) {
      if (!isThumbnailMedia(record.name) || record.thumbnailPath) continue;
      signal.throwIfAborted();
      const readable = record.destinations.find(
        (destination) => destination.verified && destination.path,
      )?.path;
      if (!readable) continue;
      try {
        record.thumbnailPath = (
          await inspectMedia(readable, this.thumbnailDir)
        ).thumbnailPath;
        if (!record.thumbnailPath) failures++;
      } catch {
        failures++;
      }
    }
    task.thumbnailError = failures
      ? `${failures} 个媒体文件未能生成缩略图，不影响备份与校验结果`
      : undefined;
  }
  private async run(id: string, signal: AbortSignal) {
    const task = this.tasks.get(id)!;
    const retryTargetIds = this.retryTargets.get(id);
    const previousRecords = retryTargetIds
      ? new Map(task.fileRecords.map((record) => [record.relativePath, record]))
      : new Map<string, FileRecord>();
    let completionNotified = false;
    Object.assign(task, {
      status: "running",
      startedAt: Date.now(),
      completedAt: undefined,
      completedFiles: 0,
      transferredBytes: 0,
      physicalWrittenBytes: 0,
      verifiedBytes: 0,
      copyProgress: 0,
      verifyProgress: 0,
      fileRecords: [],
      verifyLog: [],
      verifyCompletedFiles: 0,
      verifyTotalFiles: 0,
      speedBps: 0,
      aggregateSpeedBps: 0,
      verifySpeedBps: 0,
      verifyEta: 0,
      sourceReadSpeedBps: 0,
      sourceHashSpeedBps: 0,
      sourceCopyReadSpeedBps: 0,
      sourceSpeedHistory: [],
      sourceHashHistory: [],
      sourceCopyReadHistory: [],
      volumeWarnings: [],
    });
    this.record(task, "preflight", "info", "开始扫描素材源并检查目的地");
    for (const d of task.destinations) {
      if (!retryTargetIds || retryTargetIds.has(d.id))
        Object.assign(d, {
          verified: false,
          error: undefined,
          available: true,
          resolvedPath: undefined,
          bytesWritten: 0,
          copiedBytes: 0,
          verifiedBytes: 0,
          copyProgress: 0,
          verifyProgress: 0,
          speedBps: 0,
          verifySpeedBps: 0,
          speedHistory: [],
          copySpeedSamples: [],
          verifySpeedSamples: [],
          performance: undefined,
          verifyPerformance: undefined,
        });
      else
        Object.assign(d, {
          available: true,
          copiedBytes: task.totalBytes,
          verifiedBytes: task.totalBytes,
          copyProgress: 100,
          verifyProgress: 100,
          speedBps: 0,
          verifySpeedBps: 0,
        });
    }
    this.emitProgress(task);
    const meter = new SpeedMeter(),
      sourceHashMeter = new SpeedMeter(),
      sourceCopyMeter = new SpeedMeter(),
      destinationMeters = new Map(
        task.destinations.map((d) => [d.id, new SpeedMeter()]),
      );
    let displayedEta = 0;
    const telemetry = setInterval(() => {
      if (task.status !== "running") return;
      task.aggregateSpeedBps = meter.sample();
      task.sourceHashSpeedBps = sourceHashMeter.sample();
      task.sourceCopyReadSpeedBps = sourceCopyMeter.sample();
      task.sourceReadSpeedBps =
        task.sourceHashSpeedBps || task.sourceCopyReadSpeedBps;
      for (const d of task.destinations)
        d.speedBps = destinationMeters.get(d.id)?.sample() || 0;
      const healthy = task.destinations.filter((d) => d.available !== false);
      const pending = healthy.filter(
          (d) => (d.copiedBytes || 0) < task.totalBytes,
        ),
        rates = pending.map((d) => d.speedBps || 0);
      task.speedBps =
        rates.length && rates.every((rate) => rate > 0)
          ? Math.min(...rates)
          : 0;
      const rawEta = task.speedBps
        ? Math.max(
            ...pending.map(
              (d) =>
                Math.max(0, task.totalBytes - (d.copiedBytes || 0)) /
                Math.max(1, d.speedBps || task.speedBps),
            ),
          )
        : 0;
      displayedEta = rawEta
        ? displayedEta
          ? displayedEta * 0.9 + rawEta * 0.1
          : rawEta
        : 0;
      task.eta = displayedEta;
      const at = Date.now();
      task.sourceSpeedHistory = [
        ...(task.sourceSpeedHistory || []),
        { at, speed: task.sourceReadSpeedBps },
      ].slice(-30);
      task.sourceHashHistory = [
        ...(task.sourceHashHistory || []),
        { at, speed: task.sourceHashSpeedBps },
      ].slice(-3600);
      task.sourceCopyReadHistory = [
        ...(task.sourceCopyReadHistory || []),
        { at, speed: task.sourceCopyReadSpeedBps },
      ].slice(-3600);
      for (const d of task.destinations) {
        d.speedHistory = [
          ...(d.speedHistory || []),
          { at, copy: d.speedBps || 0, verify: 0 },
        ].slice(-30);
        if ((d.copiedBytes || 0) < task.totalBytes || (d.speedBps || 0) > 0)
          d.copySpeedSamples = [
            ...(d.copySpeedSamples || []),
            d.speedBps || 0,
          ].slice(-3600);
      }
      this.emitProgress(task);
    }, 1000);
    try {
      const src = await canonical(task.sourcePath);
      if (!(await fs.stat(src)).isDirectory())
        throw new Error("素材源必须是文件夹");
      const dests = await Promise.all(
        task.destinations.map(async (d) => {
          if (retryTargetIds && !retryTargetIds.has(d.id))
            return d.resolvedPath || d.path;
          try {
            return await canonical(d.path);
          } catch (e: any) {
            d.available = false;
            d.error = `预检失败：${e.message}`;
            return d.path;
          }
        }),
      );
      for (let i = 0; i < dests.length; i++) {
        if (retryTargetIds && !retryTargetIds.has(task.destinations[i].id))
          continue;
        if (task.destinations[i].available === false) continue;
        if (inside(dests[i], src) || inside(src, dests[i])) {
          task.destinations[i].available = false;
          task.destinations[i].error =
            "预检失败：素材源与目的地不能相同或互相包含";
          continue;
        }
        for (let prior = 0; prior < i; prior++)
          if (
            task.destinations[prior].available !== false &&
            (inside(dests[i], dests[prior]) || inside(dests[prior], dests[i]))
          ) {
            task.destinations[i].available = false;
            task.destinations[i].error = "预检失败：目的地重复或互相包含";
            break;
          }
      }
      const sourceIdentity = await volumeIdentity(src);
      if (
        task.sourceVolumeUuid &&
        task.sourceVolumeUuid !== sourceIdentity.uuid
      )
        throw new Error(
          "素材源磁盘 UUID 已变化，请新建任务以避免误读同名挂载点",
        );
      if (
        !task.sourceVolumeUuid &&
        task.sourceVolumeId &&
        task.sourceVolumeId !== sourceIdentity.id
      )
        throw new Error("素材源磁盘身份已变化，请新建任务以避免误读同名挂载点");
      task.sourceVolumeId = sourceIdentity.id;
      task.sourceVolumeUuid = sourceIdentity.uuid;
      task.sourceVolumeName = sourceIdentity.name;
      const inventory = await scan(src, task.includeHidden, signal);
      if (!inventory.files.length) throw new Error("素材源没有可备份的文件");
      task.totalFiles = inventory.files.length;
      task.totalBytes = inventory.totalBytes;
      task.skippedFiles = inventory.skipped;
      task.verifyTotalFiles = task.totalFiles * task.destinations.length;
      task.mediaBreakdown = mediaBreakdownFromFiles(inventory.files);
      const volumeNeeds = new Map<
        string,
        { free: number; need: number; largest: number; labels: string[] }
      >();
      for (const [i, d] of task.destinations.entries()) {
        if (retryTargetIds && !retryTargetIds.has(d.id)) continue;
        if (d.available === false) continue;
        try {
          const root =
            task.copyMode === "mirror"
              ? dests[i]
              : path.join(
                  dests[i],
                  task.shootingDateFolder || "",
                  task.namingTemplate,
                );
          await safeChild(dests[i], path.relative(dests[i], root));
          if (dests[i].startsWith("/Volumes/"))
            await fs.access("/Volumes/" + dests[i].split("/")[2]);
          const identity = await volumeIdentity(dests[i]);
          if (d.volumeUuid && d.volumeUuid !== identity.uuid)
            throw new Error("磁盘 UUID 与任务记录不一致");
          if (!d.volumeUuid && d.volumeId && d.volumeId !== identity.id)
            throw new Error("磁盘身份与任务记录不一致");
          d.volumeId = identity.id;
          d.volumeUuid = identity.uuid;
          d.volumeName = identity.name;
          await fs.mkdir(root, { recursive: true });
          d.resolvedPath = await canonical(root);
          const space = await fs.statfs(root);
          let required = 0,
            largest = 0;
          for (const file of inventory.files) {
            const finalPath = await safeChild(
              d.resolvedPath,
              file.relativePath,
            );
            const finalExists = await fs.access(finalPath).then(
              () => true,
              () => false,
            );
            if (finalExists && task.duplicateStrategy !== "suffix") continue;
            const partial = finalPath + `.kocpy-${id}.partial`;
            const partialSize = await fs.stat(partial).then(
              (s) => Math.min(file.size, s.size),
              () => 0,
            );
            const remaining = Math.max(0, file.size - partialSize);
            required += remaining;
            largest = Math.max(largest, remaining);
          }
          const previous = volumeNeeds.get(identity.id) || {
            free: space.bavail * space.bsize,
            need: 0,
            largest: 0,
            labels: [],
          };
          previous.need += required;
          previous.largest = Math.max(previous.largest, largest);
          previous.labels.push(d.label);
          volumeNeeds.set(identity.id, previous);
          for (const rel of inventory.directories)
            await fs.mkdir(await safeChild(d.resolvedPath, rel), {
              recursive: true,
            });
        } catch (e: any) {
          d.available = false;
          d.resolvedPath = undefined;
          d.error = `预检失败：${e.message || String(e)}`;
          task.verifyLog.push(`✗ ${d.label} · ${d.error}`);
          this.record(task, "preflight", "error", `${d.label}：${d.error}`);
        }
      }
      for (const [volumeId, volume] of volumeNeeds) {
        const requiredWithPublishReserve = volume.need + volume.largest;
        if (requiredWithPublishReserve > volume.free) {
          for (const d of task.destinations.filter(
            (d) => d.volumeId === volumeId,
          )) {
            d.available = false;
            d.resolvedPath = undefined;
            d.error = `空间不足：需 ${requiredWithPublishReserve} 字节（含发布临时余量）`;
          }
          continue;
        }
        if (volume.labels.length > 1)
          task.volumeWarnings!.push(
            `${volume.labels.join("、")} 位于同一物理卷，不能抵御该磁盘故障`,
          );
      }
      if (!task.destinations.some((d) => d.available !== false))
        throw new Error(
          "所有目的地均未通过预检，请检查磁盘连接、身份和可用空间",
        );
      let lastIdentityCheck = 0;
      for (const file of inventory.files) {
        await this.waitIfPaused(id, signal);
        if (Date.now() - lastIdentityCheck >= 15_000) {
          await this.assertRecordedVolume(
            src,
            task.sourceVolumeUuid,
            task.sourceVolumeId,
            "素材源 ",
          );
          for (const destination of task.destinations.filter(
            (item) => item.available !== false && item.resolvedPath,
          ))
            await this.assertRecordedVolume(
              destination.resolvedPath!,
              destination.volumeUuid,
              destination.volumeId,
              `${destination.label} `,
            );
          lastIdentityCheck = Date.now();
        }
        task.status = "running";
        task.currentFile = file.relativePath;
        this.emitProgress(task);
        const sourceHashes = await hashSource(
            file.absolutePath,
            task.hashAlgorithm,
            signal,
            (count) => sourceHashMeter.add(count),
          ),
          srcHash = sourceHashes.primary;
        const previousRecord = previousRecords.get(file.relativePath);
        if (
          retryTargetIds &&
          previousRecord &&
          previousRecord.srcChecksum !== srcHash
        )
          throw new Error(
            `素材源已变化，不能合并失败目标重试：${file.relativePath}`,
          );
        const record: FileRecord = {
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
          srcChecksum: srcHash,
          ascMhlMd5: sourceHashes.md5,
          destinations: [],
        };
        const targets: CopyTarget[] = [];
        for (const [destinationIndex, d] of task.destinations.entries()) {
          if (retryTargetIds && !retryTargetIds.has(d.id)) {
            const preserved = previousRecord?.destinations[destinationIndex];
            if (!preserved?.verified)
              throw new Error(
                `成功目标记录不完整，无法执行单目标重试：${d.label}`,
              );
            record.destinations.push({ ...preserved });
            continue;
          }
          if (d.available === false || !d.resolvedPath) {
            record.destinations.push({
              path: "",
              checksum: "",
              verified: false,
            });
            continue;
          }
          let finalPath = await safeChild(d.resolvedPath!, file.relativePath);
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          let exists = await fs.lstat(finalPath).then(
            () => true,
            (e) => {
              if (e.code === "ENOENT") return false;
              throw e;
            },
          );
          if (exists) {
            const existingHash = await hashFile(
              finalPath,
              task.hashAlgorithm,
              signal,
            );
            if (existingHash === srcHash) {
              record.destinations.push({
                path: finalPath,
                checksum: "",
                verified: false,
                unchanged: true,
              });
              d.copiedBytes = (d.copiedBytes || 0) + file.size;
              continue;
            }
            if (task.duplicateStrategy !== "suffix") {
              record.destinations.push({
                path: "",
                checksum: "",
                verified: false,
              });
              d.error ||= `${file.relativePath}: 同名文件内容不同，已保留原文件`;
              continue;
            }
            const ext = path.extname(finalPath),
              stem = finalPath.slice(0, finalPath.length - ext.length);
            let n = 1;
            do {
              finalPath = `${stem}_copy_${n++}${ext}`;
              exists = await fs.lstat(finalPath).then(
                () => true,
                (e) => {
                  if (e.code === "ENOENT") return false;
                  throw e;
                },
              );
            } while (exists);
          }
          const tempPath = finalPath + `.kocpy-${id}.partial`;
          const foundTempSize = await fs.stat(tempPath).then(
            (s) => Math.min(s.size, file.size),
            (e) => {
              if (e.code === "ENOENT") return -1;
              throw e;
            },
          );
          let tempSize = Math.max(0, foundTempSize);
          if (
            tempSize &&
            !(await validPrefix(file.absolutePath, tempPath, tempSize))
          ) {
            await fs.truncate(tempPath, 0);
            tempSize = 0;
          }
          if (foundTempSize >= 0 && tempSize === file.size) {
            await this.publish(tempPath, finalPath);
            await preserveFileMetadata(finalPath, file);
            record.destinations.push({
              path: finalPath,
              checksum: "",
              verified: false,
            });
            d.copiedBytes = (d.copiedBytes || 0) + file.size;
            continue;
          }
          record.destinations.push({
            path: finalPath,
            checksum: "",
            verified: false,
          });
          d.copiedBytes = (d.copiedBytes || 0) + tempSize;
          targets.push({
            destination: d,
            finalPath,
            tempPath,
            offset: tempSize,
          });
        }
        await this.fanout(
          task,
          file.absolutePath,
          file.size,
          targets,
          signal,
          meter,
          destinationMeters,
          sourceCopyMeter,
        );
        for (const target of targets)
          if (target.destination.available !== false) {
            await this.publish(target.tempPath, target.finalPath);
            await preserveFileMetadata(target.finalPath, file);
          }
        task.transferredBytes += file.size;
        task.completedFiles++;
        task.copyProgress = Math.min(
          100,
          (task.transferredBytes / Math.max(1, task.totalBytes)) * 100,
        );
        for (const d of task.destinations)
          d.copyProgress = Math.min(
            100,
            ((d.copiedBytes || 0) / Math.max(1, task.totalBytes)) * 100,
          );
        task.fileRecords.push(record);
        const after = await fs.stat(file.absolutePath);
        if (after.size !== file.size || after.mtimeMs !== file.mtimeMs)
          throw new Error(`备份期间素材发生变化：${file.relativePath}`);
        this.emitProgress(task, task.completedFiles === 1);
      }
      const finalInventory = await scan(src, task.includeHidden, signal),
        initialInventory = new Map(
          inventory.files.map((file) => [
            file.relativePath,
            `${file.size}:${file.mtimeMs}`,
          ]),
        ),
        finalInventoryMap = new Map(
          finalInventory.files.map((file) => [
            file.relativePath,
            `${file.size}:${file.mtimeMs}`,
          ]),
        ),
        initialDirectories = new Set(inventory.directories),
        finalDirectories = new Set(finalInventory.directories);
      if (
        initialInventory.size !== finalInventoryMap.size ||
        initialDirectories.size !== finalDirectories.size ||
        [...initialDirectories].some(
          (relativePath) => !finalDirectories.has(relativePath),
        ) ||
        [...initialInventory].some(
          ([relativePath, fingerprint]) =>
            finalInventoryMap.get(relativePath) !== fingerprint,
        )
      )
        throw new Error(
          "备份期间素材源目录发生变化（新增、删除或修改文件），已停止完成判定，请重新扫描并备份",
        );
      await this.assertRecordedVolume(
        src,
        task.sourceVolumeUuid,
        task.sourceVolumeId,
        "素材源 ",
      );
      for (const destination of task.destinations.filter(
        (item) => item.available !== false && item.resolvedPath,
      ))
        await this.assertRecordedVolume(
          destination.resolvedPath!,
          destination.volumeUuid,
          destination.volumeId,
          `${destination.label} `,
        );
      for (const destination of task.destinations.filter(
        (item) => item.available !== false && item.resolvedPath,
      ))
        for (const directory of [...inventory.directoryMetadata].sort(
          (left, right) =>
            right.relativePath.length - left.relativePath.length,
        )) {
          const target = await safeChild(
            destination.resolvedPath!,
            directory.relativePath,
          );
          await fs.chmod(target, directory.mode).catch(() => undefined);
          await fs
            .utimes(
              target,
              new Date(directory.atimeMs),
              new Date(directory.mtimeMs),
            )
            .catch(() => undefined);
          await syncDirectory(target);
        }
      clearInterval(telemetry);
      task.speedBps = 0;
      task.aggregateSpeedBps = 0;
      task.eta = 0;
      task.sourceHashPerformance = summarizeSpeeds(
        (task.sourceHashHistory || []).map((point) => point.speed),
      );
      task.sourceCopyReadPerformance = summarizeSpeeds(
        (task.sourceCopyReadHistory || []).map((point) => point.speed),
      );
      for (const d of task.destinations) {
        d.speedBps = 0;
        if (!retryTargetIds || retryTargetIds.has(d.id))
          d.performance = summarizeSpeeds(d.copySpeedSamples || []);
      }
      await this.verifyRecords(task, signal, retryTargetIds);
      signal.throwIfAborted();
      if (task.destinations.some((d) => !d.verified))
        throw new Error(
          "部分目的地未通过校验。成功的副本已保留，可单独重试失败目标。",
        );
      task.status = "completed";
      task.lastVerifiedAt = Date.now();
      task.completedAt = Date.now();
      task.currentFile = "";
      this.record(
        task,
        "completed",
        "info",
        "所有可用目的地均已完成独立回读校验",
      );
      for (const destination of task.destinations)
        if (!retryTargetIds || retryTargetIds.has(destination.id))
          destination.verifyPerformance = summarizeSpeeds(
            destination.verifySpeedSamples || [],
          );
      const averageCopySpeed = (destination: Destination) =>
        destination.performance?.average || Number.POSITIVE_INFINITY;
      const slowest = [...task.destinations]
        .filter((d) => Number.isFinite(averageCopySpeed(d)))
        .sort((a, b) => averageCopySpeed(a) - averageCopySpeed(b))[0];
      task.performanceSummary = slowest
        ? `${slowest.label} 是本次传输的主要速度瓶颈`
        : "任务已完成，未检测到持续速度瓶颈";
      task.speedBps = 0;
      task.aggregateSpeedBps = 0;
      task.verifySpeedBps = 0;
      task.eta = 0;
      task.verifyEta = 0;
      this.emitProgress(task, true);
      this.emit("settled", task);
      completionNotified = true;
      void this.generateTaskThumbnails(task, new AbortController().signal)
        .then(() => {
          this.emitProgress(task, true);
          this.emit("metadata", task);
        })
        .catch(() => {});
    } catch (e: any) {
      task.status = signal.aborted ? "cancelled" : "failed";
      task.errorMessage = e.message || String(e);
      this.record(task, task.status, "error", task.errorMessage || "任务失败");
    } finally {
      clearInterval(telemetry);
      this.retryTargets.delete(id);
      this.paused.delete(id);
      this.active.delete(id);
      task.completedAt ||= Date.now();
      task.speedBps = 0;
      task.aggregateSpeedBps = 0;
      task.verifySpeedBps = 0;
      task.eta = 0;
      task.verifyEta = 0;
      task.currentFile = "";
      for (const d of task.destinations) {
        d.speedBps = 0;
        d.verifySpeedBps = 0;
      }
      if (!completionNotified) {
        this.emitProgress(task, true);
        this.emit("settled", task);
      }
    }
  }
}
