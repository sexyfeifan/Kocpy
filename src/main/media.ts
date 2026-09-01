import { ffmpegPath } from "./ffmpeg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const exec = promisify(execFile);

export const isThumbnailMedia = (file: string) =>
  /\.(mov|mp4|mxf|mkv|avi|m4v|jpg|jpeg|png|heic|tif|tiff|dng)$/i.test(file);

export async function pruneMediaCache(
  cacheDir: string,
  maxBytes = 2 * 1024 * 1024 * 1024,
) {
  await fs.mkdir(cacheDir, { recursive: true });
  const entries = await fs.readdir(cacheDir, { withFileTypes: true });
  const files = (
    await Promise.all(
      entries
        .filter((item) => item.isFile())
        .map(async (item) => ({
          path: path.join(cacheDir, item.name),
          ...(await fs.stat(path.join(cacheDir, item.name))),
        })),
    )
  ).sort((a, b) => a.atimeMs - b.atimeMs);
  let total = files.reduce((sum, item) => sum + item.size, 0),
    removed = 0;
  for (const item of files) {
    if (total <= maxBytes) break;
    await fs.unlink(item.path);
    total -= item.size;
    removed++;
  }
  return { bytes: total, removed };
}

export function parseMediaProbe(stderr: string) {
  // `ffmpeg -f null` describes the input and then repeats mapped streams in
  // the output section. Metadata inspection must be based on the input only.
  const inputProbe = stderr.split(/^\s*Output #/m)[0];
  const duration = inputProbe.match(/Duration:\s*([^,]+)/)?.[1]?.trim();
  const videoLine = inputProbe.match(/Video:\s*([^\n]+)/)?.[1] || "";
  const video = videoLine.split(",").slice(0, 4).join(",").trim();
  // Only count ffmpeg stream declarations. Metadata can also contain an
  // `Audio:` label (for example a timecode/data stream), but it is not an
  // independently playable audio track.
  const audioLines = [...inputProbe.matchAll(/^\s*Stream #[^\r\n]*?: Audio:\s*([^\n]+)/gm)];
  const audio = audioLines[0]?.[1]?.split(",").slice(0, 3).join(",").trim();
  const timecode = inputProbe
    .match(/(?:timecode|TIMECODE)\s*:\s*([^\r\n]+)/)?.[1]
    ?.trim();
  const camera = inputProbe
    .match(
      /(?:com\.apple\.quicktime\.model|model|camera_model)\s*:\s*([^\r\n]+)/i,
    )?.[1]
    ?.trim();
  const creationTime = inputProbe
    .match(/creation_time\s*:\s*([^\r\n]+)/i)?.[1]
    ?.trim();
  const resolution = videoLine.match(/(\d{3,5}x\d{3,5})/)?.[1];
  const frameRate = videoLine.match(/([\d.]+)\s*fps/)?.[1];
  const colorSpace = videoLine.match(
    /\b(bt\d{3,4}|smpte\d+|display-p3|rec\.?2020)\b/i,
  )?.[1];
  const rotationMatch = inputProbe.match(
    /(?:rotation\s*:\s*|rotation of\s*)(-?\d+(?:\.\d+)?)/i,
  );
  const rotation = rotationMatch ? Number(rotationMatch[1]) : undefined;
  const probeRecognized = Boolean(duration || videoLine);
  return {
    duration,
    video,
    audio,
    audioTracks: probeRecognized ? audioLines.length : undefined,
    timecode,
    camera,
    creationTime,
    resolution,
    frameRate,
    colorSpace,
    rotation: Number.isFinite(rotation) ? rotation : undefined,
  };
}

export async function inspectMedia(input: string, cacheDir: string) {
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error("素材不存在");
  await fs.mkdir(cacheDir, { recursive: true });
  const key = createHash("sha1")
      .update(input + stat.mtimeMs)
      .digest("hex"),
    thumbnail = path.join(cacheDir, key + ".jpg"),
    waveform = path.join(cacheDir, key + "-waveform.png");
  let stderr = "";
  if (!(await fs.access(thumbnail).then(() => true, () => false))) {
    try {
      await exec(
        ffmpegPath(),
        [
          "-nostdin",
          "-ss",
          "00:00:01",
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=720:-2",
          "-q:v",
          "3",
          "-y",
          thumbnail,
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error: any) {
      stderr = error.stderr || error.message;
      await fs.unlink(thumbnail).catch(() => {});
    }
  }
  if (!stderr) {
    try {
      stderr = (
        await exec(
          ffmpegPath(),
          ["-nostdin", "-i", input, "-f", "null", "-t", "0", "-"],
          { maxBuffer: 4 * 1024 * 1024 },
        )
      ).stderr;
    } catch (error: any) {
      stderr = error.stderr || "";
    }
  }
  const metadata = parseMediaProbe(stderr);
  if (
    metadata.audio &&
    !(await fs.access(waveform).then(
      () => true,
      () => false,
    ))
  )
    await exec(
      ffmpegPath(),
      [
        "-nostdin",
        "-i",
        input,
        "-filter_complex",
        "aformat=channel_layouts=mono,showwavespic=s=720x120:colors=8f75ff",
        "-frames:v",
        "1",
        "-y",
        waveform,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ).catch(() => {});
  const data = await fs.readFile(thumbnail).then(
    (bytes) => `data:image/jpeg;base64,${bytes.toString("base64")}`,
    () => undefined,
  );
  const waveformData = await fs.readFile(waveform).then(
    (bytes) => `data:image/png;base64,${bytes.toString("base64")}`,
    () => undefined,
  );
  return {
    name: path.basename(input),
    path: input,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    ...metadata,
    thumbnail: data,
    thumbnailPath: data ? thumbnail : undefined,
    waveform: waveformData,
    waveformPath: waveformData ? waveform : undefined,
  };
}
