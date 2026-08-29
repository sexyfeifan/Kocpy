import { ffmpegPath } from "./ffmpeg";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
async function durationSeconds(binary: string, input: string) {
  try { await exec(binary, ["-nostdin", "-i", input], { maxBuffer: 4 * 1024 * 1024 }); return 0; }
  catch (e: any) { const m = String(e.stderr || "").match(/Duration:\s*(\d+):(\d+):([\d.]+)/); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0; }
}
export async function makeProxy(input: string, outputDir: string, format: "h264" | "prores", resolution: "1080p" | "720p", options: { signal?: AbortSignal; onProgress?: (percent: number) => void; namingTemplate?: string } = {}) {
  if (!["h264", "prores"].includes(format) || !["1080p", "720p"].includes(resolution)) throw new Error("无效代理参数");
  const st = await fs.stat(input); if (!st.isFile()) throw new Error("请选择视频文件");
  const name = path.basename(input, path.extname(input)); await fs.mkdir(outputDir, { recursive: true });
  const safeTemplate = (options.namingTemplate || "{name}_proxy_{resolution}").replaceAll("{name}", name).replaceAll("{resolution}", resolution).replaceAll("{format}", format).replace(/[/\\:\0]/g, "_").trim() || `${name}_proxy_${resolution}`;
  const output = path.join(outputDir, `${safeTemplate}_${randomUUID().slice(0, 6)}.${format === "prores" ? "mov" : "mp4"}`), partial = output.replace(/\.(mov|mp4)$/, ".partial.$1");
  const height = resolution === "1080p" ? 1080 : 720, binary = ffmpegPath(), duration = await durationSeconds(binary, input);
  const args = ["-nostdin", "-n", "-i", input, "-map", "0:v:0", "-map", "0:a?", "-vf", `scale=-2:'min(${height},ih)'`, ...(format === "prores" ? ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", "-c:a", "pcm_s16le"] : ["-c:v", "libx264", "-preset", "fast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]), "-map_metadata", "0", "-progress", "pipe:1", partial];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }); let error = "", pending = "";
      const abort = () => { child.kill("SIGTERM"); reject(options.signal?.reason || new Error("代理任务已取消")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stderr.on("data", (b) => { error = (error + b.toString()).slice(-8000); });
      child.stdout.on("data", (b) => { pending += b.toString(); const lines = pending.split(/\r?\n/); pending = lines.pop() || ""; for (const line of lines) { const m = line.match(/^out_time_us=(\d+)/); if (m && duration) options.onProgress?.(Math.min(99, Number(m[1]) / 1_000_000 / duration * 100)); } });
      child.on("error", reject); child.on("close", (code) => { options.signal?.removeEventListener("abort", abort); if (options.signal?.aborted) return; code === 0 ? resolve() : reject(new Error(error || `FFmpeg 退出码 ${code}`)); });
    });
    await fs.rename(partial, output); options.onProgress?.(100); return { outputPath: output, size: (await fs.stat(output)).size };
  } finally { await fs.unlink(partial).catch(() => {}); }
}
