import ffmpeg from "ffmpeg-static";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export async function makeProxy(
  input: string,
  outputDir: string,
  format: "h264" | "prores",
  resolution: "1080p" | "720p",
) {
  if (!ffmpeg) throw new Error("内置 FFmpeg 不可用");
  if (
    !["h264", "prores"].includes(format) ||
    !["1080p", "720p"].includes(resolution)
  )
    throw new Error("无效代理参数");
  const st = await fs.stat(input);
  if (!st.isFile()) throw new Error("请选择视频文件");
  const name = path.basename(input, path.extname(input));
  await fs.mkdir(outputDir, { recursive: true });
  const output = path.join(
    outputDir,
    `${name}_proxy_${resolution}_${randomUUID().slice(0, 6)}.${format === "prores" ? "mov" : "mp4"}`,
  );
  const partial = output.replace(/\.(mov|mp4)$/, ".partial.$1");
  const height = resolution === "1080p" ? 1080 : 720;
  try {
    await exec(
      ffmpeg.replace("app.asar/", "app.asar.unpacked/"),
      [
        "-nostdin",
        "-n",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        `scale=-2:'min(${height},ih)'`,
        ...(format === "prores"
          ? [
              "-c:v",
              "prores_ks",
              "-profile:v",
              "0",
              "-pix_fmt",
              "yuv422p10le",
              "-c:a",
              "pcm_s16le",
            ]
          : [
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "23",
              "-pix_fmt",
              "yuv420p",
              "-c:a",
              "aac",
              "-movflags",
              "+faststart",
            ]),
        "-map_metadata",
        "0",
        partial,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    await fs.rename(partial, output);
    return { outputPath: output, size: (await fs.stat(output)).size };
  } finally {
    await fs.unlink(partial).catch(() => {});
  }
}
