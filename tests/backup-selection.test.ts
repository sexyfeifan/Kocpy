import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import type { BackupTask } from "../src/main/types";
import type { VolumeIdentity } from "../src/common/volume-identity";
import type { StorageEvidence } from "../src/common/copy-evidence";
import type { BackupSelectionPlan, BackupSelectionPreview } from "../src/common/backup-selection";
import { conservativeSelectionFamilies } from "../src/common/backup-selection";
import { scan } from "../src/main/backup/safety";
import { analyzeBackupSelection, finalizeBackupSelection, validateBackupSelectionPlan,
  applyBackupSelectionInventory, assertBackupSelectionStructure, backupSelectionScope, inspectBackupDates,
  type BackupSelectionDependencies } from "../src/main/backup-selection";

let directory: string, source: string;
const dateOne = "2026-10-14", dateTwo = "2026-10-15";
let dates: Map<string, string>;
let volumes: Map<string, VolumeIdentity>;
let deps: BackupSelectionDependencies;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sign = <T extends BackupSelectionPreview>(value: T): T => {
  const { digest: _digest, ...rest } = value;
  value.digest = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
  return value;
};
const volume = (id: string): VolumeIdentity => ({ id, uuid: `volume-${id}`, name: id, device: id });
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-backup-selection-")));
  source = path.join(directory, "source"); await fs.mkdir(source);
  dates = new Map(); volumes = new Map([[source, volume("source")]]);
  deps = {
    identifyVolume: async (target) => {
      const entry = [...volumes.entries()].sort((a, b) => b[0].length - a[0].length).find(([root]) => target === root || target.startsWith(`${root}/`));
      if (!entry) throw new Error("offline fixture");
      return structuredClone(entry[1]);
    },
    readEmbeddedDate: async (absolute) => dates.get(path.relative(source, absolute)),
    assessStorage: async (paths): Promise<StorageEvidence[]> => paths.map((target, index) => ({
      kind: "local-physical", assessmentId: "isolated-simulated-topology", checkedAt: Date.now(),
      domains: [`disk${index + 1}`], volumeUuid: volumes.get(target)?.uuid, reason: "test fixture only",
    })),
  };
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
async function put(relative: string, date?: string, content = relative) {
  const target = path.join(source, relative); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content); if (date) dates.set(relative, date); return target;
}
async function history(sourceRelative: string, targetName = "history", options: { projectId?: string; verified?: boolean; content?: string } = {}): Promise<BackupTask> {
  const root = path.join(directory, targetName); await fs.mkdir(root, { recursive: true }); volumes.set(root, volume(targetName));
  const content = await fs.readFile(path.join(source, sourceRelative)), checksum = createHash("sha256").update(content).digest("hex");
  const destinationPath = path.join(root, sourceRelative); await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, options.content ?? content);
  return { id: `task-${targetName}`, projectId: options.projectId || "project", status: "completed", hashAlgorithm: "sha256",
    destinations: [{ id: targetName, path: root, resolvedPath: root, label: targetName, verified: options.verified ?? true,
      bytesWritten: content.length, volumeUuid: volume(targetName).uuid, volumeId: targetName }],
    fileRecords: [{ name: path.basename(sourceRelative), relativePath: sourceRelative, size: content.length, srcChecksum: checksum,
      destinations: [{ path: destinationPath, checksum, verified: options.verified ?? true }] }],
  } as BackupTask;
}
async function preview(historyTasks: BackupTask[] = [], requiredCopies = 1) {
  return analyzeBackupSelection({ sourcePath: source, projectId: "project", requiredCopies, historyTasks }, deps);
}
const chooseToday = (value: BackupSelectionPreview, allow = true) => finalizeBackupSelection(value,
  { selectedDates: [dateTwo], operator: "Fixture Operator", allowUnprotectedExclusions: allow, skipVerifiedHistory: true }, deps);

