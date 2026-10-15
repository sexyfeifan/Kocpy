import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const runtime = vi.hoisted(() => ({ binary: "" }));
vi.mock("../src/main/ffmpeg", () => ({ ffmpegPath: () => runtime.binary }));
import { inspectMedia, thumbnailSeekSeconds } from "../src/main/media";
import { BackupEngine } from "../src/main/backup/BackupEngine";

const exec = promisify(execFile), native = path.resolve("resources", "ffmpeg", `ffmpeg-darwin-${process.arch}`);
let root: string, cache: string, reference: string, callsFile: string;
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-thumbnail-regression-")));
  cache = path.join(root, "cache"); reference = path.join(root, "reference.jpg"); callsFile = path.join(root, "calls.jsonl");
  runtime.binary = native;
  await exec(native, ["-nostdin", "-hide_banner", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-frames:v", "1", "-update", "1", reference]);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function calls() { return (await fs.readFile(callsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
async function fakeInput(mode: string) {
  const input = path.join(root, `${mode}.mp4`); await fs.writeFile(input, "read-only synthetic source");
  const stub = path.join(root, "controlled-ffmpeg");
  await fs.writeFile(stub, `#!${process.execPath}
const fs = require("fs"), path = require("path"), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const input = args[args.indexOf("-i") + 1], mode = path.basename(input, ".mp4"), output = args.at(-1);
if (output === "-") {
  process.stderr.write("Input #0: fixture\\n  Duration: 00:00:03.00, start: 0.000000\\n  Stream #0:0: Video: h264, yuv420p, 160x90, 24 fps\\n");
  if (mode === "waveform-failed") process.stderr.write("  Stream #0:1: Audio: aac, 48000 Hz, stereo\\n");
} else if (mode === "waveform-failed" && output.endsWith(".png")) {
  fs.writeFileSync(output, "unfinished waveform"); process.stderr.write("Audio decoder failure"); process.exitCode = 1;
} else if (mode === "hang") {
  fs.writeFileSync(output, "unfinished cache output"); setInterval(() => {}, 1000);
} else if (mode === "failed-seek" && args.includes("-ss")) {
  fs.writeFileSync(output, "invalid partial JPEG"); process.stderr.write("No filtered frames; end of file"); process.exitCode = 1;
} else if (mode === "empty-seek" && args.includes("-ss")) {
  // Some FFmpeg versions return success for an empty seek result.
} else if (mode === "bad-jpeg" && args.includes("-ss")) {
  fs.writeFileSync(output, "not a JPEG despite exit zero");
} else if (mode === "decoder-failed") {
  fs.writeFileSync(output, "partial output"); process.stderr.write("Invalid data found when processing input"); process.exitCode = 1;
} else { fs.copyFileSync(${JSON.stringify(reference)}, output); }
`, { mode: 0o700 });
  runtime.binary = stub; return input;
}

describe("safe thumbnail frame selection", () => {
  it("never seeks to the end of short clips or past still-image content", () => {
    expect(thumbnailSeekSeconds("clip.mp4", "00:00:00.25")).toBe(0);
    expect(thumbnailSeekSeconds("clip.mp4", "00:00:01.00")).toBe(0);
    expect(thumbnailSeekSeconds("clip.mp4", "00:00:01.20")).toBe(0.6);
    expect(thumbnailSeekSeconds("clip.mp4", "00:00:03.00")).toBe(1);
    for (const extension of ["jpg", "JPEG", "png", "heic", "tiff", "dng"])
      expect(thumbnailSeekSeconds(`still.${extension}`, "00:00:03.00")).toBe(0);
    expect(thumbnailSeekSeconds("clip.mp4", "N/A")).toBe(0);
    expect(thumbnailSeekSeconds("clip.mp4")).toBe(0);
  });

  it.each(["0.25", "1", "3"])("really decodes a %s-second video into a valid thumbnail with native FFmpeg", async duration => {
    const input = path.join(root, `clip-${duration}.mp4`);
    await exec(native, ["-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", duration, "-c:v", "libx264", input]);
    const before = await fs.stat(input), sha256 = digest(await fs.readFile(input));
    const result = await inspectMedia(input, cache);
    expect(result.thumbnailPath).toBeTruthy(); expect(result.thumbnailError).toBeUndefined();
    expect((await fs.stat(result.thumbnailPath!)).size).toBeGreaterThan(100);
    const decoded = await exec(native, ["-v", "error", "-i", result.thumbnailPath!, "-f", "null", "-"]);
    expect(decoded.stderr).toBe("");
    const after = await fs.stat(input);
    expect([after.size, after.mtimeMs, after.ctimeMs, digest(await fs.readFile(input))]).toEqual([before.size, before.mtimeMs, before.ctimeMs, sha256]);
    expect((await fs.readdir(cache)).some(name => name.startsWith(".kocpy-thumbnail-"))).toBe(false);
  });

  it("really thumbnails a still image, preserves its original bytes and reuses a valid cache", async () => {
    const before = await fs.stat(reference), sha256 = digest(await fs.readFile(reference));
    const first = await inspectMedia(reference, cache); expect(first.thumbnailPath).toBeTruthy();
    const cached = await fs.stat(first.thumbnailPath!);
    const second = await inspectMedia(reference, cache); expect(second.thumbnailPath).toBe(first.thumbnailPath);
    const reused = await fs.stat(second.thumbnailPath!); expect([reused.ino, reused.mtimeMs, reused.ctimeMs]).toEqual([cached.ino, cached.mtimeMs, cached.ctimeMs]);
    const decoded = await exec(native, ["-v", "error", "-i", first.thumbnailPath!, "-f", "null", "-"]); expect(decoded.stderr).toBe("");
    const after = await fs.stat(reference);
    expect([after.size, after.mtimeMs, after.ctimeMs, digest(await fs.readFile(reference))]).toEqual([before.size, before.mtimeMs, before.ctimeMs, sha256]);
  });

  it.each(["failed-seek", "empty-seek", "bad-jpeg"])("falls back to a real first-frame output after %s without claiming an absent image", async mode => {
    const input = await fakeInput(mode), result = await inspectMedia(input, cache);
    expect(result.thumbnailPath).toBeTruthy(); expect(result.thumbnailError).toBeUndefined();
    expect(await fs.readFile(result.thumbnailPath!)).toEqual(await fs.readFile(reference));
    const invocations = await calls(); expect(invocations).toHaveLength(3);
    expect(invocations[1]).toContain("-ss"); expect(invocations[2]).not.toContain("-ss");
    expect(await fs.readFile(input, "utf8")).toBe("read-only synthetic source");
    expect((await fs.readdir(cache)).some(name => name.startsWith(".kocpy-thumbnail-"))).toBe(false);
  });

  it("does not call a persistent decoder failure successful or publish partial bytes", async () => {
    const result = await inspectMedia(await fakeInput("decoder-failed"), cache);
    expect(result.thumbnailPath).toBeUndefined(); expect(result.thumbnail).toBeUndefined();
    expect(result.thumbnailError).toContain("Invalid data found"); expect(await calls()).toHaveLength(3);
    expect(await fs.readdir(cache)).toEqual([]);
  });

  it("preserves a valid thumbnail when an optional waveform fails without returning partial waveform bytes", async () => {
    const input = await fakeInput("waveform-failed"), result = await inspectMedia(input, cache);
    expect(result.thumbnailPath).toBeTruthy(); expect(result.thumbnailError).toBeUndefined();
    expect(result.waveform).toBeUndefined(); expect(result.waveformPath).toBeUndefined();
    expect(result.waveformError).toContain("Audio decoder failure");
    expect(await fs.readFile(result.thumbnailPath!)).toEqual(await fs.readFile(reference));
    const cached = await inspectMedia(input, cache);
    expect(cached.thumbnailPath).toBe(result.thumbnailPath);
    expect(cached.waveform).toBeUndefined(); expect(cached.waveformPath).toBeUndefined();
    expect(cached.waveformError).toContain("PNG");
  });

  it("never follows a substituted cache symlink or overwrites its external target", async () => {
    const input = await fakeInput("good"), stat = await fs.stat(input);
    const key = createHash("sha1").update(input + stat.mtimeMs).digest("hex");
    await fs.mkdir(cache); const external = path.join(root, "must-remain.txt"); await fs.writeFile(external, "untouched");
    await fs.symlink(external, path.join(cache, `${key}-v2.jpg`));
    const result = await inspectMedia(input, cache);
    expect(result.thumbnailPath).toBeUndefined(); expect(result.thumbnailError).toBeTruthy();
    expect(await fs.readFile(external, "utf8")).toBe("untouched"); expect(await calls()).toHaveLength(1);
  });

  it("recovers from legacy zero-byte caches without deleting or overwriting the old entry", async () => {
    const input = await fakeInput("good"), stat = await fs.stat(input);
    const key = createHash("sha1").update(input + stat.mtimeMs).digest("hex");
    await fs.mkdir(cache); const legacy = path.join(cache, `${key}.jpg`); await fs.writeFile(legacy, "");
    const before = await fs.stat(legacy), result = await inspectMedia(input, cache);
    expect(result.thumbnailPath).toBe(path.join(cache, `${key}-v2.jpg`)); expect(result.thumbnailError).toBeUndefined();
    expect((await fs.stat(result.thumbnailPath!)).size).toBeGreaterThan(0);
    const after = await fs.stat(legacy); expect([after.size, after.ino, after.mtimeMs, after.ctimeMs]).toEqual([0, before.ino, before.mtimeMs, before.ctimeMs]);
  });

  it("honors cancellation before creating a cache or launching a media process", async () => {
    const input = await fakeInput("good"), controller = new AbortController(); controller.abort(new Error("before thumbnail"));
    await expect(inspectMedia(input, cache, { signal: controller.signal })).rejects.toThrow("before thumbnail");
    expect(await calls()).toEqual([]); expect(await fs.stat(cache).catch(() => undefined)).toBeUndefined();
  });

  it("waits for an aborted child to stop and cleans only its unfinished cache output", async () => {
    const input = await fakeInput("hang"), controller = new AbortController();
    const pending = inspectMedia(input, cache, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("during thumbnail");
    for (let attempt = 0; attempt < 100 && (await calls()).length < 2; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(await calls()).toHaveLength(2); controller.abort(new Error("during thumbnail"));
    await rejected; expect(await fs.readdir(cache)).toEqual([]); expect(await calls()).toHaveLength(2);
    expect(await fs.readFile(input, "utf8")).toBe("read-only synthetic source");
  });

  it("propagates the engine thumbnail-stage cancellation instead of recording a swallowed preview failure", async () => {
    const input = await fakeInput("hang"), controller = new AbortController(), engine = new BackupEngine(cache);
    const task: any = { generateThumbnails: true, fileRecords: [{ name: "clip.mp4", destinations: [{ verified: true, path: input }] }] };
    const pending = (engine as any).generateTaskThumbnails(task, controller.signal);
    const rejected = expect(pending).rejects.toThrow("engine thumbnail cancelled");
    for (let attempt = 0; attempt < 100 && (await calls()).length < 2; attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    expect(await calls()).toHaveLength(2); controller.abort(new Error("engine thumbnail cancelled"));
    await rejected; expect(task.thumbnailError).toBeUndefined(); expect(task.fileRecords[0].thumbnailPath).toBeUndefined();
    expect(await fs.readdir(cache)).toEqual([]); expect(await calls()).toHaveLength(2);
  });

  it("bounds a hung media process without silently retrying or publishing a result", async () => {
    const input = await fakeInput("hang"), start = Date.now();
    await expect(inspectMedia(input, cache)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(22000); expect(await calls()).toHaveLength(2);
    expect(await fs.readdir(cache)).toEqual([]);
  }, 25000);
});
