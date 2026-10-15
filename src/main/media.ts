import { ffmpegPath } from "./ffmpeg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const exec = promisify(execFile);

export interface MediaInspectionOptions { signal?: AbortSignal }

/** A one-second seek is at EOF for a one-second clip, and invalid for stills. */
export function thumbnailSeekSeconds(input: string, duration?: string): number {
  if (/\.(jpg|jpeg|png|heic|tif|tiff|dng)$/i.test(input)) return 0;
  const match = duration?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return 0;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 1 ? Math.min(1, seconds / 2) : 0;
}

async function mediaCommand(binary: string, args: string[], options: MediaInspectionOptions, timeout = 15000) {
  options.signal?.throwIfAborted();
  const invocation = exec(binary, args, { maxBuffer: 4 * 1024 * 1024, timeout, killSignal: "SIGKILL", signal: options.signal });
  // On abort, execFile can reject before the child has closed. Do not clean up
  // cache staging while a process could still be writing to it.
  const closed = new Promise<void>((resolve) => invocation.child.once("close", () => resolve()));
  try { return await invocation; }
  finally { await closed; options.signal?.throwIfAborted(); }
}

async function readThumbnail(file: string): Promise<Buffer | undefined> {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 4 || before.size > 16 * 1024 * 1024) throw new Error("缩略图缓存不是有效的图像文件");
    const bytes = await handle.readFile(), after = await handle.stat(), atPath = await fs.lstat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || after.dev !== atPath.dev || after.ino !== atPath.ino ||
        after.size !== atPath.size || after.mtimeMs !== atPath.mtimeMs || after.ctimeMs !== atPath.ctimeMs || atPath.isSymbolicLink())
      throw new Error("缩略图缓存在读取时发生变化");
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
      throw new Error("缩略图未生成有效的 JPEG 内容");
    return bytes;
  } finally { await handle.close(); }
}

async function createThumbnail(binary: string, input: string, thumbnail: string, seek: number, options: MediaInspectionOptions) {
  options.signal?.throwIfAborted();
  // FFmpeg writes only to an owned cache staging directory, never directly to a
  // predictable existing cache path or a substituted output symlink.
  const staging = await fs.mkdtemp(path.join(path.dirname(thumbnail), ".kocpy-thumbnail-"));
  const outputs: string[] = [];
  const binding = await fs.lstat(staging);
  const errors: string[] = [];
  try {
    for (const [attempt, offset] of (seek > 0 ? [seek, 0] : [0]).entries()) {
      options.signal?.throwIfAborted();
      const output = path.join(staging, `${attempt}.jpg`); outputs.push(output);
      let generated: Buffer | undefined;
      try {
        await mediaCommand(binary, ["-nostdin", "-hide_banner", "-n", ...(offset > 0 ? ["-ss", String(offset)] : []),
          "-i", input, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "3", "-update", "1", output], options);
        generated = await readThumbnail(output);
        if (!generated) throw new Error("媒体工具没有输出缩略图");
      } catch (error: any) {
        options.signal?.throwIfAborted();
        // Timeouts are not an invitation to launch another long-running job.
        if (error.killed || error.signal) throw error;
        errors.push(String(error.stderr || error.message || error).slice(-2000));
        continue;
      }
      options.signal?.throwIfAborted();
      try { await fs.link(output, thumbnail); }
      catch (error: any) {
        if (error.code !== "EEXIST") {
          if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(error.code)) throw error;
          try {
            const published = await fs.open(thumbnail, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try { await published.writeFile(generated); await published.sync(); } finally { await published.close(); }
          }
          catch (copyError: any) { if (copyError.code !== "EEXIST") throw copyError; }
        }
      }
      const published = await readThumbnail(thumbnail);
      if (!published || !published.equals(generated)) throw new Error("缩略图发布后无法回读或内容发生变化");
      return published;
    }
    throw new Error(`无法生成缩略图：${errors.join("；首帧重试：")}`);
  } finally {
    const current = await fs.lstat(staging).catch(() => undefined);
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === binding.dev && current.ino === binding.ino) {
      for (const output of outputs) await fs.unlink(output).catch(() => {});
      await fs.rmdir(staging).catch(() => {});
    }
  }
}

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
  const rotation = rotationMatch ? Number(rotationMatch[1]) : videoLine ? 0 : undefined;
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