describe("read-only mixed-date backup selection", () => {
  it("offers a lightweight date inspection without reading hashes or claiming historical coverage", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const open = vi.spyOn(fs, "open");
    const advice = await inspectBackupDates({ sourcePath: source }, deps);
    expect(advice.dates).toEqual([dateOne, dateTwo]); expect(advice.sourceFiles).toBe(2);
    expect(advice.groups.every((group) => group.historyState === "not-found")).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("selects whole clip families across directories and retains original manifests, unknowns and empty directories", async () => {
    await put("CLIP/old.mov", dateOne); await put("META/old.xml");
    await put("CLIP/new.mov", dateTwo); await put("PROXY/new.lrf");
    await put("original.mhl"); await put("camera-index.bin"); await fs.mkdir(path.join(source, "empty"));
    const before = await fs.stat(path.join(source, "CLIP/old.mov"));
    const value = await preview(), plan = await chooseToday(value);
    expect(plan.includedPaths).toEqual(["CLIP/new.mov", "PROXY/new.lrf", "camera-index.bin", "original.mhl"]);
    expect(plan.excludedFiles.map((item) => item.relativePath)).toEqual(["CLIP/old.mov", "META/old.xml"]);
    expect(plan.excludedFiles.every((item) => item.reason === "user-date")).toBe(true);
    expect(plan.wholeCardCovered).toBe(false);
    const original = await validateBackupSelectionPlan(plan, deps), selected = applyBackupSelectionInventory(original, plan);
    expect(selected.files.map((file) => file.relativePath).sort()).toEqual(plan.includedPaths);
    expect(selected.directories).toContain("empty"); expect(selected.scope).toEqual(backupSelectionScope(plan));
    expect(selected.scope!.fingerprint).not.toBe(value.sourceScope.fingerprint);
    expect(plan.sourceScope.includedFiles).toBe(6);
    expect(await fs.readFile(path.join(source, "CLIP/old.mov"), "utf8")).toBe("CLIP/old.mov");
    const after = await fs.stat(path.join(source, "CLIP/old.mov"));
    expect([after.mtimeMs, after.ctimeMs, after.size]).toEqual([before.mtimeMs, before.ctimeMs, before.size]);
  });

  it("does not silently omit an older date with no healthy historical copy", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    await expect(chooseToday(await preview(), false)).rejects.toThrow("未选日期");
  });

  it("keeps an entire camera package and unassigned sidecars even when its date is unselected", async () => {
    await put("PRIVATE/M4ROOT/CLIP/old.mov", dateOne); await put("PRIVATE/M4ROOT/INDEX.XML");
    await put("orphan.xml"); await put("new.mov", dateTwo);
    const plan = await chooseToday(await preview());
    expect(plan.excludedFiles).toHaveLength(0); expect(plan.wholeCardCovered).toBe(true);
    expect(plan.groups.find((group) => group.relativePaths.includes("PRIVATE/M4ROOT/CLIP/old.mov"))?.mandatory).toBe(true);
  });

  it("keeps camera packages when the selected source itself is inside that package", async () => {
    const parent = source; source = path.join(parent, "PRIVATE", "M4ROOT", "CLIP"); await fs.mkdir(source, { recursive: true });
    volumes.set(source, volume("source"));
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const plan = await chooseToday(await preview()); expect(plan.excludedFiles).toHaveLength(0);
  });

  it("stops probing a large camera package immediately after cancellation of one metadata probe", async () => {
    for (const name of ["one.mp4", "two.mp4", "three.mp4", "four.mp4"]) await put(`PRIVATE/${name}`, dateTwo);
    const controller = new AbortController();
    const probe = vi.fn(async () => { controller.abort(); return dateTwo; });
    await expect(inspectBackupDates({ sourcePath: source }, { ...deps, signal: controller.signal, readEmbeddedDate: probe })).rejects.toThrow();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retains cross-midnight and date-conflict families instead of separating related files", async () => {
    await put("CLIP/clip.mov", dateOne); await put("PROXY/clip.mp4", dateTwo);
    await put("20261014/conflict.mov", dateTwo); await put("new.mov", dateTwo);
    const plan = await chooseToday(await preview());
    expect(plan.excludedFiles).toHaveLength(0);
    expect(plan.groups.filter((group) => group.mandatory)).toHaveLength(2);
  });

  it("does not split differently dated proxy/preview/thumb/duplicate variants from selected original media", async () => {
    await put("CLIP/C001.MOV", dateTwo);
    for (const relative of ["PROXY/C001_proxy.MP4", "PREVIEW/C001-preview.MP4", "THUMB/C001_thumb.JPG", "COPY/C001 (1).MOV"])
      await put(relative, dateOne);
    await put("META/C001_proxy (1).XML"); await put("old-unrelated.mov", dateOne);
    const plan = await chooseToday(await preview());
    expect(plan.includedPaths).toEqual(["CLIP/C001.MOV", "COPY/C001 (1).MOV", "META/C001_proxy (1).XML", "PREVIEW/C001-preview.MP4", "PROXY/C001_proxy.MP4", "THUMB/C001_thumb.JPG"]);
    expect(plan.excludedFiles.map((file) => file.relativePath)).toEqual(["old-unrelated.mov"]);
    expect(plan.groups.find((group) => group.relativePaths.includes("CLIP/C001.MOV"))?.mandatory).toBe(true);
  });

  it("preserves legacy named derivatives and Sony metadata under chained suffixes", () => {
    const paths = ["CLIP/C0001.MP4", "META/C0001M01_proxy.XML", "PROXY/C0001.prox.MP4",
      "PREVIEW/C0001-preview.MP4", "THUMB/C0001_thumbnail.JPG", "COPY/C0001(1)_proxy(2).MP4"];
    expect(conservativeSelectionFamilies(paths)).toEqual([{ relativePaths: paths.sort(), packageProtected: false }]);
  });

  it("keeps differently named external audio across midnight when its relation to video is unknown", async () => {
    await put("CLIP/today.mov", dateTwo); await put("AUDIO/REC_003.wav", dateOne);
    await put("AUDIO/REC_003.xml"); await put("CLIP/old.mov", dateOne);
    const plan = await chooseToday(await preview());
    expect(plan.includedPaths).toEqual(["AUDIO/REC_003.wav", "AUDIO/REC_003.xml", "CLIP/today.mov"]);
    expect(plan.groups.find((group) => group.relativePaths.includes("AUDIO/REC_003.wav"))?.mandatoryReason).toContain("独立录音");
    expect(plan.excludedFiles.map((file) => file.relativePath)).toEqual(["CLIP/old.mov"]);
    expect(conservativeSelectionFamilies(["today.mov", "different.wav"]).find((group) => group.relativePaths.includes("different.wav"))?.protectionReason).toContain("独立录音");
  });

  it("does not infer safety from filenames and keeps unreadable media dates conservative", async () => {
    await put("DJI_20261014230000_0001_D.MP4"); await put("new.mov", dateTwo);
    const value = await preview();
    expect(value.groups.find((group) => group.label.startsWith("DJI"))?.suggestedDate).toBe(dateOne);
    deps.readEmbeddedDate = async (absolute) => { if (absolute.includes("DJI")) throw new Error("probe failed"); return dateTwo; };
    const conservative = await chooseToday(await preview()); expect(conservative.excludedFiles).toHaveLength(0);
  });

  it("records explicit shooting-day assignment without rewriting source metadata", async () => {
    await put("after-midnight.mov", dateTwo); await put("today.mov", dateTwo);
    const value = await preview(), group = value.groups.find((item) => item.label === "after-midnight.mov")!;
    const plan = await finalizeBackupSelection(value, { selectedDates: [dateOne], assignedDates: { [group.id]: dateOne },
      operator: "Operator", allowUnprotectedExclusions: true }, deps);
    expect(plan.includedPaths).toEqual(["after-midnight.mov"]);
    expect(plan.assignedDates[group.id]).toBe(dateOne);
  });

  it("rejects path and symlink changes and source content changes before execution", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const plan = await chooseToday(await preview());
    await fs.writeFile(path.join(source, "old.mov"), "changed");
    await expect(validateBackupSelectionPlan(plan, deps)).rejects.toThrow(/已改变|发生变化/);
    await fs.rm(path.join(source, "old.mov")); await fs.symlink(path.join(source, "new.mov"), path.join(source, "old.mov"));
    await expect(preview()).rejects.toThrow("符号链接");
  });

  it("rejects mutated source volume identity and tampered plan checksums", async () => {
    await put("new.mov", dateTwo); const plan = await chooseToday(await preview());
    volumes.set(source, volume("replacement"));
    await expect(validateBackupSelectionPlan(plan, deps)).rejects.toThrow("磁盘或目录已改变");
    volumes.set(source, volume("source"));
    const forged = structuredClone(plan); forged.sourceFiles[0].sha256 = sha256("other"); sign(forged);
    await expect(validateBackupSelectionPlan(forged, deps)).rejects.toThrow("源素材内容已改变");
  });

  it("preserves evidence of unread source subtrees and does not claim whole-card coverage", async () => {
    await put("unread/old.mov", dateOne); await put("new.mov", dateTwo);
    const original = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(source, "unread")) throw Object.assign(new Error("fixture permission"), { code: "EACCES" });
      return original(...args);
    }) as typeof fs.readdir);
    const plan = await chooseToday(await preview());
    expect(plan.sourceScope.exclusions).toContainEqual(expect.objectContaining({ reason: "permission-denied", relativePath: "unread" }));
    expect(plan.wholeCardCovered).toBe(false);
  });

  it("requires cancellation to stop source hashing", async () => {
    await put("new.mov", dateTwo);
    const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
    await expect(analyzeBackupSelection({ sourcePath: source }, { ...deps, signal: controller.signal })).rejects.toThrow("fixture cancelled");
  });

  it("waits on the pause hook between hash reads and resumes without changing the source", async () => {
    await put("new.mov", dateTwo, "x".repeat(3 * 1024 * 1024));
    let reads = 0, release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const continuation = new Promise<void>((resolve) => { release = resolve; });
    deps.beforeRead = async () => { reads++; if (reads === 3) { entered(); await continuation; } };
    const pending = preview(); await paused;
    const pausedReads = reads; await new Promise((resolve) => setTimeout(resolve, 10)); expect(reads).toBe(pausedReads);
    release(); const value = await pending;
    expect(value.sourceFiles[0].sha256).toBe(sha256("x".repeat(3 * 1024 * 1024)));
    expect(reads).toBeGreaterThan(pausedReads);
  });

  it("keeps a linked primary media file with missing embedded time instead of assuming its companion's date", async () => {
    await put("first/clip.mov", dateOne); await put("second/clip.mp4"); await put("new.mov", dateTwo);
    const plan = await chooseToday(await preview());
    expect(plan.includedPaths).toContain("first/clip.mov"); expect(plan.includedPaths).toContain("second/clip.mp4");
  });
});

