import { it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { makeProxy } from "../src/main/proxy";
import { ffmpegPath } from "../src/main/ffmpeg";
import { BackupEngine } from "../src/main/backup/BackupEngine";
const exec = promisify(execFile);
const ffmpeg = ffmpegPath();
it("attaches a generated thumbnail to the verified backup file record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-backup-thumb-"));
  try {
    const source = path.join(root, "source"), destination = path.join(root, "destination"), thumbnails = path.join(root, "thumbnails");
    await Promise.all([fs.mkdir(source), fs.mkdir(destination)]);
    await exec(ffmpeg!, ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-t", "2", "-c:v", "libx264", path.join(source, "clip.mp4")]);
    const engine = new BackupEngine(thumbnails);
    const task = engine.createTask({ name: "thumb", sourcePath: source, destinationPaths: [destination], devices: [], hashAlgorithm: "sha256", namingTemplate: "thumb", shootingDate: "", copyMode: "mirror" });
    const settled = new Promise<any>((resolve) => engine.once("settled", resolve));
    engine.startTask(task.id);
    const result = await settled;
    expect(result.status).toBe("completed");
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
