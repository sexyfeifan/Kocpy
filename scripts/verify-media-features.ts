// Run with the final packaged Electron in Node mode; never touches user media.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffmpegPath } from "../src/main/ffmpeg";
import { makeProxy } from "../src/main/proxy";
import { inspectMedia } from "../src/main/media";
const exec = promisify(execFile);
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-media-runtime-"));
  const binary = ffmpegPath(), cases: string[] = [];
  try {
    const input = path.join(root, "synthetic.mp4");
    await exec(binary, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-c:a", "aac", input]);
    const metadata = await inspectMedia(input, path.join(root, "cache"));
    assert.equal(metadata.frameRate, "24");
    assert(metadata.duration?.includes("00:00:02"));
    assert(metadata.audio?.includes("aac"));
    for (const image of [metadata.thumbnailPath, metadata.waveformPath]) {
      assert(image); assert((await fs.stat(image)).size > 0);
    }
    cases.push("metadata, thumbnail, waveform, AAC decode");
    // Real one-second clips previously sought to EOF; verify both the boundary
    // and a sub-second clip with the exact final bundled runtime.
    for (const duration of ["0.25", "1"]) {
      const clip = path.join(root, `short-${duration}.mp4`);
      await exec(binary, ["-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", duration, "-c:v", "libx264", clip]);
      const before = createHash("sha256").update(await fs.readFile(clip)).digest("hex");
      const inspected = await inspectMedia(clip, path.join(root, "short-cache"));
      assert(inspected.thumbnailPath); assert.equal(inspected.thumbnailError, undefined);
      const decoded = await exec(binary, ["-v", "error", "-i", inspected.thumbnailPath, "-f", "null", "-"]);
      assert.equal(decoded.stderr, "");
      assert.equal(createHash("sha256").update(await fs.readFile(clip)).digest("hex"), before);
      cases.push(`${duration}s short clip: thumbnail full decode; source SHA256 unchanged`);
    }
    const still = path.join(root, "still.jpg");
    await exec(binary, ["-nostdin", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-frames:v", "1", "-update", "1", still]);
    const stillSha = createHash("sha256").update(await fs.readFile(still)).digest("hex");
    const inspectedStill = await inspectMedia(still, path.join(root, "still-cache"));
    assert(inspectedStill.thumbnailPath); assert.equal(inspectedStill.thumbnailError, undefined);
    assert.equal((await exec(binary, ["-v", "error", "-i", inspectedStill.thumbnailPath, "-f", "null", "-"])).stderr, "");
    assert.equal(createHash("sha256").update(await fs.readFile(still)).digest("hex"), stillSha);
    cases.push("still JPEG: first-frame thumbnail full decode; source SHA256 unchanged");
    for (const [format, container] of [["h264", "mp4"], ["h264", "mov"], ["h264", "mkv"], ["prores", "mov"]] as const) {
      const result = await makeProxy(input, path.join(root, "proxy"), format, "720p", { container });
      assert(result.size > 0);
      const decode = await exec(binary, ["-v", "error", "-i", result.outputPath, "-f", "null", "-"]);
      assert.equal(decode.stderr, "");
      cases.push(`${format}/${container}: encode and full decode`);
    }
    const abort = new AbortController(); abort.abort(new Error("synthetic cancellation"));
    await assert.rejects(makeProxy(input, path.join(root, "cancelled"), "h264", "720p", { signal: abort.signal }), /synthetic cancellation/);
    assert.equal(await fs.stat(path.join(root, "cancelled")).then(() => true, () => false), false);
    cases.push("pre-cancel does not publish");
    console.log(JSON.stringify({ arch: process.arch, runtime: process.versions, cases, passed: true }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
