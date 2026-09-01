import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { hashFile } from "./backup/BackupEngine";
import { verifyProxyOutput } from "./proxy-evidence";
import type { ProxyJob } from "./types";

const csv = (value: unknown) =>
  `"${String(value ?? "").replace(/"/g, '""')}"`;
const xml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const completed = (jobs: ProxyJob[]) =>
  jobs.filter((job) => job.status === "completed" && job.outputPath);

export const proxyDeliveryCompatibility = {
  resolve: {
    status: "validated-sample",
    label: "Resolve 固定样本已实测",
    detail: "H.264／ProRes Proxy 固定合成样本及交付目录在 DaVinci Resolve 实际导入验证。",
  },
  premiere: {
    status: "format-only",
    label: "Premiere 清单格式",
    detail: "当前机器未安装 Premiere Pro；CSV 结构已测试，但未做本机实际导入。",
  },
  fcpxml: {
    status: "format-only",
    label: "Final Cut XML 格式",
    detail: "当前机器未安装 Final Cut Pro；FCPXML 结构已测试，但未做本机实际导入。",
  },
} as const;

function dimensions(value?: string) {
  const exact = value?.match(/(\d+)x(\d+)/i);
  if (!exact) throw new Error("代理输出缺少实际分辨率，不能生成可信 FCPXML");
  return [Number(exact[1]), Number(exact[2])];
}

function frameDuration(value?: string) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0)
    throw new Error("代理输出缺少实际帧率，不能生成可信 FCPXML");
  if (Math.abs(fps - 23.976) < 0.02) return "1001/24000s";
  if (Math.abs(fps - 29.97) < 0.02) return "1001/30000s";
  if (Math.abs(fps - 59.94) < 0.02) return "1001/60000s";
  return `1/${Math.max(1, Math.round(fps))}s`;
}

function mediaDuration(value?: string) {
  const parts = String(value || "")
      .split(":")
      .map(Number),
    seconds =
      parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error("代理输出缺少实际时长，不能生成可信 FCPXML");
  return Math.round(seconds * 1000);
}