/**
 * Read only the media header needed for date suggestions. The returned date is
 * advisory: camera clocks and timezone metadata can be wrong, so callers must
 * still require an operator confirmation.
 */
export async function probeMediaCreationTime(input: string) {
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error("素材不存在");
  let stderr = "";
  try {
    stderr = (
      await exec(
        ffmpegPath(),
        ["-nostdin", "-hide_banner", "-i", input],
        { maxBuffer: 4 * 1024 * 1024, timeout: 15000 },
      )
    ).stderr;
  } catch (error: any) {
    stderr = error.stderr || "";
  }
  return parseMediaProbe(stderr).creationTime;
}

export async function inspectMedia(input: string, cacheDir: string, options: MediaInspectionOptions = {}) {
  options.signal?.throwIfAborted();
  const stat = await fs.stat(input);
  if (!stat.isFile()) throw new Error("素材不存在");
  options.signal?.throwIfAborted();
  await fs.mkdir(cacheDir, { recursive: true });
  const key = createHash("sha1")
      .update(input + stat.mtimeMs)
      .digest("hex"),
    // Keep legacy cache bytes untouched, including zero-byte images left by
    // older FFmpeg success-with-no-frames behavior. Waveform caching is unchanged.
    thumbnail = path.join(cacheDir, key + "-v2.jpg"),
    waveform = path.join(cacheDir, key + "-waveform.png");
  let stderr = "";
  const binary = ffmpegPath();
  // Read the header once, before selecting a frame, and use the same result for
  // returned metadata. A cache hit still refreshes metadata as before.
  try { stderr = (await mediaCommand(binary, ["-nostdin", "-hide_banner", "-i", input, "-f", "null", "-t", "0", "-"], options)).stderr; }
  catch (error: any) {
    options.signal?.throwIfAborted();
    if (error.killed || error.signal) throw error;
    stderr = error.stderr || "";
  }
  const metadata = parseMediaProbe(stderr);
  let thumbnailBytes: Buffer | undefined, thumbnailError: string | undefined, waveformError: string | undefined;
  if (metadata.video || isThumbnailMedia(input)) {
    try {
      thumbnailBytes = await readThumbnail(thumbnail) || await createThumbnail(binary, input, thumbnail, thumbnailSeekSeconds(input, metadata.duration), options);
    } catch (error: any) {
      options.signal?.throwIfAborted();
      if (error.killed || error.signal) throw error;
      thumbnailError = String(error.message || error);
    }
  }
  options.signal?.throwIfAborted();
  if (
    metadata.audio &&
    !(await fs.access(waveform).then(
      () => true,
      () => false,
    ))
  )
    await mediaCommand(
      binary,
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
      options,
      30000,
    ).catch((error) => {
      options.signal?.throwIfAborted();
      // Waveforms remain optional: their failure must not discard an already
      // valid thumbnail, but it is not reported as a successful waveform either.
      waveformError = String(error.stderr || error.message || error).slice(-2000);
    });
  options.signal?.throwIfAborted();
  const data = thumbnailBytes ? `data:image/jpeg;base64,${thumbnailBytes.toString("base64")}` : undefined;
  const waveformData = waveformError ? undefined : await fs.readFile(waveform).then(
    (bytes) => {
      // A killed decoder can leave a cache file behind. A later cache hit must
      // not turn that unfinished output into a successful waveform preview.
      if (bytes.length < 20 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
          !bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))) {
        waveformError = "波形缓存不是完整的 PNG 图像";
        return undefined;
      }
      return `data:image/png;base64,${bytes.toString("base64")}`;
    },
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
    thumbnailError,
    waveform: waveformData,
    waveformPath: waveformData ? waveform : undefined,
    waveformError,
  };
}
