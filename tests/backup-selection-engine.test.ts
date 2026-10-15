import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { analyzeBackupSelection, finalizeBackupSelection } from "../src/main/backup-selection";
import { BackupEngine, hashFile } from "../src/main/backup/BackupEngine";
import { scan, completeInventoryPolicy } from "../src/main/backup/safety";
import { volumeIdentity } from "../src/main/system";
import { taskTrustState } from "../src/common/task-trust";
import { detectBackupSelectionMarker } from "../src/main/backup-selection-marker";
import { previewExistingBackup } from "../src/main/production-lifecycle";
import type { BackupTask, TaskConfig } from "../src/main/types";

let root: string, source: string, destinations: string[];
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-selection-engine-")));
  source = path.join(root, "source"); destinations = [path.join(root, "one"), path.join(root, "two")];
  for (const folder of [source, ...destinations, path.join(source, "MEDIA"), path.join(source, "XML"), path.join(source, "empty")]) await fs.mkdir(folder);
  for (const [name, value] of Object.entries({ "MEDIA/clip_20261014.mp4": "old media", "XML/clip_20261014.xml": "old companion", "MEDIA/clip_20261015.mp4": "today media", "XML/clip_20261015.xml": "today companion", ".unknown": "preserve unknown", "shared.idx": "preserve index" })) await fs.writeFile(path.join(source, name), value);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function selectedConfig(): Promise<TaskConfig> {
  const deps = { identifyVolume: volumeIdentity };
  const preview = await analyzeBackupSelection({ sourcePath: source }, deps);
  const plan = await finalizeBackupSelection(preview, { selectedDates: ["2026-10-15"], operator: "Generated fixture DIT", allowUnprotectedExclusions: true }, deps);
  expect(plan.excludedFiles.map((file) => file.relativePath).sort()).toEqual(["MEDIA/clip_20261014.mp4", "XML/clip_20261014.xml"]);
  return { name: "selected fixture", namingTemplate: "selected fixture", sourcePath: source, destinationPaths: destinations, devices: [], shootingDate: "2026-10-15", hashAlgorithm: "sha256", selection: plan, copyMode: "mirror", generateThumbnails: false };
}
function run(engine: BackupEngine, task: BackupTask) {
  const result = new Promise<BackupTask>((resolve, reject) => {
    const timer = setTimeout(() => { engine.cancelTask(task.id); reject(new Error("selected scope timed out")); }, 90_000);
    engine.once("settled", (value) => { clearTimeout(timer); resolve(value); });
  });
  engine.startTask(task.id); return result;
}
async function snapshot() {
  const inventory = await scan(source, completeInventoryPolicy(true));
  return { fingerprint: inventory.scope!.fingerprint, hashes: await Promise.all(inventory.files.map(async (file) => [file.relativePath, await hashFile(file.absolutePath, "sha256")])) };
}
// These cases execute diskutil, full source validation and two target rereads,
// unlike mocked unit cases. Allow concurrent CI workers to finish those checks.
describe("selected scopes use the real copy and independent-readback executor", { timeout: 120_000 }, () => {
  it("copies complete selected families, unknown/shared files and empty directories to two targets without touching source", async () => {
    const config = await selectedConfig(), before = await snapshot(), engine = new BackupEngine(), task = engine.createTask(config);
    const progressPayloads: unknown[] = [];
    engine.on("progress", (payload) => { progressPayloads.push(payload); });
    expect(task.totalFiles).toBe(4);
    expect(task.inventoryScope!.fingerprint).not.toBe(task.selection!.sourceScope.fingerprint);
    const completed = await run(engine, task);
    expect(completed.status).toBe("completed");
    expect(completed.fileRecords).toHaveLength(4);
    for (const destination of completed.destinations) {
      expect(destination.verified).toBe(true);
      expect((await detectBackupSelectionMarker(destination.resolvedPath!)).detected).toBe(true);
      await expect(previewExistingBackup(destination.resolvedPath!)).rejects.toThrow(/选定范围备份声明/);
      expect((await fs.stat(path.join(destination.resolvedPath!, "empty"))).isDirectory()).toBe(true);
      await expect(fs.access(path.join(destination.resolvedPath!, "MEDIA/clip_20261014.mp4"))).rejects.toThrow();
      for (const relative of completed.selection!.includedPaths) expect(await hashFile(path.join(destination.resolvedPath!, relative), "sha256")).toBe(await hashFile(path.join(source, relative), "sha256"));
    }
    expect(taskTrustState(completed).contentVerified).toBe(true);
    expect(taskTrustState(completed).countableCopies).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(progressPayloads.length).toBeGreaterThan(0);
    expect(progressPayloads.every((payload) => !Object.hasOwn(payload as object, "selection"))).toBe(true);
    expect(task.selection).toBeDefined();
    const loaded = new BackupEngine(); loaded.loadTask(structuredClone(completed));
    const reverified = await loaded.reverifyTask(task.id);
    expect(reverified.status).toBe("completed"); expect(taskTrustState(reverified).countableCopies).toBe(0);
  });
  it("leaves a scope warning after cancellation so an interrupted partial directory cannot be adopted as a full card", async () => {
    const config = await selectedConfig(), before = await snapshot(), engine = new BackupEngine(), task = engine.createTask(config);
    let cancelled = false;
    engine.on("progress", (payload) => {
      if (!cancelled && payload.status === "running" && payload.completedFiles >= 1) {
        cancelled = true; engine.cancelTask(task.id);
      }
    });
    const completed = await run(engine, task);
    expect(cancelled).toBe(true); expect(completed.status).toBe("cancelled");
    for (const destination of completed.destinations) {
      expect((await detectBackupSelectionMarker(destination.resolvedPath!)).detected).toBe(true);
      await expect(previewExistingBackup(destination.resolvedPath!)).rejects.toThrow(/选定范围/);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("stops before writing when even an excluded source file changes after confirmation", async () => {
    const config = await selectedConfig(), engine = new BackupEngine(), task = engine.createTask(config);
    await fs.writeFile(path.join(source, "MEDIA/clip_20261014.mp4"), "changed excluded original");
    const completed = await run(engine, task);
    expect(completed.status).toBe("failed"); expect(completed.fileRecords).toHaveLength(0);
    for (const destination of destinations) expect(await fs.readdir(destination)).toEqual([]);
  });
  it("freezes a selected scope immediately so an older engine ignoring selection cannot copy a larger source", async () => {
    const config = await selectedConfig(), engine = new BackupEngine(), task = engine.createTask(config);
    delete task.selection;
    const completed = await run(engine, task);
    expect(completed.status).toBe("failed"); expect(completed.errorMessage).toContain("冻结的快照");
    for (const destination of destinations) expect(await fs.readdir(destination)).toEqual([]);
  });
  it("does not allow a token's plan to be rebound to another source/project or hidden-filter mode", async () => {
    const config = await selectedConfig(), engine = new BackupEngine();
    expect(() => engine.createTask({ ...config, projectId: "other" })).toThrow(/不一致/);
    expect(() => engine.createTask({ ...config, sourcePath: destinations[0] })).toThrow(/不一致/);
    expect(() => engine.createTask({ ...config, includeHidden: false })).toThrow(/关联文件/);
  });
  it("rejects derivative sources for ordinary, project and explicitly analyzed backups before destination writes", async () => {
    await fs.mkdir(path.join(source, "Kocpy报告"));
    await fs.writeFile(path.join(source, "Kocpy报告/选定范围_older.json"), "damaged declaration still preserves scope");
    const selected = await selectedConfig(), before = await snapshot();
    for (const mode of ["ordinary", "project", "selected"] as const) {
      const engine = new BackupEngine(), config = { ...selected,
        selection: mode === "selected" ? selected.selection : undefined,
        ...(mode === "project" ? { projectId: "fixture-project", projectName: "Synthetic", devices: ["A"] } : {}),
      };
      const completed = await run(engine, engine.createTask(config));
      expect(completed.status).toBe("failed");
      expect(completed.errorMessage).toContain("不是原始整卡");
      expect(completed.fileRecords).toHaveLength(0);
      for (const destination of destinations) expect(await fs.readdir(destination)).toEqual([]);
    }
    expect(await snapshot()).toEqual(before);
  });
  it("rejects daily-delivery markers even when ordinary hidden-file copying is disabled", async () => {
    const config = await selectedConfig();
    await fs.writeFile(path.join(source, ".kocpy-daily-delivery.journal.ndjson"), "interrupted derived delivery");
    const engine = new BackupEngine();
    const completed = await run(engine, engine.createTask({ ...config, selection: undefined, includeHidden: false }));
    expect(completed.status).toBe("failed"); expect(completed.errorMessage).toContain("独立归档转存");
    for (const destination of destinations) expect(await fs.readdir(destination)).toEqual([]);
  });
  it("keeps a real partial backup's scope when its inner media directory is selected as a new source", async () => {
    const config = await selectedConfig(), original = await snapshot(), engine = new BackupEngine();
    const partial = await run(engine, engine.createTask(config));
    expect(partial.status).toBe("completed");
    expect(taskTrustState(partial).countableCopies).toBe(0);
    const innerSource = path.join(partial.destinations[0].resolvedPath!, "MEDIA");
    const destination = path.join(root, "third"); await fs.mkdir(destination);
    const innerBefore = await fs.readFile(path.join(innerSource, "clip_20261015.mp4"));
    await expect(previewExistingBackup(innerSource)).rejects.toThrow(/选定范围/);
    const next = new BackupEngine();
    const result = await run(next, next.createTask({ ...config, selection: undefined,
      sourcePath: innerSource, destinationPaths: [destination], name: "inner derivative" }));
    expect(result.status).toBe("failed"); expect(result.errorMessage).toContain("不是原始整卡");
    expect(result.fileRecords).toHaveLength(0); expect(taskTrustState(result).countableCopies).toBe(0);
    expect(await fs.readdir(destination)).toEqual([]);
    expect(await fs.readFile(path.join(innerSource, "clip_20261015.mp4"))).toEqual(innerBefore);
    expect(await snapshot()).toEqual(original);
  });
  it("checks derivative scope again before completion if a marker appears after scanning", async () => {
    const config = await selectedConfig(), engine = new BackupEngine();
    const task = engine.createTask({ ...config, selection: undefined });
    let injected = false;
    engine.on("progress", (payload) => {
      if (!injected && payload.status === "running" && payload.completedFiles >= 1) {
        injected = true;
        writeFileSync(path.join(source, ".kocpy-daily-delivery.json"), "synthetic concurrent source change");
      }
    });
    const completed = await run(engine, task);
    expect(injected).toBe(true); expect(completed.status).toBe("failed");
    expect(completed.errorMessage).toContain("不是原始整卡");
    expect(taskTrustState(completed).countableCopies).toBe(0);
  });
  it("fails final verification when a parent derivative declaration appears during copying", async () => {
    const config = await selectedConfig(), engine = new BackupEngine();
    const task = engine.createTask({ ...config, selection: undefined, sourcePath: path.join(source, "MEDIA") });
    let injected = false;
    engine.on("progress", (payload) => {
      if (!injected && payload.status === "running" && payload.completedFiles >= 1) {
        injected = true;
        writeFileSync(path.join(source, ".kocpy-daily-delivery.json"), "synthetic ancestor scope appearing during copy");
      }
    });
    const result = await run(engine, task);
    expect(injected).toBe(true); expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("不是原始整卡");
    expect(taskTrustState(result).countableCopies).toBe(0);
  });
});
