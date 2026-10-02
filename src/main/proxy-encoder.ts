import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProxyAdvanced } from "./types";
const exec = promisify(execFile);
const probes = new Map<string, Promise<boolean>>();
export function probeVideoToolbox(binary: string) {
  if (!probes.has(binary)) probes.set(binary, exec(binary, ["-nostdin", "-hide_banner", "-f", "lavfi", "-i", "color=size=128x128:rate=25", "-frames:v", "2", "-c:v", "h264_videotoolbox", "-allow_sw", "0", "-f", "null", "-"], { timeout: 10000, maxBuffer: 1024 * 1024 }).then(() => true, () => false));
  return probes.get(binary)!;
}
export async function selectProxyEncoder(format: "h264" | "prores", advanced: ProxyAdvanced | undefined, probe: () => Promise<boolean>) {
  if (format === "prores") return { encoder: "prores_ks" };
  if (!advanced || advanced.encoder === "software" || !advanced.encoder) return { encoder: "libx264" };
  if (await probe()) return { encoder: "h264_videotoolbox" };
  if (advanced.encoder === "hardware") throw new Error("VideoToolbox 硬件编码当前不可用；请选择自动或软件模式");
  return { encoder: "libx264", fallbackReason: "VideoToolbox 探测失败，使用软件编码" };
}
export function shouldFallbackProxyHardware(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/No space left|Permission denied|Input\/output error|Invalid data found|Operation not permitted/i.test(message)) return false;
  return /cannot create compression session|VTCompressionSessionCreate.*(?:fail|error)|Try -allow_sw|Error while opening encoder|hardware encoder.*(?:unavailable|fail|not supported)/i.test(message);
}
