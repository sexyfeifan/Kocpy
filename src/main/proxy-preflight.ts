import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { canonical, inside } from "./backup/safety";
import { existingProxyOutputAncestor } from "./proxy-resources";
import { validateProxyParameters } from "./proxy-evidence";
import type { ProxyMediaSnapshot, ProxyParameterSnapshot } from "./types";

export interface ProxyPreflight {
  outputDir: string;
  destinationDevice: number;
  estimatedBytes: number;
  requiredBytes: number;
  availableBytes: number;
  checkedAt: number;
  warnings: string[];
}
export function estimateProxyBytes(media: ProxyMediaSnapshot, parameters: ProxyParameterSnapshot) {
  const parts = (media.duration || "").split(":").map(Number);
  const duration = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : Number(media.duration);
  const frameRate = Number(media.frameRate);
  const dimensions = /^(\d+)x(\d+)$/i.exec(media.resolution || "");
  if (!(duration > 0) || !Number.isFinite(duration) || !(frameRate > 0) || !Number.isFinite(frameRate) || !dimensions)
    throw new Error("缺少有效视频时长、帧率或尺寸；请检查素材兼容性");
  const sourceW = Number(dimensions[1]), sourceH = Number(dimensions[2]);
  if (!(sourceW > 0 && sourceH > 0)) throw new Error("无效源视频尺寸");
  const target = parameters.resolution.includes("x") ? parameters.resolution.split("x").map(Number) :
    [sourceW * Math.min(1, Number(parameters.resolution.slice(0, -1)) / sourceH), Math.min(sourceH, Number(parameters.resolution.slice(0, -1)))];
  const factor = target[0] * target[1] / (1920 * 1080) * frameRate / 25;
  const mbps = parameters.bitrateMbps || (parameters.format === "prores" ? 50 : 16) * Math.max(0.25, factor);
  const bytes = Math.ceil(duration * (mbps + Math.max(1, media.audioTracks || 0) * 2) * 1_000_000 / 8 * 1.25);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("代理大小超出可估算范围");
  return bytes;
}
/** Advisory estimate with a hard current-space gate, never a capacity guarantee. */
export async function preflightProxyGeneration(
  outputDir: string,
  clips: { media: ProxyMediaSnapshot; parameters: ProxyParameterSnapshot }[],
  protectedRoots: string[],
  reservedBytes = 0,
  expectedDevice?: number,
): Promise<ProxyPreflight> {
  if (!outputDir.trim() || !clips.length) throw new Error("请选择输出目录和视频素材");
  const resolved = await canonical(outputDir);
  for (const root of protectedRoots)
    if (inside(resolved, await canonical(root))) throw new Error("代理输出不能位于素材源或已校验备份目录内");
  const ancestor = await existingProxyOutputAncestor(resolved);
  const stat = await fs.stat(ancestor);
  if (!stat.isDirectory()) throw new Error("代理输出路径被文件占用");
  if (expectedDevice !== undefined && stat.dev !== expectedDevice) throw new Error("代理输出文件系统已改变，请重新入队");
  await fs.access(ancestor, constants.W_OK);
  const estimatedBytes = clips.reduce((sum, clip) => sum + estimateProxyBytes(clip.media, validateProxyParameters(clip.parameters)), 0);
  // Exclusive-copy fallback can briefly need a second output-sized allocation.
  const requiredBytes = Math.ceil(2 * (estimatedBytes + reservedBytes) + 64 * 1024 ** 2);
  const space = await fs.statfs(ancestor);
  const availableBytes = space.bavail * space.bsize;
  if (!Number.isSafeInteger(requiredBytes) || availableBytes < requiredBytes) throw new Error(`代理空间不足：保守预留需 ${requiredBytes} 字节，可用 ${availableBytes} 字节`);
  return { outputDir: resolved, destinationDevice: stat.dev, estimatedBytes, requiredBytes, availableBytes,
    checkedAt: Date.now(), warnings: ["大小为保守估算，转码期间空间仍可能变化；未知编码支持需以实际转码结果为准。"] };
}
