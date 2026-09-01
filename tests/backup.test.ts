import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { BackupEngine, SpeedMeter, hashFile, summarizeSpeeds } from "../src/main/backup/BackupEngine";
import { validatePaths, scan } from "../src/main/backup/safety";
import type { BackupTask, TaskConfig } from "../src/main/types";
let root: string, source: string, d1: string, d2: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "new-kocpy-test-"));
  source = path.join(root, "source");
  d1 = path.join(root, "one");
  d2 = path.join(root, "two");
  for (const p of [source, d1, d2]) await fs.mkdir(p);
  await fs.mkdir(path.join(source, "DCIM"));
  await fs.mkdir(path.join(source, "empty"));
  await fs.writeFile(
    path.join(source, "DCIM", "片段.bin"),
    randomBytes(128 * 1024),
  );
  await fs.writeFile(path.join(source, "zero.txt"), "");
  await fs.writeFile(path.join(source, ".DS_Store"), "system");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const config = (extra: Partial<TaskConfig> = {}): TaskConfig => ({
  name: "Test card",
  sourcePath: source,
  destinationPaths: [d1, d2],
  hashAlgorithm: "sha256",
  namingTemplate: "A001",
  devices: [],
  shootingDate: "",
  copyMode: "mirror",
  mirrorLayout: "contents", // Explicit legacy layout; new-task default is tested separately.
  ...extra,
});
function wait(engine: BackupEngine, id: string) {
  return new Promise<BackupTask>((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.cancelTask(id);
      reject(new Error("Task timed out"));
    }, 12000);
    const listener = (t: BackupTask) => {
      if (t.id === id) {
        clearTimeout(timer);
        engine.off("settled", listener);
        resolve(t);
      }
    };
    engine.on("settled", listener);
  });
}
async function run(cfg = config()) {
  const engine = new BackupEngine();
  const task = engine.createTask(cfg);
  const done = wait(engine, task.id);
  engine.startTask(task.id);
  return { task: await done, engine };
}
describe("Real filesystem backup integrity", () => {
  it("keeps the selected source folder for new mirrors, without renaming internal files", async () => {
    const renamed = path.join(root, "素材 : 原名");
    await fs.rename(source, renamed);
    const { task } = await run(config({ sourcePath: renamed, mirrorLayout: undefined }));
    expect(task.status).toBe("completed");
    expect(task.mirrorLayout).toBe("source-folder");
    expect(task.destinations[0].resolvedPath).toBe(await fs.realpath(path.join(d1, "素材 : 原名")));
    expect(await hashFile(path.join(d1, "素材 : 原名", "DCIM", "片段.bin"), "sha256")).toBe(task.fileRecords.find((record) => record.name === "片段.bin")!.srcChecksum);
    await expect(fs.access(path.join(d1, "DCIM"))).rejects.toThrow();
  });
  it("retains the exact contents layout when loading a legacy mirror task", async () => {
    const original = new BackupEngine().createTask(config({ mirrorLayout: undefined }));
    delete original.mirrorLayout;
    const engine = new BackupEngine();
    engine.loadTask(original);
    const done = wait(engine, original.id);
    engine.startTask(original.id);
    const task = await done;
    expect(task.status).toBe("completed");
    expect(task.destinations[0].resolvedPath).toBe(await fs.realpath(d1));
    expect(await fs.stat(path.join(d1, "DCIM", "片段.bin"))).toBeTruthy();
  });
  it("new mirror roots cannot escape through an existing symlink", async () => {
    await fs.symlink(source, path.join(d1, "source"));
    const { task } = await run(config({ mirrorLayout: undefined }));
    expect(task.status).toBe("failed");
    expect(task.destinations[0].verified).toBe(false);
    expect(task.destinations[1].verified).toBe(true);
  });
  it.each(["sha256", "sha1", "md5"] as const)("hashes fresh copies during fanout and independently verifies %s plus ASC MHL MD5", async (algorithm) => {
    const { task } = await run(config({ hashAlgorithm: algorithm }));
    expect(task.status).toBe("completed");
    for (const record of task.fileRecords) {
      expect(record.srcChecksum).toBe(await hashFile(path.join(source, record.relativePath), algorithm));
      expect(record.ascMhlMd5).toBe(await hashFile(path.join(source, record.relativePath), "md5"));
      expect(record.destinations.every((destination) => destination.verified)).toBe(true);
    }
  });
  it("reports byte progress inside one large file and never throttles pause/resume transitions", async () => {
    const single = path.join(root, "single");
    await fs.mkdir(single);
    await fs.writeFile(path.join(single, "large.bin"), randomBytes(16 * 1024 * 1024));
    const engine = new BackupEngine(), task = engine.createTask(config({ sourcePath: single }));
    const statuses: string[] = [];
    let paused = false, partial = false;
    engine.on("progress", (event) => {
      statuses.push(event.status);
      if (!paused && event.status === "running" && event.physicalWrittenBytes > 0) {
        partial = event.completedFiles === 0 && event.copyProgress > 0 && event.copyProgress < 100;
        paused = true;
        task.eta = 1800;
        task.verifyEta = 900;
        engine.pauseTask(task.id);
        expect(task.eta).toBe(0);
        expect(task.verifyEta).toBe(0);
        setTimeout(() => engine.resumeTask(task.id), 25);
      }
    });
    const done = wait(engine, task.id);
    engine.startTask(task.id);
    expect((await done).status).toBe("completed");
    expect(partial).toBe(true);
    const pauseIndex = statuses.indexOf("paused");
    expect(pauseIndex).toBeGreaterThan(0);
    expect(statuses[pauseIndex + 1]).toBe("running");
  });
  it("resumes the verification phase even when paused before its first byte", async () => {
    const engine = new BackupEngine(), task = engine.createTask(config());
    let paused = false, resumedStatus = "";
    engine.on("progress", (event) => {
      if (!paused && event.status === "verifying") {
        paused = true;
        engine.pauseTask(task.id);
        setTimeout(() => { engine.resumeTask(task.id); resumedStatus = task.status; }, 20);
      }
    });
    const done = wait(engine, task.id); engine.startTask(task.id);
    expect((await done).status).toBe("completed");
    expect(resumedStatus).toBe("verifying");
  });
  it("handles short writes without losing any part of a block", async () => {
    const open = fs.open.bind(fs);
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith(".partial")) {
        const write = handle.write.bind(handle);
        handle.write = ((buffer: Buffer, offset: number, length: number, position: number) => write(buffer, offset, Math.min(length, 32 * 1024), position)) as typeof handle.write;
      }
      return handle;
    });
    try { expect((await run()).task.status).toBe("completed"); }
    finally { spy.mockRestore(); }
  });
  it("samples acknowledged bytes on a fixed interval and decays smoothly during stalls", () => {
    const meter = new SpeedMeter(0);
    meter.add(50 * 1024 * 1024);
    const first = meter.sample(500);
    expect(first).toBeCloseTo(100 * 1024 * 1024, -3);
    meter.add(50 * 1024 * 1024);
    expect(meter.sample(1000)).toBeCloseTo(first, -3);
    const stalled = meter.sample(1500);
    expect(stalled).toBeGreaterThan(0);
    expect(stalled).toBeLessThan(first);
  });
  it("starts a new speed window after a pause without counting paused time or stale bytes", () => {
    const meter = new SpeedMeter(0);
    meter.add(1024 * 1024);
    expect(meter.sample(1000)).toBe(1024 * 1024);
    meter.add(123);
    meter.reset(61_000);
    expect(meter.sample(61_100)).toBe(0);
    meter.add(64 * 1024 * 1024);
    expect(meter.sample(62_000)).toBe(64 * 1024 * 1024);
  });
  it("summarizes raw speed samples without hiding stalls", () => {
    const summary = summarizeSpeeds([10_000, 20_000, 0, 30_000, 0]);
    expect(summary.average).toBe(20_000);
    expect(summary.peak).toBe(30_000);
    expect(summary.p50).toBe(20_000);
    expect(summary.stalls).toBe(2);
  });
  it("copies two destinations, empty files and directories, verifies every hash without changing source", async () => {
    const before = await fs.stat(path.join(source, "DCIM", "片段.bin")),
      emptyBefore = await fs.stat(path.join(source, "empty"));
    const { task } = await run();
    expect(task.status).toBe("completed");
    expect(task.totalFiles).toBe(2);
    expect(task.fileRecords).toHaveLength(2);
    expect(task.destinations.every((d) => d.verified)).toBe(true);
    for (const rec of task.fileRecords)
      for (const dest of rec.destinations) {
        expect(await hashFile(dest.path, "sha256")).toBe(rec.srcChecksum);
        expect(dest.verified).toBe(true);
      }
    const copiedEmpty = await fs.stat(path.join(d1, "empty"));
    expect(copiedEmpty.isDirectory()).toBe(true);
    expect(copiedEmpty.mode & 0o777).toBe(emptyBefore.mode & 0o777);
    expect(Math.abs(copiedEmpty.mtimeMs - emptyBefore.mtimeMs)).toBeLessThan(2);
    expect((await fs.stat(path.join(source, "DCIM", "片段.bin"))).mtimeMs).toBe(
      before.mtimeMs,
    );
    expect(task.transferredBytes).toBe(task.totalBytes);
    expect(task.destinations.every((d) => d.copiedBytes === task.totalBytes)).toBe(true);
    expect(task.verifyCompletedFiles).toBe(4);
    const copied = await fs.stat(path.join(d1, "DCIM", "片段.bin"));
    expect(Math.abs(copied.mtimeMs - before.mtimeMs)).toBeLessThan(2);
  });
  it("refuses to finish when a new source file appears after the initial scan", async () => {
    await fs.writeFile(
      path.join(source, "large.bin"),
      randomBytes(12 * 1024 * 1024),
    );
    const engine = new BackupEngine(),
      task = engine.createTask(config());
    let added = false;
    engine.on("progress", (payload) => {
      if (!added && (payload.physicalWrittenBytes || 0) > 0) {
        added = true;
        void fs.writeFile(path.join(source, "late-clip.mov"), "late media");
      }
    });
    const done = wait(engine, task.id);
    engine.startTask(task.id);
    expect((await done).status).toBe("failed");
    expect(task.errorMessage).toContain("素材源目录发生变化");
  });
  it("verifies existing files on first destination without stalling the second destination", async () => {
    await fs.cp(source, d1, { recursive: true });
    const { task } = await run();
    expect(task.status).toBe("completed");
    expect(task.destinations[0].bytesWritten).toBe(0);
    expect(task.destinations[1].bytesWritten).toBe(task.totalBytes);
    expect(task.fileRecords.every((r) => r.srcChecksum.length === 64)).toBe(
      true,
    );
  });
  it("preserves conflicting files and reports failure while other destination succeeds", async () => {
    await fs.mkdir(path.join(d1, "DCIM"));
    await fs.writeFile(path.join(d1, "DCIM", "片段.bin"), "keep me");
    const { task } = await run();
    expect(task.status).toBe("failed");
    expect(await fs.readFile(path.join(d1, "DCIM", "片段.bin"), "utf8")).toBe(
      "keep me",
    );
    expect(task.destinations[0].verified).toBe(false);
    expect(task.destinations[1].verified).toBe(true);
  });
  it("retries only failed destinations and preserves successful destination records", async () => {
    await fs.mkdir(path.join(d1, "DCIM"));
    await fs.writeFile(path.join(d1, "DCIM", "片段.bin"), "conflict");
    const engine = new BackupEngine(), task = engine.createTask(config());
    let done = wait(engine, task.id); engine.startTask(task.id); await done;
    expect(task.status).toBe("failed"); expect(task.destinations[1].verified).toBe(true);
    const successfulBytesWritten = task.destinations[1].bytesWritten;
    await fs.unlink(path.join(d1, "DCIM", "片段.bin"));
    done = wait(engine, task.id); engine.retryFailedDestinations(task.id); await done;
    expect(task.status).toBe("completed");
    expect(task.destinations.every((destination) => destination.verified)).toBe(true);
    expect(task.destinations[1].bytesWritten).toBe(successfulBytesWritten);
    expect(task.fileRecords.every((record) => record.destinations[1].verified)).toBe(true);
    expect(task.operationAttempts).toHaveLength(2);
    expect(task.operationAttempts?.map((item) => item.reason)).toEqual([
      "initial",
      "retry-failed",
    ]);
    expect(task.operationAttempts?.every((item) => item.completedAt)).toBe(true);
    expect(task.operationAttempts?.at(-1)?.status).toBe("completed");
    const completedAttempts = structuredClone(task.operationAttempts);
    await engine.reverifyTask(task.id);
    expect(task.operationAttempts).toEqual(completedAttempts);
  });
  it("creates a unique suffixed copy for a different existing file", async () => {
    await fs.mkdir(path.join(d1, "DCIM"));
    await fs.writeFile(path.join(d1, "DCIM", "片段.bin"), "keep me");
    const { task } = await run(config({ duplicateStrategy: "suffix" }));
    expect(task.status).toBe("completed");
    expect(await fs.readFile(path.join(d1, "DCIM", "片段.bin"), "utf8")).toBe(
      "keep me",
    );
    expect(
      task.fileRecords.find((f) => f.name === "片段.bin")!.destinations[0].path,
    ).toContain("_copy_1");
  });
  it("rejects identical and nested source/destinations including symlink aliases", async () => {
    await expect(validatePaths(source, [source])).rejects.toThrow("不能相同");
    await expect(
      validatePaths(source, [path.join(source, "nested")]),
    ).rejects.toThrow("不能相同");
    await fs.symlink(source, path.join(root, "alias"));
    await expect(
      validatePaths(source, [path.join(root, "alias")]),
    ).rejects.toThrow("不能相同");
    await expect(
      validatePaths(source, [d1, path.join(d1, "nested")]),
    ).rejects.toThrow("目的地不能重复");
  });
  it("does not write through a destination directory symlink into the source", async () => {
    await fs.symlink(path.join(source, "DCIM"), path.join(d1, "DCIM"));
    const before = await hashFile(
      path.join(source, "DCIM", "片段.bin"),
      "sha256",
    );
    const { task } = await run();
    expect(task.status).toBe("failed");
    expect(
      await hashFile(path.join(source, "DCIM", "片段.bin"), "sha256"),
    ).toBe(before);
  });
  it("fails explicitly on source symlinks instead of silently omitting media", async () => {
    await fs.symlink(path.join(source, "DCIM"), path.join(source, "linked"));
    await expect(scan(source)).rejects.toThrow("符号链接");
  });
  it("cancel never reports success and retry re-verifies complete files", async () => {
    await fs.writeFile(
      path.join(source, "large.bin"),
      randomBytes(24 * 1024 * 1024),
    );
    const engine = new BackupEngine();
    const task = engine.createTask(config());
    let cancelled = false;
    engine.on("progress", (p) => {
      if (!cancelled && p.transferredBytes > 0) {
        cancelled = true;
        engine.cancelTask(task.id);
      }
    });
    const done = wait(engine, task.id);
    engine.startTask(task.id);
    expect((await done).status).toBe("cancelled");
    expect(task.destinations.every((d) => !d.verified)).toBe(true);
    const retry = wait(engine, task.id);
    engine.startTask(task.id);
    expect((await retry).status).toBe("completed");
    expect(task.completedFiles).toBe(task.totalFiles);
    expect(task.fileRecords).toHaveLength(task.totalFiles);
  });
  it("rejects duplicate starts and protects running task records", async () => {
    const engine = new BackupEngine();
    const task = engine.createTask(config());
    const done = wait(engine, task.id);
    engine.startTask(task.id);
    expect(() => engine.startTask(task.id)).toThrow("队列");
    expect(() => engine.deleteTask(task.id)).toThrow("先取消");
    await done;
  });
  it("retries failed queue items without blocking the following task", async () => {
    const engine = new BackupEngine();
    const bad = engine.createTask(
      config({ sourcePath: path.join(root, "missing") }),
    );
    const good = engine.createTask(config());
    const bd = wait(engine, bad.id),
      gd = wait(engine, good.id);
    engine.startTask(bad.id);
    engine.startTask(good.id);
    expect((await bd).status).toBe("failed");
    expect((await gd).status).toBe("completed");
  });
  it("keeps additional destination files in directory mode", async () => {
    await fs.writeFile(path.join(d1, "keep.txt"), "valuable");
    const { task } = await run();
    expect(task.status).toBe("completed");
    expect(await fs.readFile(path.join(d1, "keep.txt"), "utf8")).toBe(
      "valuable",
    );
  });
  it("creates the stable project-start/day/device/card hierarchy", async () => {
    const cfg = config({
      copyMode: "normal",
      projectName: "品牌短片",
      projectStartDate: "2026-08-27",
      shootingDate: "2026-08-27",
      devices: ["A机"],
      projectId: "project",
    });
    const { task } = await run(cfg);
    expect(task.status).toBe("completed");
    expect(task.destinations[0].resolvedPath).toContain(
      "20260827_品牌短片/20260827/A机/A001",
    );
    const second = new BackupEngine().createTask(cfg);
    expect(second.namingTemplate).toBe(task.namingTemplate);
  });
  it("does not mark empty source directories as verified backups", async () => {
    const empty = path.join(root, "nothing");
    await fs.mkdir(empty);
    const { task } = await run(config({ sourcePath: empty }));
    expect(task.status).toBe("failed");
    expect(task.errorMessage).toContain("没有可备份");
  });
  it("never accepts unsupported algorithms or zero destinations", () => {
    expect(() =>
      new BackupEngine().createTask(config({ hashAlgorithm: "xxhash" as any })),
    ).toThrow("不支持");
    expect(() =>
      new BackupEngine().createTask(config({ destinationPaths: [] })),
    ).toThrow("1–4");
  });
  it("supports filesystems without hard links using exclusive publication", async () => {
    const link = vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("not supported"), {code:"ENOTSUP"}));
    try { const {task} = await run(); expect(task.status).toBe("completed"); expect(task.destinations.every(d => d.verified)).toBe(true); }
    finally { link.mockRestore(); }
  });
  it("recovers only its own incomplete temporary file after an interrupted run", async () => {
    const engine = new BackupEngine(); const task = engine.createTask(config());
    await fs.mkdir(path.join(d1,"DCIM"));
    const partial = path.join(d1,"DCIM",`片段.bin.kocpy-${task.id}.partial`);
    await fs.writeFile(partial,"interrupted data");
    const done=wait(engine,task.id);engine.startTask(task.id);
    expect((await done).status).toBe("completed");
    await expect(fs.access(partial)).rejects.toThrow();
  });
  it("pauses and resumes without losing its checkpoint and exposes real byte progress", async () => {
    await fs.writeFile(path.join(source, "pause.bin"), randomBytes(20 * 1024 * 1024));
    const engine = new BackupEngine(), task = engine.createTask(config());
    let paused = false, sawPhysicalBytes = false, sawVerifyPhase = false;
    engine.on("progress", (p) => {
      sawPhysicalBytes ||= (p.physicalWrittenBytes || 0) > 0;
      sawVerifyPhase ||= p.status === "verifying";
      if (!paused && p.status === "running" && (p.physicalWrittenBytes || 0) > 0) {
        paused = true; engine.pauseTask(task.id); setTimeout(() => engine.resumeTask(task.id), 20);
      }
    });
    const done = wait(engine, task.id); engine.startTask(task.id);
    expect((await done).status).toBe("completed");
    expect(paused).toBe(true); expect(sawPhysicalBytes).toBe(true); expect(sawVerifyPhase).toBe(true);
    expect(task.copyProgress).toBe(100); expect(task.verifyProgress).toBe(100);
  });
  it("keeps each destination byte counter monotonic across differently sized files", async () => {
    await fs.writeFile(path.join(source, "small.bin"), randomBytes(32 * 1024));
    await fs.writeFile(path.join(source, "large.bin"), randomBytes(3 * 1024 * 1024));
    const engine = new BackupEngine(), task = engine.createTask(config());
    const samples = new Map<string, number[]>();
    engine.on("progress", (payload) => {
      for (const destination of payload.destinations) samples.set(destination.id, [...(samples.get(destination.id) || []), destination.copiedBytes || 0]);
    });
    const done = wait(engine, task.id); engine.startTask(task.id); await done;
    for (const destination of task.destinations) {
      const values = samples.get(destination.id) || [];
      expect(values.every((value, index) => !index || value >= values[index - 1])).toBe(true);
      expect(destination.copiedBytes).toBe(task.totalBytes);
    }
  });
  it("isolates a destination preflight failure and completes the healthy target", async () => {
    const blocker = path.join(root, "not-a-directory"); await fs.writeFile(blocker, "x");
    const { task } = await run(config({ destinationPaths: [path.join(blocker, "bad"), d2] }));
    expect(task.status).toBe("failed");
    expect(task.destinations[0].available).toBe(false);
    expect(task.destinations[0].error).toContain("预检失败");
    expect(task.destinations[1].verified).toBe(true);
    expect(await hashFile(path.join(d2, "DCIM", "片段.bin"), "sha256")).toBe(task.fileRecords.find((f) => f.name === "片段.bin")!.srcChecksum);
  });
});