describe("strong historical protection", () => {
  it("skips only unselected date files after online SHA-256 and physical-copy verification", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const old = await history("old.mov"), newer = await history("new.mov", "history-two");
    const plan = await chooseToday(await preview([old, newer]), false);
    expect(plan.includedPaths).toEqual(["new.mov"]);
    expect(plan.excludedFiles[0].reason).toBe("history-verified");
    expect(plan.excludedFiles[0].historyEvidence[0].sha256).toBe(sha256("old.mov"));
    expect(plan.wholeCardCovered).toBe(false);
    await expect(validateBackupSelectionPlan(plan, deps)).resolves.toBeDefined();
  });

  it.each(["different-project", "unverified", "changed", "offline", "unknown-topology", "source-same-disk"])("refuses historical skip for %s evidence", async (kind) => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const task = await history("old.mov", "history", { projectId: kind === "different-project" ? "other" : "project",
      verified: kind !== "unverified", content: kind === "changed" ? "changed" : undefined });
    if (kind === "offline") volumes.delete(task.destinations[0].path);
    if (kind === "unknown-topology") deps.assessStorage = undefined;
    if (kind === "source-same-disk") deps.assessStorage = async (paths) => paths.map((target) => ({ kind: "local-physical",
      assessmentId: "same", checkedAt: Date.now(), volumeUuid: volumes.get(target)?.uuid, domains: ["disk1"], reason: "same physical disk fixture" }));
    await expect(chooseToday(await preview([task]), false)).rejects.toThrow("未选日期");
  });

  it("requires all associated files and all required independent copies", async () => {
    await put("old.mov", dateOne); await put("old.xml"); await put("new.mov", dateTwo);
    const task = await history("old.mov");
    await expect(chooseToday(await preview([task]), false)).rejects.toThrow("未选日期");
    await fs.rm(path.join(source, "old.xml"));
    await expect(chooseToday(await preview([task], 2), false)).rejects.toThrow("未选日期");
    const second = await history("old.mov", "history-two");
    const plan = await chooseToday(await preview([task, second], 2), false);
    expect(plan.excludedFiles[0].historyEvidence).toHaveLength(2);
  });

  it("rechecks historical content and identity before confirmed skip can run", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const task = await history("old.mov"), value = await preview([task]);
    await fs.writeFile(task.fileRecords[0].destinations[0].path, "damage!");
    await expect(chooseToday(value, false)).rejects.toThrow("历史副本内容已经改变");
    await fs.writeFile(task.fileRecords[0].destinations[0].path, "old.mov");
    const plan = await chooseToday(await preview([task]), false);
    volumes.set(task.destinations[0].path, volume("replaced"));
    await expect(validateBackupSelectionPlan(plan, deps)).rejects.toThrow("物理身份已改变");
  });

  it("rejects replacing a historical parent directory with a link after confirmation", async () => {
    await put("CLIP/old.mov", dateOne); await put("new.mov", dateTwo);
    const task = await history("CLIP/old.mov"), plan = await chooseToday(await preview([task]), false);
    const root = task.destinations[0].path, original = path.join(root, "CLIP"), moved = path.join(root, "moved");
    await fs.rename(original, moved); await fs.symlink(moved, original);
    await expect(validateBackupSelectionPlan(plan, deps)).rejects.toThrow("素材目录发生变化");
  });

  it("does not count two volumes on one physical domain as two independent historical copies", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const one = await history("old.mov"), two = await history("old.mov", "second");
    deps.assessStorage = async (paths) => paths.map((target, index) => ({ kind: "local-physical",
      assessmentId: "shared-device", checkedAt: Date.now(), volumeUuid: volumes.get(target)?.uuid,
      domains: [index === 0 ? "disk1" : "disk2"], reason: "shared disk simulation" }));
    await expect(chooseToday(await preview([one, two], 2), false)).rejects.toThrow("未选日期");
  });
});

