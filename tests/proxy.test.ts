import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import ffmpeg from "ffmpeg-static";
import { makeProxy } from "../src/main/proxy";
const exec = promisify(execFile);
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
