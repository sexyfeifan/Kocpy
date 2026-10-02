import { ffmpegPath } from "./ffmpeg";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildProxyFilters, readFrozenProxyLut } from "./proxy-advanced";
import { selectProxyEncoder, probeVideoToolbox, shouldFallbackProxyHardware } from "./proxy-encoder";
import { validateProxyParameters } from "./proxy-evidence";
import type { ProxyAdvanced, ProxyPreset } from "./types";
const exec = promisify(execFile);
async function durationSeconds(binary: string, input: string) {
  try { await exec(binary, ["-nostdin", "-i", input], { maxBuffer: 4 * 1024 * 1024 }); return 0; }
  catch (e: any) {
    const m = String(e.stderr || "").match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  }
}
interface ProxyOptions {
  advanced?: ProxyAdvanced;
  purpose?: ProxyPreset;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  namingTemplate?: string;
  bitrateMbps?: number;
  container?: "mp4" | "mov" | "mkv";
}
export async function makeProxy(input: string, outputDir: string, format: "h264" | "prores", resolution: string, options: ProxyOptions = {}) {
  input = path.resolve(input); outputDir = path.resolve(outputDir);
  options.signal?.throwIfAborted();
  if (!["h264", "prores"].includes(format) || !/^(?:\d{3,4}p|\d{3,5}x\d{3,5})$/.test(resolution))
    throw new Error("无效代理参数");
  const st = await fs.stat(input);
  if (!st.isFile()) throw new Error("请选择视频文件");
  const name = path.basename(input, path.extname(input));
  const safeTemplate = (options.namingTemplate || "{name}_proxy_{resolution}")
    .replaceAll("{name}", name).replaceAll("{resolution}", resolution).replaceAll("{format}", format)
    .replace(/[/\\:\0]/g, "_").trim() || `${name}_proxy_${resolution}`;
  const container = options.container || (format === "prores" ? "mov" : "mp4");
  validateProxyParameters({ purpose: options.purpose || "review", format, resolution, container, namingTemplate: options.namingTemplate || "{name}_proxy_{resolution}", bitrateMbps: options.bitrateMbps, advanced: options.advanced });
  if (
    !["mp4", "mov", "mkv"].includes(container) ||
    (format === "prores" && container !== "mov")
  )
    throw new Error("所选编码与封装不兼容");
  const output = path.join(outputDir, `${safeTemplate}_${randomUUID().slice(0, 6)}.${container}`);
  const advanced = options.advanced;
  const lut = advanced?.lutPath ? await readFrozenProxyLut(advanced) : undefined;
  const filter = buildProxyFilters(resolution, advanced, Boolean(lut));
  const binary = ffmpegPath(), duration = await durationSeconds(binary, input);
  const selection = await selectProxyEncoder(format, advanced, () => probeVideoToolbox(binary));
  const bitrate = options.bitrateMbps && options.bitrateMbps > 0 ? ["-b:v", `${Math.min(500, options.bitrateMbps)}M`] : [];
  options.signal?.throwIfAborted();
  await fs.mkdir(outputDir, { recursive: true });
  // Own the staging directory, not just a probabilistically unique filename.
  // A collision must never cause cleanup to remove another job's output.
  const staging = await fs.mkdtemp(path.join(outputDir, ".kocpy-proxy-"));
  const partial = path.join(staging, `output.partial.${container}`);
  try {
    options.signal?.throwIfAborted();
    if (lut) await fs.writeFile(path.join(staging, "look.cube"), lut.buffer, { flag: "wx", mode: 0o600 });
    const encode = (encoder: string) => new Promise<void>((resolve, reject) => {
      const audioCodec = advanced?.audioCodec && advanced.audioCodec !== "auto" ? advanced.audioCodec : format === "prores" ? "pcm_s16le" : "aac";
      const args = [
        "-nostdin", "-n", ...(advanced?.rotation && advanced.rotation !== "auto" ? ["-noautorotate", ...(advanced.rotation !== "metadata" ? ["-display_rotation", "0"] : [])] : []),
        "-i", input, "-map", "0:v:0", ...(advanced?.audioMode === "none" ? ["-an"] : ["-map", advanced?.audioMode === "first" ? "0:a:0?" : "0:a?"]), "-vf", filter,
        "-c:v", encoder,
        ...(format === "prores" ? ["-profile:v", String(advanced?.proresProfile ?? 0), "-pix_fmt", "yuv422p10le", ...bitrate] :
          [...(encoder === "h264_videotoolbox" ? ["-allow_sw", "0", ...(bitrate.length ? bitrate : ["-b:v", "8M"])] : ["-preset", advanced?.speed || "fast", ...(bitrate.length ? bitrate : ["-crf", String(advanced?.crf ?? 23)])]), "-pix_fmt", "yuv420p",
            ...(advanced?.h264Profile ? ["-profile:v", advanced.h264Profile] : []), ...(advanced?.gop ? ["-g", String(advanced.gop)] : [])]),
        ...(advanced?.audioMode === "none" ? [] : ["-c:a", audioCodec, ...(advanced?.audioSampleRate ? ["-ar", String(advanced.audioSampleRate)] : []), ...(advanced?.audioChannels ? ["-ac", String(advanced.audioChannels)] : [])]),
        "-map_metadata", "0",
        ...(advanced?.timecodeMode === "drop" ? ["-metadata", "timecode=", "-metadata:s:v", "timecode=", ...(container !== "mkv" ? ["-write_tmcd", "0"] : [])] : advanced?.timecodeMode === "custom" ? ["-timecode", advanced.timecode!] : []),
        ...(container === "mp4" ? ["-movflags", "+faststart"] : []), "-progress", "pipe:1", partial,
      ];
      const child = spawn(binary, args, { cwd: staging, stdio: ["ignore", "pipe", "pipe"] });
      let error = "", pending = "";
      // Do not clean up while FFmpeg can still write.
      const abort = () => { child.kill("SIGTERM"); };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (b) => { error = (error + b.toString()).slice(-8000); });
      child.stdout.on("data", (b) => {
        pending += b.toString();
        const lines = pending.split(/\r?\n/); pending = lines.pop() || "";
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m && duration) options.onProgress?.(Math.min(99, Number(m[1]) / 1_000_000 / duration * 100));
        }
      });
      child.on("error", reject);
      child.on("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) { reject(options.signal.reason || new Error("代理任务已取消")); return; }
        code === 0 ? resolve() : reject(new Error(error || `FFmpeg 退出码 ${code}`));
      });
      if (options.signal?.aborted) abort();
    });
    try { await encode(selection.encoder); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (advanced?.encoder !== "auto" || selection.encoder !== "h264_videotoolbox" || !shouldFallbackProxyHardware(error)) throw error;
      await fs.unlink(partial).catch((error) => { if (error.code !== "ENOENT") throw error; });
      selection.encoder = "libx264";
      selection.fallbackReason = "VideoToolbox 执行失败，已重试软件编码";
      options.onProgress?.(0);
      await encode(selection.encoder);
    }
    options.signal?.throwIfAborted();
    // Exclusive publication: random suffixes are not an overwrite guard.
    try { await fs.link(partial, output); }
    catch (error: any) {
      if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(error.code)) throw error;
      await fs.copyFile(partial, output, constants.COPYFILE_EXCL);
    }
    options.onProgress?.(100);
    return { outputPath: output, size: (await fs.stat(output)).size, encoder: selection.encoder, encoderFallback: selection.fallbackReason };
  } finally {
    await fs.unlink(partial).catch(() => {});
    await fs.unlink(path.join(staging, "look.cube")).catch(() => {});
    await fs.rmdir(staging).catch(() => {}); // Only our now-empty staging directory.
  }
}
