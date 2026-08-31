// Run with the final packaged Electron in Node mode; never touches user media.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
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
