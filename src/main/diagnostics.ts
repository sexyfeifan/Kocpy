import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { BackupTask } from "./types";

export interface BenchmarkResult {
  path: string;
  bytes: number;
  writeBps: number;
  readBps: number;
  durationMs: number;
  completedAt: number;
}

const mib = 1024 * 1024;
export async function benchmarkDirectory(directory: string, sizeMiB = 64): Promise<BenchmarkResult> {
  const stat = await fs.stat(directory);
  if (!stat.isDirectory()) throw new Error("性能预检目标必须是文件夹");
  const bytes = Math.max(8, Math.min(256, Math.round(sizeMiB))) * mib;
  const file = path.join(directory, `.kocpy-benchmark-${randomUUID()}.tmp`);
  const chunk = Buffer.allocUnsafe(mib);
  for (let i = 0; i < chunk.length; i += 4096) chunk.writeUInt32LE((i * 2654435761) >>> 0, i);
  const started = performance.now();
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "wx", 0o600);
    const writeStarted = performance.now();
    for (let written = 0; written < bytes; written += chunk.length) await handle.write(chunk, 0, Math.min(chunk.length, bytes - written), written);
    await handle.sync();
    const writeMs = Math.max(1, performance.now() - writeStarted);
    await handle.close(); handle = undefined;
    handle = await fs.open(file, "r");
    const readBuffer = Buffer.allocUnsafe(mib);
    const readStarted = performance.now();
    let read = 0;
    while (read < bytes) { const result = await handle.read(readBuffer, 0, Math.min(readBuffer.length, bytes - read), read); if (!result.bytesRead) break; read += result.bytesRead; }
    const readMs = Math.max(1, performance.now() - readStarted);
    return { path: directory, bytes, writeBps: bytes / (writeMs / 1000), readBps: read / (readMs / 1000), durationMs: Math.round(performance.now() - started), completedAt: Date.now() };
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(file).catch(() => {});
  }
}

const basename = (value?: string) => value ? path.basename(value) || "卷根目录" : undefined;
const anonymousId = (value?: string) => value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : undefined;
export function recoveryDiagnosis(task: BackupTask) {
  const unavailable = task.destinations.filter((destination) => destination.available === false);
  const failed = task.destinations.filter((destination) => Boolean(destination.error));
  const unverified = task.destinations.filter((destination) => !destination.verified);
  if (task.status === "paused") return { code: "paused", severity: "warning", action: "resume", summary: "可从当前检查点继续" };
  if (/素材源|source/i.test(task.errorMessage || "")) return { code: "source-unavailable", severity: "error", action: "reconnect-source", summary: "素材源未连接或身份发生变化" };
  if (unavailable.length) return { code: "destination-offline", severity: "error", action: "retry-failed", summary: `${unavailable.length} 个目的地未连接` };
  if (failed.length) return { code: "destination-failed", severity: "error", action: "retry-failed", summary: `${failed.length} 个目的地写入或校验失败` };
  if (task.transferredBytes > 0 && task.transferredBytes < task.totalBytes) return { code: "partial", severity: "warning", action: "resume-scan", summary: "存在可验证并继续使用的断点" };
  if (unverified.length && task.fileRecords.length) return { code: "unverified", severity: "warning", action: "reverify", summary: `${unverified.length} 个副本尚未通过校验` };
  if (task.status === "pending") return { code: "pending", severity: "info", action: "start", summary: "任务尚未开始写入" };
  return { code: task.status, severity: task.status === "completed" ? "ok" : "warning", action: "inspect", summary: task.errorMessage || "需要检查任务记录" };
}

export function buildDiagnosticSnapshot(input: { version: string; tasks: BackupTask[]; volumes: any[]; benchmarks: BenchmarkResult[] }) {
  const tasks = input.tasks.slice(-100).map((task) => ({
    id: task.id.slice(0, 12), name: task.name, status: task.status, createdAt: task.createdAt, startedAt: task.startedAt, completedAt: task.completedAt,
    source: basename(task.sourcePath), sourceVolume: task.sourceVolumeName, sourceVolumeId: anonymousId(task.sourceVolumeUuid || task.sourceVolumeId),
    totals: { files: task.totalFiles, bytes: task.totalBytes, copied: task.transferredBytes, verified: task.verifiedBytes || 0 },
    destinations: task.destinations.map((destination) => ({ label: destination.label, volume: destination.volumeName, volumeId: anonymousId(destination.volumeUuid || destination.volumeId), verified: destination.verified, available: destination.available, error: destination.error, performance: destination.performance, verifyPerformance: destination.verifyPerformance })),
    diagnosis: recoveryDiagnosis(task), performanceSummary: task.performanceSummary, error: task.errorMessage, timeline: (task.faultTimeline || []).slice(-30),
  }));
  return {
    schema: 1, generatedAt: new Date().toISOString(), app: { name: "Kocpy", version: input.version },
    system: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
    volumes: input.volumes.map((volume) => ({ name: volume.name, type: volume.deviceType, filesystem: volume.protocol || volume.type, total: volume.total, free: volume.free, writable: volume.writable, network: volume.isNetwork, latencyMs: volume.latencyMs, volumeId: anonymousId(volume.identity?.uuid || volume.identity?.id) })),
    benchmarks: input.benchmarks.slice(-20).map((result) => ({ ...result, path: basename(result.path) })), tasks,
    privacy: "不包含素材内容、完整文件路径、用户账号或文件清单。",
  };
}
