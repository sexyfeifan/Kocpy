import { ffmpegPath } from "./ffmpeg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const exec = promisify(execFile);
export const isThumbnailMedia = (file: string) =>
  /\.(mov|mp4|mxf|mkv|avi|m4v|jpg|jpeg|png|heic|tif|tiff|dng)$/i.test(file);
export async function inspectMedia(input: string, cacheDir: string) {
  const stat = await fs.stat(input); if (!stat.isFile()) throw new Error("素材不存在");
  await fs.mkdir(cacheDir, { recursive: true });
  const key = createHash("sha1").update(input + stat.mtimeMs).digest("hex"), thumbnail = path.join(cacheDir, key + ".jpg");
  let stderr = "";
  if (!(await fs.access(thumbnail).then(() => true, () => false))) {
    try { await exec(ffmpegPath(), ["-nostdin", "-ss", "00:00:01", "-i", input, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", "-y", thumbnail], { maxBuffer: 4 * 1024 * 1024 }); }
    catch (e: any) { stderr = e.stderr || e.message; await fs.unlink(thumbnail).catch(() => {}); }
  }
  if (!stderr) {
    try { await exec(ffmpegPath(), ["-nostdin", "-i", input, "-f", "null", "-t", "0", "-"], { maxBuffer: 4 * 1024 * 1024 }); }
    catch (e: any) { stderr = e.stderr || ""; }
  }
  const duration = stderr.match(/Duration:\s*([^,]+)/)?.[1]?.trim();
  const videoLine = stderr.match(/Video:\s*([^\n]+)/)?.[1] || "";
  const video = videoLine.split(",").slice(0, 4).join(",").trim();
  const audio = stderr.match(/Audio:\s*([^\n]+)/)?.[1]?.split(",").slice(0, 3).join(",").trim();
  const timecode = stderr.match(/(?:timecode|TIMECODE)\s*:\s*([^\r\n]+)/)?.[1]?.trim();
  const camera = stderr.match(/(?:com\.apple\.quicktime\.model|model|camera_model)\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
  const creationTime = stderr.match(/creation_time\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
  const resolution = videoLine.match(/(\d{3,5}x\d{3,5})/)?.[1];
  const frameRate = videoLine.match(/([\d.]+)\s*fps/)?.[1];
  const data = await fs.readFile(thumbnail).then((b) => `data:image/jpeg;base64,${b.toString("base64")}`, () => undefined);
  return { name: path.basename(input), path: input, size: stat.size, modifiedAt: stat.mtimeMs, duration, video, audio, timecode, camera, creationTime, resolution, frameRate, thumbnail: data, thumbnailPath: data ? thumbnail : undefined };
}
