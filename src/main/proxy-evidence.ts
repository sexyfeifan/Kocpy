import { promises as fs } from "node:fs";
import { hashFile } from "./backup/BackupEngine";
import type {
  ProxyJob,
  ProxyMediaSnapshot,
  ProxyOutputEvidence,
  ProxyParameterSnapshot,
} from "./types";

function durationSeconds(value?: string) {
  if (!value) return undefined;
  const parts = value.split(":").map(Number);
  const result =
    parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function sameNumber(a?: number, b?: number, tolerance = 0.01) {
  return a === undefined || b === undefined
    ? "unknown"
    : Math.abs(a - b) <= tolerance
      ? "match"
      : "changed";
}

export function validateProxyParameters(value: ProxyParameterSnapshot) {
  if (!["h264", "prores"].includes(value.format))
    throw new Error("不支持的代理编码");
  if (!/^(?:\d{3,4}p|\d{3,5}x\d{3,5})$/i.test(value.resolution))
    throw new Error("分辨率格式无效");
  if (!["mp4", "mov", "mkv"].includes(value.container))
    throw new Error("不支持的代理封装");
  if (value.format === "prores" && value.container !== "mov")
    throw new Error("ProRes Proxy 仅允许 MOV 封装");
  if (!value.namingTemplate.includes("{name}"))
    throw new Error("命名规则必须包含 {name}");
  if (
    value.bitrateMbps !== undefined &&
    (!Number.isFinite(value.bitrateMbps) ||
      value.bitrateMbps <= 0 ||
      value.bitrateMbps > 500)
  )
    throw new Error("视频码率必须大于 0 且不超过 500 Mbps");
  return value;
}

export async function verifyProxySource(job: ProxyJob, signal?: AbortSignal) {
  const evidence = job.sourceEvidence;
  if (!evidence)
    throw new Error("旧代理任务缺少已校验源证据，请从素材库重新加入队列");
  if (evidence.path !== job.input)
    throw new Error("代理源路径已改变，请从素材库重新加入队列");
  const stat = await fs.stat(job.input).catch(() => undefined);
  if (!stat?.isFile()) throw new Error("代理源文件已离线或不存在");
  if (stat.size !== evidence.bytes)
    throw new Error("代理源文件大小已变化，请先重新校验素材副本");
  const checksum = await hashFile(job.input, evidence.hashAlgorithm, signal);
  if (checksum !== evidence.checksum)
    throw new Error("代理源文件内容已变化，请先重新校验素材副本");
  return { bytes: stat.size, checksum };
}

export async function captureProxyOutput(
  outputPath: string,
  media: ProxyMediaSnapshot,
  signal?: AbortSignal,
): Promise<ProxyOutputEvidence> {
  const stat = await fs.stat(outputPath);
  if (!stat.isFile()) throw new Error("代理输出文件不存在");
  return {
    path: outputPath,
    bytes: stat.size,
    sha256: await hashFile(outputPath, "sha256", signal),
    checkedAt: Date.now(),
    ...media,
  };
}

export function compareProxyMedia(
  source: ProxyMediaSnapshot,
  output: ProxyMediaSnapshot,
): NonNullable<ProxyJob["validation"]> {
  const notes: string[] = [];
  const frameRate = sameNumber(
    source.frameRate ? Number(source.frameRate) : undefined,
    output.frameRate ? Number(output.frameRate) : undefined,
    0.02,
  );
  const timecode =
    !source.timecode || !output.timecode
      ? "unknown"
      : source.timecode === output.timecode
        ? "match"
        : "changed";
  const duration = sameNumber(
    durationSeconds(source.duration),
    durationSeconds(output.duration),
    0.25,
  );
  const sourceTracks = source.audioTracks;
  const outputTracks = output.audioTracks;
  const audio =
    sourceTracks === undefined
      ? "unknown"
      : sourceTracks === 0
        ? "none"
        : outputTracks && outputTracks > 0
          ? "present"
          : "missing";
  const audioTracks = sameNumber(sourceTracks, outputTracks, 0);
  const rotation = sameNumber(source.rotation, output.rotation, 0.1);
  const colorSpace =
    !source.colorSpace || !output.colorSpace
      ? "unknown"
      : source.colorSpace.toLowerCase() === output.colorSpace.toLowerCase()
        ? "match"
        : "changed";
  if (frameRate === "changed")
    notes.push(`帧率由 ${source.frameRate} 变为 ${output.frameRate}`);
  if (timecode === "changed") notes.push("输出时间码与源素材不同");
  if (duration === "changed")
    notes.push(`时长由 ${source.duration} 变为 ${output.duration}`);
  if (audio === "missing") notes.push("源素材包含音轨，但代理未检测到音轨");
  else if (audioTracks === "changed")
    notes.push(`音轨数量由 ${sourceTracks} 变为 ${outputTracks}`);
  if (rotation === "changed")
    notes.push(`旋转元数据由 ${source.rotation}° 变为 ${output.rotation}°`);
  if (colorSpace === "changed")
    notes.push(`色彩空间由 ${source.colorSpace} 变为 ${output.colorSpace}`);
  const unknown = [
    [frameRate, "帧率"],
    [timecode, "时间码"],
    [duration, "时长"],
    [audioTracks, "音轨数量"],
    [rotation, "旋转元数据"],
    [colorSpace, "色彩空间"],
  ].filter(([state]) => state === "unknown");
  if (unknown.length)
    notes.push(`未取得：${unknown.map(([, label]) => label).join("、")}`);
  return {
    frameRate,
    timecode,
    audio,
    duration,
    audioTracks,
    rotation,
    colorSpace,
    readiness: notes.length ? "warning" : "ready",
    checkedAt: Date.now(),
    notes,
  };
}

export async function verifyProxyOutput(job: ProxyJob) {
  if (job.status !== "completed" || !job.outputPath)
    throw new Error(`代理任务 ${job.name} 尚未完成`);
  const evidence = job.outputEvidence;
  if (!evidence)
    throw new Error(`代理任务 ${job.name} 缺少输出哈希证据，请重新生成`);
  if (evidence.path !== job.outputPath)
    throw new Error(`代理任务 ${job.name} 的输出路径已变化`);
  const stat = await fs.stat(job.outputPath).catch(() => undefined);
  if (!stat?.isFile()) throw new Error(`代理输出已离线：${job.name}`);
  if (stat.size !== evidence.bytes)
    throw new Error(`代理输出大小已变化：${job.name}`);
  const checksum = await hashFile(job.outputPath, "sha256");
  if (checksum !== evidence.sha256)
    throw new Error(`代理输出内容已变化：${job.name}`);
  return evidence;
}
