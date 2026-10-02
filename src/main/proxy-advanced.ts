import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProxyAdvanced, ProxyMediaSnapshot, ProxyParameterSnapshot } from "./types";
const rates = ["source", "24000/1001", "24", "25", "30000/1001", "30", "50", "60000/1001", "60"];
export const proxyFrameRate = (value?: string) => value?.includes("/") ? Number(value.split("/")[0]) / Number(value.split("/")[1]) : Number(value);
export function validateProxyAdvanced(parameters: ProxyParameterSnapshot) {
  const value = parameters.advanced;
  if (!value) return;
  for (const [key, allowed] of Object.entries({ encoder: ["software", "auto", "hardware"], frameRate: rates, audioMode: ["all", "first", "none"],
    audioCodec: ["auto", "aac", "pcm_s16le"], audioSampleRate: [44100, 48000], audioChannels: [1, 2], timecodeMode: ["keep", "custom", "drop"],
    colorMode: ["keep", "bt709"], rotation: ["auto", "metadata", "90", "-90", "180"], aspect: ["fit", "stretch", "crop"], speed: ["fast", "medium", "slow"],
    h264Profile: ["baseline", "main", "high"], proresProfile: [0, 1, 2, 3] })) {
    const choice = value[key as keyof ProxyAdvanced];
    if (choice !== undefined && !(allowed as unknown[]).includes(choice)) throw new Error(`无效高级代理参数：${key}`);
  }
  if (value.crf !== undefined && (!Number.isInteger(value.crf) || value.crf < 0 || value.crf > 51 || value.encoder !== "software")) throw new Error("CRF 0–51 仅适用于软件 H.264");
  if (value.gop !== undefined && (!Number.isInteger(value.gop) || value.gop < 1 || value.gop > 300)) throw new Error("GOP 必须为 1–300");
  if (parameters.format === "prores" && value.encoder === "hardware") throw new Error("本流程的 ProRes 使用软件编码");
  if (parameters.format === "prores" && (value.crf !== undefined || value.speed !== undefined || value.h264Profile !== undefined || value.gop !== undefined)) throw new Error("ProRes 不能使用 H.264 专用参数");
  if (parameters.container === "mp4" && value.audioCodec === "pcm_s16le") throw new Error("PCM 音频请选择 MOV 或 MKV");
  if (parameters.purpose === "editorial" && (value.timecodeMode === "drop" || value.audioMode === "none")) throw new Error("剪辑代理不能丢弃时间码或全部音轨");
  if (value.timecodeMode === "custom" && !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d[:;][0-5]\d$/.test(value.timecode || "")) throw new Error("时间码格式应为 HH:MM:SS:FF");
  if (value.timecodeMode === "custom" && parameters.container === "mkv") throw new Error("自定义时间码请选择 MOV 或 MP4");
  if (value.lutPath && (!value.lutEvidence || !/^[a-f0-9]{64}$/.test(value.lutEvidence.sha256) || value.lutEvidence.bytes <= 0 || value.lutEvidence.bytes > 16 * 1024 ** 2)) throw new Error("LUT 缺少有效冻结哈希证据");
}
function validateCube(buffer: Buffer) {
  const text = buffer.toString("utf8"), match = /^\s*LUT_3D_SIZE\s+(\d+)\s*$/m.exec(text);
  const dimension = Number(match?.[1]);
  if (!Number.isInteger(dimension) || dimension < 2 || dimension > 65) throw new Error("请选择 2–65 点的 3D .cube LUT");
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#") && !/^(TITLE|DOMAIN_MIN|DOMAIN_MAX|LUT_3D_SIZE)\b/.test(line));
  if (rows.length !== dimension ** 3 || rows.some(line => { const numbers = line.split(/\s+/).map(Number); return numbers.length !== 3 || numbers.some(number => !Number.isFinite(number)); })) throw new Error("LUT 表格不完整或包含无效数值");
}
export async function readFrozenProxyLut(value: ProxyAdvanced) {
  if (!value.lutPath) return undefined;
  const handle = await fs.open(value.lutPath, "r");
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024 ** 2) throw new Error("LUT 必须为不超过 16 MiB 的文件");
    buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) throw new Error("LUT 在读取期间改变");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("LUT 在读取期间改变");
  } finally { await handle.close(); }
  validateCube(buffer);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (value.lutEvidence && (sha256 !== value.lutEvidence.sha256 || buffer.length !== value.lutEvidence.bytes)) throw new Error("LUT 内容已改变，请重新选择并预检");
  return { buffer, evidence: { sha256, bytes: buffer.length } };
}
export async function freezeProxyAdvanced(value?: ProxyAdvanced): Promise<ProxyAdvanced> {
  const result: ProxyAdvanced = { encoder: "software", frameRate: "source", audioMode: "all", timecodeMode: "keep", colorMode: "keep", rotation: "auto", aspect: "fit", ...value };
  if (result.lutPath) {
    if (!/\.cube$/i.test(result.lutPath)) throw new Error("仅支持 3D .cube LUT");
    result.lutPath = await fs.realpath(path.resolve(result.lutPath));
    result.lutEvidence = (await readFrozenProxyLut(result))!.evidence;
  } else result.lutEvidence = undefined;
  return result;
}
export function proxyExpectedMedia(source: ProxyMediaSnapshot, parameters: ProxyParameterSnapshot): ProxyMediaSnapshot {
  const advanced = parameters.advanced;
  if (!advanced) return source;
  return { ...source,
    frameRate: advanced.frameRate && advanced.frameRate !== "source" ? String(proxyFrameRate(advanced.frameRate)) : source.frameRate,
    audioTracks: advanced.audioMode === "none" ? 0 : advanced.audioMode === "first" && source.audioTracks !== undefined ? Math.min(1, source.audioTracks) : source.audioTracks,
    timecode: advanced.timecodeMode === "custom" ? advanced.timecode : advanced.timecodeMode === "drop" ? undefined : source.timecode,
    colorSpace: advanced.colorMode === "bt709" ? "bt709" : source.colorSpace,
    rotation: advanced.rotation === "metadata" ? source.rotation : 0,
  };
}
export function buildProxyFilters(resolution: string, advanced?: ProxyAdvanced, hasLut = false) {
  const filters: string[] = [];
  if (advanced?.rotation === "90") filters.push("transpose=clock");
  if (advanced?.rotation === "-90") filters.push("transpose=cclock");
  if (advanced?.rotation === "180") filters.push("hflip", "vflip");
  if (resolution.includes("x")) {
    const [width, height] = resolution.split("x").map(Number);
    if (advanced?.aspect === "fit") filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
    else if (advanced?.aspect === "crop") filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2`, `crop=${width}:${height}`);
    else filters.push(`scale=${width}:${height}`);
  } else filters.push(`scale=-2:'min(${Number(resolution.slice(0, -1))},ih)'`);
  if (advanced?.frameRate && advanced.frameRate !== "source") filters.push(`fps=${advanced.frameRate}`);
  if (advanced?.colorMode === "bt709") filters.push("colorspace=all=bt709");
  if (hasLut) filters.push("lut3d=file=look.cube:interp=tetrahedral");
  return filters.join(",");
}
