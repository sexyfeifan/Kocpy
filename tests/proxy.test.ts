import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { makeProxy } from "../src/main/proxy";
import { ffmpegPath } from "../src/main/ffmpeg";
import { generateDeliveryManifest } from "../src/main/delivery";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { inspectMedia } from "../src/main/media";
const exec = promisify(execFile);
const ffmpeg = ffmpegPath();
it("reads metadata from successful probing and produces an audio waveform", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-media-metadata-"));
  try {
    const input = path.join(root, "audio-video.mp4");
    await exec(ffmpeg, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", input]);
    const result = await inspectMedia(input, path.join(root, "cache"));
    expect(result.duration).toContain("00:00:02");
    expect(result.frameRate).toBe("24");
    expect(result.audio).toContain("aac");
    expect(result.thumbnailPath).toBeTruthy();
    expect(result.waveformPath).toBeTruthy();
    expect((await fs.stat(result.waveformPath!)).size).toBeGreaterThan(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("does not launch or publish an already cancelled proxy job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-pre-cancel-"));
  try {
    const input = path.join(root, "source.mp4"), output = path.join(root, "proxies");
    await exec(ffmpeg, ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5", "-c:v", "libx264", input]);
    const controller = new AbortController(); controller.abort(new Error("cancel before start"));
    await expect(makeProxy(input, output, "h264", "720p", { signal: controller.signal })).rejects.toThrow("cancel before start");
    expect(await fs.readdir(output).catch(() => [])).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("attaches a generated thumbnail to the verified backup file record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-backup-thumb-"));
  try {
    const source = path.join(root, "source"), destination = path.join(root, "destination"), thumbnails = path.join(root, "thumbnails");
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
    await exec(ffmpeg!, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "2", "-c:v", "libx264", path.join(source, "clip.mp4")]);
    const engine = new BackupEngine(thumbnails);
    const task = engine.createTask({ name: "thumb", sourcePath: source, destinationPaths: [destination], devices: [], hashAlgorithm: "sha256", namingTemplate: "thumb", shootingDate: "", copyMode: "mirror" });
    const settled = new Promise<any>((resolve) => engine.once("settled", resolve));
    const metadata = new Promise<any>((resolve) => engine.once("metadata", resolve));
    engine.startTask(task.id);
    const result = await settled;
    expect(result.status).toBe("completed");
    await metadata;
    expect(result.fileRecords[0].thumbnailPath).toMatch(/\.jpg$/);
    expect((await fs.stat(result.fileRecords[0].thumbnailPath)).size).toBeGreaterThan(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("generates playable H.264 and ProRes proxy files with the bundled FFmpeg", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-"));
  try {
    const input = path.join(root, "source.mp4");
    await exec(ffmpeg!, [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24",
      "-t",
      "1",
      "-c:v",
      "libx264",
      input,
    ]);
    for (const format of ["h264", "prores"] as const) {
      const result = await makeProxy(
        input,
        path.join(root, "proxies"),
        format,
        "720p",
      );
      expect(result.size).toBeGreaterThan(0);
      const check = await exec(ffmpeg!, [
        "-v",
        "error",
        "-i",
        result.outputPath,
        "-f",
        "null",
        "-",
      ]);
      expect(check.stderr).toBe("");
    }
    expect(
      (await fs.readdir(path.join(root, "proxies"))).some((p) =>
        p.includes(".partial"),
      ),
    ).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("reports proxy progress and removes partial output after cancellation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-cancel-"));
  try {
    const input=path.join(root,"long.mp4"), out=path.join(root,"out");
    await exec(ffmpeg!,["-f","lavfi","-i","testsrc2=size=1280x720:rate=30","-t","8","-c:v","libx264","-preset","ultrafast",input]);
    const controller=new AbortController(); let progress=0;
    await expect(makeProxy(input,out,"h264","720p",{signal:controller.signal,onProgress:(p)=>{progress=Math.max(progress,p);if(p>0)controller.abort(new Error("test cancel"));}})).rejects.toThrow();
    expect(progress).toBeGreaterThan(0); expect(await fs.readdir(out)).not.toContain(expect.stringContaining(".partial."));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
it("applies proxy naming templates without overwriting existing files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-name-"));
  try {
    const input = path.join(root, "A001.mp4"), out = path.join(root, "out");
    await exec(ffmpeg!, ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5", "-c:v", "libx264", input]);
    const first = await makeProxy(input, out, "h264", "720p", { namingTemplate: "{name}_{format}_{resolution}" });
    const second = await makeProxy(input, out, "h264", "720p", { namingTemplate: "{name}_{format}_{resolution}" });
    expect(path.basename(first.outputPath)).toMatch(/^A001_h264_720p_[a-f0-9]{6}\.mp4$/);
    expect(second.outputPath).not.toBe(first.outputPath);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it("exports Resolve, Premiere, Final Cut and JSON proxy delivery manifests", () => {
  const jobs: any[] = [{ id: "p1", input: "/media/A001.mov", name: "A001.mov", outputDir: "/proxy", outputPath: "/proxy/A001_proxy.mov", format: "prores", resolution: "1080p", status: "completed", progress: 100, createdAt: 1, timecode: "01:00:00:00", sourceFrameRate: "25", sourceAudio: "pcm",sourceDuration:"00:00:12.500" }];
  expect(generateDeliveryManifest(jobs, "resolve")).toContain("Media Path,Clip Name");
  expect(generateDeliveryManifest(jobs, "premiere")).toContain("Start Timecode");
  expect(generateDeliveryManifest(jobs, "fcpxml")).toContain("duration=\"12500/1000s\"");
  expect(JSON.parse(generateDeliveryManifest(jobs, "json")).proxies).toHaveLength(1);
});
