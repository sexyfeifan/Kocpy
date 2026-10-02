import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { ffmpegPath } from "../src/main/ffmpeg";
import { makeProxy } from "../src/main/proxy";
import { freezeProxyAdvanced } from "../src/main/proxy-advanced";
import { inspectMedia } from "../src/main/media";
import { hashFile } from "../src/main/backup/BackupEngine";
import {
  captureProxyOutput,
  compareProxyMedia,
  verifyProxyOutput,
  verifyProxySource,
  checkProxyDelivery,
  approveProxyDelivery,
} from "../src/main/proxy-evidence";
import { publishProxyDeliveryPackage } from "../src/main/delivery";
import { ProxyRunRegistry } from "../src/main/proxy-scheduler";
import { preflightProxyGeneration } from "../src/main/proxy-preflight";
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
  job.preflight = await preflightProxyGeneration(outputDirectory, [{ media: sourceMedia, parameters }], [source]);
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
  job.outputEvidence = { ...await captureProxyOutput(result.outputPath, outputMedia), encoder: result.encoder, encoderFallback: result.encoderFallback };
  job.validation = compareProxyMedia(sourceMedia, job.outputEvidence, parameters);
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
      "-x264-params",
      "colorprim=bt709:transfer=bt709:colormatrix=bt709",
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
    const advancedResults = [];
    const lutPath = path.join(root, "identity.cube");
    await fs.writeFile(lutPath, "LUT_3D_SIZE 2\n" + ["0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1"].join("\n"));
    for (const advanced of [
      { encoder: "software", frameRate: "24", audioMode: "first", timecodeMode: "custom", timecode: "02:00:00:00", rotation: "90", aspect: "fit", colorMode: "bt709", lutPath },
      { encoder: "auto", audioMode: "none", timecodeMode: "drop", aspect: "crop" },
    ] as import("../src/main/types").ProxyAdvanced[]) {
      const parameters: ProxyParameterSnapshot = { purpose: "review", format: "h264", resolution: "640x360", container: "mov", namingTemplate: "{name}_advanced", advanced: await freezeProxyAdvanced(advanced) };
      const job = await createJob(source, outputs, sourceMedia, parameters);
      const check = checkProxyDelivery(job);
      if (check.state === "blocked") throw new Error(`Advanced conversion blocked: ${check.blockers.join("; ")}`);
      if (job.outputEvidence?.resolution !== "640x360") throw new Error("Explicit dimension mismatch");
      advancedResults.push({ encoder: job.outputEvidence.encoder, fallback: job.outputEvidence.encoderFallback, validation: job.validation });
    }
    const lt = await createJob(source, outputs, sourceMedia, { purpose: "editorial", format: "prores", container: "mov", resolution: "720p", namingTemplate: "{name}_lt", advanced: await freezeProxyAdvanced({ proresProfile: 1 }) });
    if (checkProxyDelivery(lt).state === "blocked" || lt.outputEvidence?.encoder !== "prores_ks") throw new Error("ProRes LT conversion failed");
    const frozenLut = await freezeProxyAdvanced({ lutPath });
    await fs.appendFile(lutPath, "\n# altered");
    let rejected = false;
    try { await makeProxy(source, outputs, "h264", "720p", { advanced: frozenLut }); }
    catch (error) { rejected = /LUT 内容已改变/.test(String(error)); }
    if (!rejected) throw new Error("Changed LUT was not rejected");
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
    for (const job of jobs) {
      const check = checkProxyDelivery(job);
      if (check.state === "blocked") throw new Error(`Generated proxy blocked: ${check.blockers.join("; ")}`);
      if (check.state === "warning") approveProxyDelivery(job, "合成样本运行时检查：保留未知元数据边界", "隔离运行时验收");
    }
    const delivery = await publishProxyDeliveryPackage(jobs, deliveries, "runtime-check");
    // Isolated resource fixture tests real FFmpeg workers and independent signals;
    // it is not evidence of a physical disk or NAS throughput test.
    const registry = new ProxyRunRegistry();
    const parallelJobs = ["parallel-a", "parallel-b"].map((id) => ({ id, concurrency: 2 } as ProxyJob));
    const resources = { keys: ["synthetic-ssd"], exclusive: false, autoLimit: 2 as const, reason: "synthetic" };
    const controllers = parallelJobs.map((job) => registry.reserve(job, resources, 2)!);
    const workers = controllers.map((controller) => makeProxy(source, outputs, "h264", "720p", { signal: controller.signal }));
    registry.cancel(parallelJobs[1].id);
    const results = await Promise.allSettled(workers);
    if (results[0].status !== "fulfilled" || results[1].status !== "rejected") throw new Error("Parallel cancellation affected another worker");
    for (const job of parallelJobs) registry.release(job.id);
    if (registry.busy) throw new Error("Parallel worker slot leaked");
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
      advancedResults,
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