export function generateDeliveryManifest(
  jobs: ProxyJob[],
  format: "resolve" | "premiere" | "fcpxml" | "json",
) {
  const rows = completed(jobs);
  if (!rows.length) throw new Error("没有已完成的代理可供交付");
  if (format === "json")
    return JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        application: "Kocpy",
        compatibility: proxyDeliveryCompatibility,
        proxies: rows,
      },
      null,
      2,
    );
  if (format === "resolve")
    return (
      "\ufeff" +
      [
        "Media Path,Clip Name,Reel,Timecode,Frame Rate,Source Path,Source Checksum,Output SHA-256,Delivery State,Validation",
        ...rows.map((job) =>
          [
            job.outputPath,
            path.basename(job.outputPath!),
            path.basename(job.input, path.extname(job.input)),
            job.outputEvidence?.timecode || job.timecode,
            job.outputEvidence?.frameRate,
            job.input,
            job.sourceEvidence?.checksum,
            job.outputEvidence?.sha256,
            job.validation?.readiness || "unknown",
            job.validation?.notes.join("; ") || "OK",
          ]
            .map(csv)
            .join(","),
        ),
      ].join("\n")
    );
  if (format === "premiere")
    return (
      "\ufeff" +
      [
        "File Path,Name,Media Type,Video Info,Audio Info,Start Timecode,Source,Output SHA-256,Delivery State",
        ...rows.map((job) =>
          [
            job.outputPath,
            path.basename(job.outputPath!),
            "Video",
            `${job.outputEvidence?.resolution || "未知分辨率"} ${job.format.toUpperCase()}`,
            job.outputEvidence?.audio,
            job.outputEvidence?.timecode || job.timecode,
            job.input,
            job.outputEvidence?.sha256,
            job.validation?.readiness || "unknown",
          ]
            .map(csv)
            .join(","),
        ),
      ].join("\n")
    );
  const formats = rows
    .map((job, index) => {
      const [width, height] = dimensions(job.outputEvidence?.resolution);
      return `<format id="f${index + 1}" name="Kocpy ${xml(job.outputEvidence?.resolution)}" frameDuration="${frameDuration(job.outputEvidence?.frameRate)}" width="${width}" height="${height}"/>`;
    })
    .join("");
  let offset = 0;
  const clips = rows
    .map((job, index) => {
      const duration = mediaDuration(job.outputEvidence?.duration),
        clip = `<asset-clip ref="r${index + 1}" offset="${offset}/1000s" duration="${duration}/1000s"/>`;
      offset += duration;
      return clip;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources>${formats}${rows
    .map(
      (job, index) =>
        `<asset id="r${index + 1}" name="${xml(path.basename(job.outputPath!))}" src="${xml(pathToFileURL(job.outputPath!).href)}" start="0s" duration="${mediaDuration(job.outputEvidence?.duration)}/1000s" hasVideo="1" hasAudio="${(job.outputEvidence?.audioTracks || 0) > 0 ? "1" : "0"}" format="f${index + 1}"/>`,
    )
    .join("")}</resources><library><event name="Kocpy Proxy Delivery"><project name="Kocpy Proxies"><sequence format="f1" duration="${offset}/1000s"><spine>${clips}</spine></sequence></project></event></library></fcpxml>\n`;
}

function safeOutputNames(jobs: ProxyJob[]) {
  const seen = new Set<string>();
  for (const job of jobs) {
    const name = path.basename(job.outputPath!).normalize("NFC");
    const key = name.toLocaleLowerCase("en-US");
    if (seen.has(key))
      throw new Error(`代理输出存在重名：${name}，请重新生成后再交付`);
    seen.add(key);
  }
}

async function syncPath(file: string) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes((error as NodeJS.ErrnoException).code || ""))
      throw error;
  } finally {
    await handle.close();
  }
}

export async function preflightProxyDelivery(jobs: ProxyJob[]) {
  const rows = completed(jobs);
  if (!rows.length) throw new Error("没有可交付的已完成代理文件");
  safeOutputNames(rows);
  for (const job of rows) await verifyProxyOutput(job);
  return rows;
}

export async function publishProxyDeliveryPackage(
  jobs: ProxyJob[],
  destinationDirectory: string,
  applicationVersion: string,
) {
  const rows = await preflightProxyDelivery(jobs);
  await fs.mkdir(destinationDirectory, { recursive: true });
  const staging = await fs.mkdtemp(
    path.join(destinationDirectory, ".kocpy-delivery-"),
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = path.join(
    destinationDirectory,
    `Kocpy_Delivery_${stamp}_${randomUUID().slice(0, 6)}`,
  );
  try {
    const mediaDirectory = path.join(staging, "Media");
    await fs.mkdir(mediaDirectory);
    const checks = [];
    for (const job of rows) {
      const output = path.join(mediaDirectory, path.basename(job.outputPath!));
      await fs.copyFile(job.outputPath!, output, constants.COPYFILE_EXCL);
      const copiedSha256 = await hashFile(output, "sha256");
      if (copiedSha256 !== job.outputEvidence!.sha256)
        throw new Error(`交付复制后校验失败：${job.name}`);
      await syncPath(output);
      checks.push({
        jobId: job.id,
        sourceEvidence: job.sourceEvidence,
        parameters: job.parameterSnapshot,
        outputEvidence: job.outputEvidence,
        file: path.relative(staging, output),
        copiedSha256,
        validation: job.validation,
      });
    }
    const files = new Map<string, string>([
      // Package manifests must reference the files that will exist after the
      // atomic rename, rather than the transient proxy-generation directory.
      [
        "Resolve.csv",
        generateDeliveryManifest(
          rows.map((job) => ({
            ...job,
            outputPath: path.join(finalPath, "Media", path.basename(job.outputPath!)),
          })),
          "resolve",
        ),
      ],
      [
        "Premiere.csv",
        generateDeliveryManifest(
          rows.map((job) => ({
            ...job,
            outputPath: path.join(finalPath, "Media", path.basename(job.outputPath!)),
          })),
          "premiere",
        ),
      ],
      [
        "FinalCut.fcpxml",
        generateDeliveryManifest(
          rows.map((job) => ({
            ...job,
            outputPath: path.join(finalPath, "Media", path.basename(job.outputPath!)),
          })),
          "fcpxml",
        ),
      ],
      [
        "Delivery_Check.json",
        JSON.stringify(
          {
            application: "Kocpy",
            version: applicationVersion,
            generatedAt: Date.now(),
            compatibility: proxyDeliveryCompatibility,
            files: checks,
          },
          null,
          2,
        ),
      ],
    ]);
    for (const [name, content] of files) {
      const file = path.join(staging, name);
      await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
      await syncPath(file);
    }
    await syncDirectory(mediaDirectory);
    await syncDirectory(staging);
    await fs.rename(staging, finalPath);
    await syncDirectory(destinationDirectory);
    return finalPath;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