describe("persisted selection contract and dependency closure", () => {
  it("rejects altered digests, omitted unknowns and a split family without touching source", async () => {
    await put("old.mov", dateOne); await put("old.xml"); await put("new.mov", dateTwo); await put("original.mhl");
    const plan = await chooseToday(await preview()), lstat = vi.spyOn(fs, "lstat");
    expect(() => assertBackupSelectionStructure(plan)).not.toThrow(); expect(lstat).not.toHaveBeenCalled();
    const changed = structuredClone(plan); changed.operator = "Changed";
    expect(() => assertBackupSelectionStructure(changed)).toThrow();
    const split = structuredClone(plan); split.includedPaths.push("old.xml"); split.excludedFiles = split.excludedFiles.filter((file) => file.relativePath !== "old.xml"); sign(split);
    expect(() => assertBackupSelectionStructure(split)).toThrow();
    const omitted = structuredClone(plan); omitted.includedPaths = omitted.includedPaths.filter((relative) => relative !== "original.mhl");
    omitted.excludedFiles.push({ relativePath: "original.mhl", groupId: omitted.groups.find((group) => group.relativePaths.includes("original.mhl"))!.id,
      reason: "user-date", historyEvidence: [] }); sign(omitted);
    expect(() => assertBackupSelectionStructure(omitted)).toThrow();
  });

  it("rejects applying a frozen plan to another scan and excludes no files without explicit selection", async () => {
    await put("new.mov", dateTwo); const value = await preview(), plan = await chooseToday(value);
    await put("another.mov", dateTwo);
    const inventory = await scan(source, value.sourceScope.policy);
    expect(() => applyBackupSelectionInventory(inventory, plan)).toThrow("完整素材范围不一致");
  });

  it("rejects traversal in imported historical evidence before performing any filesystem access", async () => {
    await put("old.mov", dateOne); await put("new.mov", dateTwo);
    const task = await history("old.mov"), plan = await chooseToday(await preview([task]), false);
    plan.excludedFiles[0].historyEvidence[0].relativePath = "../outside.mov";
    plan.excludedFiles[0].historyEvidence[0].path = path.resolve(task.destinations[0].path, "../outside.mov"); sign(plan);
    const lstat = vi.spyOn(fs, "lstat");
    expect(() => assertBackupSelectionStructure(plan)).toThrow("历史副本文件依据无效"); expect(lstat).not.toHaveBeenCalled();
  });

  it("links Sony XML, cross-directory proxies, continuous GoPro chapters and indivisible RED packages", () => {
    const groups = conservativeSelectionFamilies(["CLIP/C0001.MP4", "META/C0001M01.XML", "proxy/C0001.LRF",
      "DCIM/GX010001.MP4", "DCIM/GX020001.MP4", "A001.RDC/A001_001.R3D", "A001.RDC/A001_002.R3D"]);
    expect(groups).toContainEqual({ relativePaths: ["CLIP/C0001.MP4", "META/C0001M01.XML", "proxy/C0001.LRF"], packageProtected: false });
    expect(groups).toContainEqual({ relativePaths: ["DCIM/GX010001.MP4", "DCIM/GX020001.MP4"], packageProtected: false });
    expect(groups).toContainEqual({ relativePaths: ["A001.RDC/A001_001.R3D", "A001.RDC/A001_002.R3D"], packageProtected: true });
    expect(conservativeSelectionFamilies(["a.mov", "b.mov"], "/private/var/tmp/source")).toHaveLength(2);
  });
});
