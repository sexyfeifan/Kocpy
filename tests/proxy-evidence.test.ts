import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashFile } from "../src/main/backup/BackupEngine";
import {
  captureProxyOutput,
  compareProxyMedia,
  validateProxyParameters,
  verifyProxyOutput,
  verifyProxySource,
} from "../src/main/proxy-evidence";
import {
  publishProxyDeliveryPackage,
  proxyDeliveryCompatibility,
} from "../src/main/delivery";
import type { ProxyJob } from "../src/main/types";

async function jobFor(source: string, output: string): Promise<ProxyJob> {
  const sourceStat = await fs.stat(source);
  const sourceChecksum = await hashFile(source, "sha256");
  const media = {
    duration: "00:00:01.000",
    frameRate: "25",
    timecode: "01:00:00:00",
    audio: "aac, 48000 Hz, stereo",
    audioTracks: 1,
    rotation: 0,
    colorSpace: "bt709",
    resolution: "1920x1080",
  };
  return {
    id: "proxy-1",
    input: source,
    name: path.basename(source),
    outputDir: path.dirname(output),
    outputPath: output,
    format: "h264",
    resolution: "1080p",
    container: "mp4",
    status: "completed",
    stage: "ready",
    progress: 100,
    createdAt: 1,
    sourceTaskId: "task-1",
    sourceRelativePath: "clip.mov",
    sourceEvidence: {
      taskId: "task-1",
      relativePath: "clip.mov",
      path: source,
      bytes: sourceStat.size,
      modifiedAt: sourceStat.mtimeMs,
      hashAlgorithm: "sha256",
      checksum: sourceChecksum,
      capturedAt: 1,
      media,
    },
    parameterSnapshot: {
      purpose: "review",
      format: "h264",
      resolution: "1080p",
      container: "mp4",
      namingTemplate: "{name}_proxy_{resolution}",
    },
    outputEvidence: await captureProxyOutput(output, media),
    validation: compareProxyMedia(media, media),
  };
}

it("rejects incompatible proxy presets before they enter the queue", () => {
  expect(() =>
    validateProxyParameters({
      purpose: "editorial",
      format: "prores",
      resolution: "1080p",
      container: "mp4",
      namingTemplate: "{name}_proxy",
    }),
  ).toThrow("ProRes Proxy 仅允许 MOV 封装");
});

it("detects a same-size replacement of an already verified proxy source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-source-"));
  try {
    const source = path.join(root, "source.mov"),
      output = path.join(root, "output.mp4");
    await fs.writeFile(source, "trusted-source");
    await fs.writeFile(output, "proxy-output");
    const job = await jobFor(source, output);
    await expect(verifyProxySource(job)).resolves.toMatchObject({
      bytes: 14,
    });
    await fs.writeFile(source, "changed-source");
    await expect(verifyProxySource(job)).rejects.toThrow("内容已变化");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("allows source evidence rehashing to be cancelled before transcoding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-abort-"));
  try {
    const source = path.join(root, "source.mov"),
      output = path.join(root, "output.mp4");
    await fs.writeFile(source, "trusted-source");
    await fs.writeFile(output, "proxy-output");
    const job = await jobFor(source, output),
      controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    await expect(verifyProxySource(job, controller.signal)).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("does not invent unavailable proxy metadata", () => {
  const result = compareProxyMedia(
    { duration: "00:00:01.000", frameRate: "25", audioTracks: 0 },
    { duration: "00:00:01.000", frameRate: "25", audioTracks: 0 },
  );
  expect(result.readiness).toBe("warning");
  expect(result.notes.join(" ")).toContain("时间码");
  expect(result.notes.join(" ")).toContain("旋转元数据");
  expect(result.timecode).toBe("unknown");
});

it("blocks a delivery when completed proxy output has changed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-output-"));
  try {
    const source = path.join(root, "source.mov"),
      output = path.join(root, "output.mp4");
    await fs.writeFile(source, "trusted-source");
    await fs.writeFile(output, "proxy-output");
    const job = await jobFor(source, output);
    await expect(verifyProxyOutput(job)).resolves.toMatchObject({
      path: output,
    });
    await fs.writeFile(output, "alter-output");
    await expect(verifyProxyOutput(job)).rejects.toThrow("内容已变化");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("publishes a verified delivery atomically with evidence and compatibility scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-delivery-safe-"));
  try {
    const source = path.join(root, "source.mov"),
      output = path.join(root, "proxy.mp4"),
      destination = path.join(root, "deliveries");
    await fs.writeFile(source, "trusted-source");
    await fs.writeFile(output, "proxy-output");
    const job = await jobFor(source, output);
    const published = await publishProxyDeliveryPackage(
      [job],
      destination,
      "0.1.28",
    );
    expect(path.dirname(published)).toBe(destination);
    expect(await fs.readFile(path.join(published, "Media", "proxy.mp4"), "utf8"))
      .toBe("proxy-output");
    const evidence = JSON.parse(
      await fs.readFile(path.join(published, "Delivery_Check.json"), "utf8"),
    );
    expect(evidence.files[0].copiedSha256).toBe(job.outputEvidence?.sha256);
    expect(evidence.compatibility.resolve.status).toBe("validated-sample");
    expect(proxyDeliveryCompatibility.premiere.status).toBe("format-only");
    const resolveCsv = await fs.readFile(path.join(published, "Resolve.csv"), "utf8"),
      finalCutXml = await fs.readFile(path.join(published, "FinalCut.fcpxml"), "utf8");
    expect(resolveCsv).toContain(path.join(published, "Media", "proxy.mp4"));
    expect(finalCutXml).toContain(
      path.join(published, "Media", "proxy.mp4").replaceAll("&", "&amp;"),
    );
    expect(resolveCsv).not.toContain(output);
    expect((await fs.readdir(destination)).some((name) => name.startsWith(".kocpy")))
      .toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("rejects duplicate delivery basenames before creating a formal package", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-delivery-duplicate-"));
  try {
    const source = path.join(root, "source.mov"),
      firstDirectory = path.join(root, "first"),
      secondDirectory = path.join(root, "second"),
      destination = path.join(root, "deliveries");
    await Promise.all([
      fs.writeFile(source, "trusted-source"),
      fs.mkdir(firstDirectory),
      fs.mkdir(secondDirectory),
    ]);
    const first = path.join(firstDirectory, "same.mp4"),
      second = path.join(secondDirectory, "same.mp4");
    await Promise.all([
      fs.writeFile(first, "proxy-one"),
      fs.writeFile(second, "proxy-two"),
    ]);
    const one = await jobFor(source, first),
      two = { ...(await jobFor(source, second)), id: "proxy-2" };
    await expect(
      publishProxyDeliveryPackage([one, two], destination, "0.1.28"),
    ).rejects.toThrow("重名");
    expect(await fs.readdir(destination).catch(() => [])).toEqual([]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
