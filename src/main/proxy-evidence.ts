import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { hashFile } from "./backup/BackupEngine";
import { validateProxyAdvanced, proxyExpectedMedia } from "./proxy-advanced";
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
  return a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)
    ? "unknown"
    : Math.abs(a - b) <= tolerance
      ? "match"
      : "changed";
}

/** Recomputed from evidence, never trust a persisted UI readiness flag. */
export function proxyDeliveryFingerprint(job: ProxyJob) {
  return createHash("sha256").update(JSON.stringify([
    1, job.id, job.input, job.outputPath, job.sourceEvidence,
    job.parameterSnapshot, job.outputEvidence,
  ])).digest("hex");
}

export function checkProxyDelivery(job: ProxyJob): NonNullable<ProxyJob["deliveryCheck"]> {
  const blockers: string[] = [], warnings: string[] = [];
  if (job.status !== "completed" || !job.outputPath) blockers.push("代理尚未完成");
  const source = job.sourceEvidence?.media, output = job.outputEvidence;
  if (!source || !job.parameterSnapshot) blockers.push("缺少源证据或参数快照，请重新生成");
  const sourceEvidence = job.sourceEvidence;
  const hashLengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, xxhash32: 8 };
  if (sourceEvidence && (sourceEvidence.path !== job.input || !Number.isFinite(sourceEvidence.bytes) || sourceEvidence.bytes <= 0 ||
    !hashLengths[sourceEvidence.hashAlgorithm] || !new RegExp(`^[a-f0-9]{${hashLengths[sourceEvidence.hashAlgorithm] || 1}}$`, "i").test(sourceEvidence.checksum || "")))
    blockers.push("源路径或哈希证据无效，请重新生成");
  if (job.parameterSnapshot) {
    try { validateProxyParameters(job.parameterSnapshot); }
    catch { blockers.push("参数快照无效，请重新生成"); }
  }
  if (!output || !/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isFinite(output.bytes) || output.bytes <= 0)
    blockers.push("缺少有效输出哈希证据，请重新生成");
  if (output) {
    if (!(Number(output.frameRate) > 0) || !Number.isFinite(Number(output.frameRate)))
      blockers.push("缺少有效输出帧率");
    if (!(durationSeconds(output.duration)! > 0)) blockers.push("缺少有效输出时长");
    if (!/^[1-9]\d*x[1-9]\d*$/i.test(output.resolution || "")) blockers.push("缺少有效输出分辨率");
  }
  if (source && output) {
    const validation = compareProxyMedia(source, output, job.parameterSnapshot);
    const expected = job.parameterSnapshot ? proxyExpectedMedia(source, job.parameterSnapshot) : source;
    if (validation.audio === "missing") blockers.push("源音轨在代理中缺失");
    if (validation.duration === "changed") blockers.push("代理时长与源素材不符");
    if (validation.frameRate === "changed") blockers.push("代理帧率与源素材不符");
    const editorial = job.parameterSnapshot?.purpose === "editorial";
    if (job.parameterSnapshot?.resolution.includes("x") && output.resolution !== job.parameterSnapshot.resolution) blockers.push("代理尺寸与冻结参数不符");
    if (editorial && expected.timecode && expected.timecode !== output.timecode)
      blockers.push("剪辑代理时间码丢失或变化");
    if (editorial && validation.audioTracks === "changed") blockers.push("剪辑代理音轨数量变化");
    warnings.push(...validation.notes);
  }
  const approval = job.deliveryApproval;
  const approved = blockers.length === 0 && warnings.length > 0 &&
    approval?.policyVersion === 1 && approval.fingerprint === proxyDeliveryFingerprint(job) &&
    typeof approval.reason === "string" && Boolean(approval.reason.trim()) &&
    typeof approval.operator === "string" && Boolean(approval.operator.trim()) &&
    Number.isFinite(approval.approvedAt) && approval.approvedAt > 0 &&
    JSON.stringify(approval.warnings) === JSON.stringify(warnings);
  return { state: blockers.length ? "blocked" : warnings.length ? "warning" : "ready", blockers, warnings, approved: Boolean(approved) };
}

export function approveProxyDelivery(job: ProxyJob, reason: string, operator: string) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 2000)
    throw new Error("请填写例外交付原因（最多 2000 字）");
  if (typeof operator !== "string" || !operator.trim() || operator.length > 200)
    throw new Error("请填写有效操作人");
  const check = checkProxyDelivery(job);
  if (check.state === "blocked") throw new Error(`代理禁止交付：${check.blockers.join("；")}`);
  if (check.state !== "warning") throw new Error("该代理无需例外确认");
  job.deliveryApproval = { policyVersion: 1, fingerprint: proxyDeliveryFingerprint(job),
    operator: operator.trim(), reason: reason.trim(), approvedAt: Date.now(), warnings: check.warnings };
  job.deliveryCheck = checkProxyDelivery(job);
  return job.deliveryApproval;
}

export function requireProxyDelivery(job: ProxyJob) {
  const check = checkProxyDelivery(job);
  job.deliveryCheck = check;
  if (check.state === "blocked") throw new Error(`${job.name} 禁止交付：${check.blockers.join("；")}`);
  if (check.state === "warning" && !check.approved)
    throw new Error(`${job.name} 需要例外确认：${check.warnings.join("；")}`);
  return check;
}

export function validateProxyParameters(value: ProxyParameterSnapshot) {
  validateProxyAdvanced(value);
  if (!["review", "editorial", "offline"].includes(value.purpose)) throw new Error("无效代理用途");
  if (!["h264", "prores"].includes(value.format))
    throw new Error("不支持的代理编码");
  if (!/^(?:\d{3,4}p|\d{3,5}x\d{3,5})$/i.test(value.resolution))
    throw new Error("分辨率格式无效");
  if (!["mp4", "mov", "mkv"].includes(value.container))
    throw new Error("不支持的代理封装");
  const dimensions = value.resolution.includes("x") ? value.resolution.split("x").map(Number) : [Number(value.resolution.slice(0, -1))];
  if (dimensions.some(number => number < 100 || number > 8192 || number % 2)) throw new Error("输出尺寸须为 100–8192 的偶数");
  if (value.format === "prores" && value.container !== "mov")
    throw new Error("ProRes Proxy 仅允许 MOV 封装");
  if (typeof value.namingTemplate !== "string" || !value.namingTemplate.includes("{name}"))
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
  parameters?: ProxyParameterSnapshot,
): NonNullable<ProxyJob["validation"]> {
  if (parameters) source = proxyExpectedMedia(source, parameters);
  const notes: string[] = [];
  const frameRate = sameNumber(
    source.frameRate ? Number(source.frameRate) : undefined,
    output.frameRate ? Number(output.frameRate) : undefined,
    0.02,
  );
  const timecode = parameters?.advanced?.timecodeMode === "drop"
    ? output.timecode ? "changed" : "match"
    : !source.timecode || !output.timecode
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
  const fingerprint = proxyDeliveryFingerprint(job);
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
  if (job.status !== "completed" || fingerprint !== proxyDeliveryFingerprint(job))
    throw new Error(`代理任务或证据在校验期间变化：${job.name}`);
  return evidence;
}
