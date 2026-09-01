import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { ffmpegPath } from "../src/main/ffmpeg";
import { makeProxy } from "../src/main/proxy";
import { inspectMedia } from "../src/main/media";
import { hashFile } from "../src/main/backup/BackupEngine";
import {
  captureProxyOutput,
  compareProxyMedia,
  verifyProxyOutput,
  verifyProxySource,
} from "../src/main/proxy-evidence";
import { publishProxyDeliveryPackage } from "../src/main/delivery";
import type {
  ProxyJob,
  ProxyMediaSnapshot,
  ProxyParameterSnapshot,
} from "../src/main/types";

const exec = promisify(execFile);

async function createJob(
  source: string,
  outputDirectory: string,
  sourceMedia: ProxyMediaSnapshot,
  parameters: ProxyParameterSnapshot,
): Promise<ProxyJob> {
  const stat = await fs.stat(source),
    checksum = await hashFile(source, "sha256"),
    job: ProxyJob = {
      id: `synthetic-${parameters.format}`,
      input: source,
      name: path.basename(source),
      outputDir: outputDirectory,
      format: parameters.format,
      resolution: parameters.resolution,
      bitrateMbps: parameters.bitrateMbps,
      container: parameters.container,
      namingTemplate: parameters.namingTemplate,
      preset: parameters.purpose,
      status: "running",
      stage: "validating-source",
      progress: 0,
      createdAt: Date.now(),
      sourceTaskId: "synthetic-task",
      sourceRelativePath: path.basename(source),
      sourceEvidence: {
        taskId: "synthetic-task",
        relativePath: path.basename(source),
        path: source,
        bytes: stat.size,
        modifiedAt: stat.mtimeMs,
        hashAlgorithm: "sha256",
        checksum,
        capturedAt: Date.now(),
        media: sourceMedia,
      },
      parameterSnapshot: parameters,
    };
  await verifyProxySource(job);
  job.stage = "transcoding";
  const result = await makeProxy(
    source,
    outputDirectory,
    parameters.format,
    parameters.resolution,
    parameters,
  );
  const outputMedia = await inspectMedia(result.outputPath, path.join(outputDirectory, "cache"));
  job.outputPath = result.outputPath;
  job.outputEvidence = await captureProxyOutput(result.outputPath, outputMedia);
  job.validation = compareProxyMedia(sourceMedia, job.outputEvidence);
  job.status = "completed";
  job.stage = "ready";
  job.progress = 100;
  await verifyProxyOutput(job);
  return job;
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-delivery-"));
  try {
    const source = path.join(root, "Kocpy_Synthetic_Source.mov"),
      outputs = path.join(root, "generated"),
      cache = path.join(root, "cache"),
      deliveries = path.join(root, "deliveries");
    await fs.mkdir(outputs);
    await exec(ffmpegPath(), [
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1920x1080:rate=25",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000",
      "-t",
      "2",
      "-metadata",
      "timecode=01:00:00:00",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-c:a",
      "aac",
      source,
    ]);
    const inspected = await inspectMedia(source, cache);
    const sourceMedia: ProxyMediaSnapshot = {
      duration: inspected.duration,
      frameRate: inspected.frameRate,
      timecode: inspected.timecode,
      audio: inspected.audio,
      audioTracks: inspected.audioTracks,
      rotation: inspected.rotation,
      colorSpace: inspected.colorSpace,
      resolution: inspected.resolution,
    };
    const jobs = [];
    for (const parameters of [
      {
        purpose: "review",
        format: "h264",
        resolution: "720p",
        container: "mp4",
        namingTemplate: "{name}_review_{resolution}",
      },
      {
        purpose: "editorial",
        format: "prores",
        resolution: "1080p",
        container: "mov",
        namingTemplate: "{name}_editorial_{resolution}",
      },
    ] as ProxyParameterSnapshot[])
      jobs.push(await createJob(source, outputs, sourceMedia, parameters));
    const delivery = await publishProxyDeliveryPackage(jobs, deliveries, "runtime-check");
    const check = JSON.parse(
      await fs.readFile(path.join(delivery, "Delivery_Check.json"), "utf8"),
    );
    if (check.files.length !== 2) throw new Error("Delivery evidence is incomplete");
    const media = (await fs.readdir(path.join(delivery, "Media"))).sort();
    if (media.length !== 2) throw new Error("Delivery media is incomplete");
    const result = {
      arch: process.arch,
      passed: true,
      delivery,
      media,
      readiness: jobs.map((job) => job.validation?.readiness),
    };
    console.log(JSON.stringify(result));
    if (process.env.KOCPY_KEEP_PROXY_DELIVERY === "1") return;
  } finally {
    if (process.env.KOCPY_KEEP_PROXY_DELIVERY !== "1")
      await fs.rm(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
