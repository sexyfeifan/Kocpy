import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { BackupEngine, SpeedMeter, hashFile } from "../src/main/backup/BackupEngine";
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
  it("copies two destinations, empty files and directories, verifies every hash without changing source", async () => {
    const before = await fs.stat(path.join(source, "DCIM", "片段.bin"));
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
    expect((await fs.stat(path.join(d1, "empty"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(source, "DCIM", "片段.bin"))).mtimeMs).toBe(
      before.mtimeMs,
    );
    expect(task.transferredBytes).toBe(task.totalBytes);
    expect(task.destinations.every((d) => d.copiedBytes === task.totalBytes)).toBe(true);
    expect(task.verifyCompletedFiles).toBe(4);
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
