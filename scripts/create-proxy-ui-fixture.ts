// Creates an isolated proxy/evidence UI fixture under the system temp folder.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { ffmpegPath } from "../src/main/ffmpeg";
import { inspectMedia } from "../src/main/media";
import { makeProxy } from "../src/main/proxy";
import {
  captureProxyOutput,
  compareProxyMedia,
} from "../src/main/proxy-evidence";
import type { ProxyJob, ProxyMediaSnapshot } from "../src/main/types";

const exec = promisify(execFile);

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-ui-")),
    data = path.join(root, "data"),
    source = path.join(root, "Synthetic_Card"),
    destination = path.join(root, "Verified_Backup"),
    output = path.join(root, "Proxy_Output"),
    cache = path.join(data, "thumbnails");
  await Promise.all(
    [data, source, destination, output, cache].map((item) =>
      fs.mkdir(item, { recursive: true }),
    ),
  );
  const sourceFile = path.join(source, "Kocpy_UI_Synthetic.mov");
  await exec(ffmpegPath(), [
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000",
    "-t",
    "2",
    "-metadata",
    "timecode=01:00:00:00",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    sourceFile,
  ]);
  const engine = new BackupEngine(),
    task = engine.createTask({
      name: "Synthetic Proxy Evidence",
      sourcePath: source,
      destinationPaths: [destination],
      hashAlgorithm: "sha256",
      copyMode: "mirror",
      generateThumbnails: false,
    });
  await new Promise<void>((resolve, reject) => {
    engine.once("settled", (settled) =>
      settled.status === "completed"
        ? resolve()
        : reject(new Error(settled.errorMessage || "Synthetic transfer failed")),
    );
    engine.startTask(task.id);
  });
  const record = task.fileRecords[0],
    verified = record.destinations.find((item) => item.verified);
  if (!verified?.checksum) throw new Error("Synthetic copy lacks hash evidence");
  const sourceStat = await fs.stat(verified.path),
    sourceMedia = (await inspectMedia(verified.path, cache)) as ProxyMediaSnapshot,
    parameters = {
      purpose: "editorial" as const,
      format: "prores" as const,
      resolution: "720p",
      container: "mov" as const,
      namingTemplate: "{name}_proxy_{resolution}",
    },
    result = await makeProxy(
      verified.path,
      output,
      parameters.format,
      parameters.resolution,
      parameters,
    ),
    outputMedia = (await inspectMedia(result.outputPath, cache)) as ProxyMediaSnapshot,
    outputEvidence = await captureProxyOutput(result.outputPath, outputMedia),
    job: ProxyJob = {
      id: randomUUID(),
      input: verified.path,
      name: path.basename(verified.path),
      outputDir: output,
      outputPath: result.outputPath,
      format: parameters.format,
      resolution: parameters.resolution,
      container: parameters.container,
      preset: parameters.purpose,
      namingTemplate: parameters.namingTemplate,
      status: "completed",
      stage: "ready",
      progress: 100,
      createdAt: Date.now(),
      completedAt: Date.now(),
      sourceTaskId: task.id,
      sourceRelativePath: record.relativePath,
      sourceEvidence: {
        taskId: task.id,
        relativePath: record.relativePath,
        path: verified.path,
        bytes: sourceStat.size,
        modifiedAt: sourceStat.mtimeMs,
        hashAlgorithm: task.hashAlgorithm,
        checksum: verified.checksum,
        capturedAt: Date.now(),
        media: sourceMedia,
      },
      parameterSnapshot: parameters,
      outputEvidence,
      validation: compareProxyMedia(sourceMedia, outputEvidence),
    };
  await Promise.all([
    fs.writeFile(path.join(data, "tasks.json"), JSON.stringify([task])),
    fs.writeFile(path.join(data, "projects.json"), "[]"),
    fs.writeFile(path.join(data, "proxy-jobs.json"), JSON.stringify([job])),
  ]);
  console.log(JSON.stringify({ root, data, output: result.outputPath }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
