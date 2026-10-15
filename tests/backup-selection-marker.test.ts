import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BackupTask } from "../src/main/types";
import { analyzeBackupSelection, finalizeBackupSelection } from "../src/main/backup-selection";
import { detectBackupSelectionMarker, writeBackupSelectionIntent, writeBackupSelectionMarker,
  type BackupSelectionMarkerDependencies } from "../src/main/backup-selection-marker";

let directory: string, source: string, destination: string, task: BackupTask;
const identity = { id: "fixture-volume", uuid: "fixture-volume-uuid", device: "fixture-device", name: "fixture" };
let dependencies: BackupSelectionMarkerDependencies;
const markerPath = () => path.join(destination, "Kocpy报告", `选定范围_${task.id}.json`);

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-selection-marker-")));
  source = path.join(directory, "source"); destination = path.join(directory, "destination");
  await fs.mkdir(source); await fs.mkdir(destination);
  await fs.writeFile(path.join(source, "old.mov"), "old content");
  await fs.writeFile(path.join(source, "new.mov"), "new content");
  await fs.writeFile(path.join(source, "original.mhl"), "historical original, must remain identical");
  const selectionDeps = { identifyVolume: async () => identity,
    readEmbeddedDate: async (file: string) => file.endsWith("old.mov") ? "2026-10-14" : "2026-10-15" };
  const preview = await analyzeBackupSelection({ sourcePath: source, projectId: "fixture-project" }, selectionDeps);
  const selection = await finalizeBackupSelection(preview, { selectedDates: ["2026-10-15"], operator: "fixture",
    allowUnprotectedExclusions: true }, selectionDeps);
  task = { id: "fixture-task", sourcePath: source, projectId: "fixture-project", selection, hashAlgorithm: "sha256",
    destinations: [{ id: "fixture-destination", path: destination, resolvedPath: destination, volumeId: identity.id,
      volumeUuid: identity.uuid, label: "fixture", verified: false, bytesWritten: 0 }], fileRecords: [],
  } as unknown as BackupTask;
  dependencies = { identifyVolume: async () => identity };
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

async function finishCopies() {
  task.destinations[0].verified = true;
  const included = new Set(task.selection!.includedPaths);
  task.fileRecords = await Promise.all(task.selection!.sourceFiles.filter((file) => included.has(file.relativePath)).map(async (file) => {
    const target = path.join(destination, file.relativePath);
    await fs.copyFile(path.join(source, file.relativePath), target);
    return { name: file.relativePath, relativePath: file.relativePath, size: file.size, srcChecksum: file.sha256,
      destinations: [{ path: target, checksum: file.sha256, verified: true }] };
  }));
}

describe("immutable selected-scope on-disk declaration", () => {
  it("is a no-op for ordinary full-card tasks", async () => {
    delete task.selection;
    const identifyVolume = vi.fn(async () => identity);
    expect(await writeBackupSelectionIntent(task, task.destinations[0], { identifyVolume })).toBeUndefined();
    expect(await writeBackupSelectionMarker(task, task.destinations[0], { identifyVolume })).toBeUndefined();
    expect(identifyVolume).not.toHaveBeenCalled(); expect(await fs.readdir(destination)).toEqual([]);
  });

  it("writes a blocking scope warning before copying without claiming completion or authentic provenance", async () => {
    const result = await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    expect(result?.path).toBe(markerPath()); expect(result?.reused).toBe(false);
    const text = await fs.readFile(markerPath(), "utf8"), marker = JSON.parse(text);
    expect(marker).toMatchObject({ kind: "kocpy-selected-backup-scope", wholeCardCovered: false,
      verificationClaim: "none", checksumBasis: "expected-frozen-source-sha256", pathBasis: "source-relative" });
    expect(marker.includedFiles.map((file: any) => file.relativePath)).toEqual(["new.mov", "original.mhl"]);
    expect(marker.excludedFiles).toEqual([{ relativePath: "old.mov", reason: "user-date", groupId: task.selection!.excludedFiles[0].groupId }]);
    expect(text).not.toContain(directory); expect(text).not.toContain("historyEvidence");
    expect((await detectBackupSelectionMarker(destination)).markers).toEqual([{ path: markerPath(), status: "selected-scope",
      taskId: task.id, selectionDigest: task.selection!.digest }]);
    expect(await fs.readdir(destination)).toEqual(["Kocpy报告"]);
  });

  it("reuses the same immutable warning at completion, without modifying source or raw MHL", async () => {
    const before = await fs.stat(path.join(source, "original.mhl"));
    const initial = await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const markerBefore = await fs.stat(markerPath());
    await finishCopies();
    const result = await writeBackupSelectionMarker(task, task.destinations[0], dependencies);
    expect(result).toEqual({ ...initial, reused: true });
    const after = await fs.stat(path.join(source, "original.mhl")), markerAfter = await fs.stat(markerPath());
    expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.size, before.mtimeMs, before.ctimeMs]);
    expect([markerAfter.ino, markerAfter.mtimeMs, markerAfter.ctimeMs]).toEqual([markerBefore.ino, markerBefore.mtimeMs, markerBefore.ctimeMs]);
    expect(await fs.readFile(path.join(destination, "original.mhl"), "utf8")).toBe("historical original, must remain identical");
    expect(await fs.readdir(path.join(destination, "Kocpy报告"))).toEqual([path.basename(markerPath())]);
  });

  it("blocks completion if any selected file lacks a verified destination", async () => {
    await expect(writeBackupSelectionMarker(task, task.destinations[0], dependencies)).rejects.toThrow("逐文件");
    await finishCopies(); task.fileRecords[0].destinations[0].verified = false;
    await expect(writeBackupSelectionMarker(task, task.destinations[0], dependencies)).rejects.toThrow("逐文件");
    expect(await fs.readdir(destination)).not.toContain("Kocpy报告");
  });

  it("rejects forged path, digest, duplicate and wrong-target evidence", async () => {
    await finishCopies();
    const records = structuredClone(task.fileRecords);
    task.fileRecords[0].destinations[0].path = `${destination}/../escape.mov`;
    await expect(writeBackupSelectionMarker(task, task.destinations[0], dependencies)).rejects.toThrow("证据");
    task.fileRecords = structuredClone(records); task.fileRecords[0].srcChecksum = "f".repeat(64);
    task.fileRecords[0].destinations[0].checksum = "f".repeat(64);
    await expect(writeBackupSelectionMarker(task, task.destinations[0], dependencies)).rejects.toThrow("证据");
    task.fileRecords = [records[0], records[0]];
    await expect(writeBackupSelectionMarker(task, task.destinations[0], dependencies)).rejects.toThrow("逐文件");
    await expect(writeBackupSelectionIntent(task, { ...task.destinations[0], id: "foreign" }, dependencies)).rejects.toThrow("不属于");
  });

  it("refuses source overlap and unrecorded or changed disk identities", async () => {
    task.destinations[0].resolvedPath = source;
    await expect(writeBackupSelectionIntent(task, task.destinations[0], dependencies)).rejects.toThrow("素材源");
    task.destinations[0].resolvedPath = destination;
    await expect(writeBackupSelectionIntent(task, task.destinations[0], { identifyVolume: async () => ({ ...identity, uuid: "different" }) })).rejects.toThrow("磁盘身份");
    delete task.destinations[0].volumeId; delete task.destinations[0].volumeUuid;
    await expect(writeBackupSelectionIntent(task, task.destinations[0], dependencies)).rejects.toThrow("磁盘身份");
    expect(await fs.readdir(destination)).toEqual([]);
  });

  it("preserves an existing conflicting declaration and never overwrites it", async () => {
    await fs.mkdir(path.dirname(markerPath())); await fs.writeFile(markerPath(), "user record");
    await expect(writeBackupSelectionIntent(task, task.destinations[0], dependencies)).rejects.toThrow("拒绝覆盖");
    expect(await fs.readFile(markerPath(), "utf8")).toBe("user record");
    expect((await detectBackupSelectionMarker(destination)).markers[0].status).toBe("unreadable-or-invalid");
  });

  it("rejects symlinked report directories and does not follow marker symlinks", async () => {
    const outside = path.join(directory, "outside"); await fs.mkdir(outside);
    await fs.symlink(outside, path.join(destination, "Kocpy报告"));
    await expect(writeBackupSelectionIntent(task, task.destinations[0], dependencies)).rejects.toThrow(/符号链接|真实目录/);
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await detectBackupSelectionMarker(destination)).detected).toBe(true);
    await fs.unlink(path.join(destination, "Kocpy报告")); await fs.mkdir(path.join(destination, "Kocpy报告"));
    const external = path.join(outside, "record.json"); await fs.writeFile(external, "untouched");
    await fs.symlink(external, markerPath());
    await expect(writeBackupSelectionIntent(task, task.destinations[0], dependencies)).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("untouched");
    expect((await detectBackupSelectionMarker(destination)).markers[0].status).toBe("unreadable-or-invalid");
  });

  it("stops when the destination inode changes during its identity check", async () => {
    let changed = false;
    await expect(writeBackupSelectionIntent(task, task.destinations[0], { identifyVolume: async () => {
      if (!changed) { changed = true; await fs.rename(destination, `${destination}-moved`); await fs.mkdir(destination); }
      return identity;
    } })).rejects.toThrow("目录已改变");
    expect(await fs.readdir(destination)).toEqual([]); expect(await fs.readdir(`${destination}-moved`)).toEqual([]);
  });

  it("uses an exclusive fallback on filesystems without hardlink support", async () => {
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }));
    const result = await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    expect(result?.reused).toBe(false); expect((await detectBackupSelectionMarker(destination)).detected).toBe(true);
    expect(await fs.readdir(path.join(destination, "Kocpy报告"))).toEqual([path.basename(markerPath())]);
  });

  it("does not read a substituted staging symlink during exclusive fallback publication", async () => {
    const external = path.join(directory, "outside-private.txt"); await fs.writeFile(external, "must not be read into marker");
    vi.spyOn(fs, "link").mockImplementationOnce(async (from) => {
      await fs.unlink(from); await fs.symlink(external, from);
      throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" });
    });
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    expect(await fs.readFile(markerPath(), "utf8")).not.toContain("must not be read into marker");
    expect(JSON.parse(await fs.readFile(markerPath(), "utf8")).kind).toBe("kocpy-selected-backup-scope");
    expect(await fs.readFile(external, "utf8")).toBe("must not be read into marker");
  });

  it("keeps detection conservative for interrupted, malformed and nested declarations", async () => {
    const reports = path.join(destination, "day", "camera", "card", "Kocpy报告"); await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(path.join(reports, "选定范围_old.json"), "{}");
    await fs.writeFile(path.join(reports, ".选定范围_old.partial"), "incomplete");
    const result = await detectBackupSelectionMarker(destination);
    expect(result.detected).toBe(true); expect(result.markers).toHaveLength(2);
    expect(result.markers.every((marker) => marker.status === "unreadable-or-invalid")).toBe(true);
  });

  it("also blocks full-card adoption for completed or damaged daily-delivery marker/journal names", async () => {
    const delivery = path.join(destination, "daily-subset"); await fs.mkdir(delivery);
    await fs.writeFile(path.join(delivery, ".kocpy-daily-delivery.json"), "corrupt retained marker");
    await fs.symlink(path.join(directory, "missing-journal"), path.join(delivery, ".kocpy-daily-delivery.journal.ndjson"));
    const result = await detectBackupSelectionMarker(destination);
    expect(result.detected).toBe(true); expect(result.markers).toHaveLength(2);
    expect(result.markers.every((marker) => marker.derivedScopeKind === "daily-delivery")).toBe(true);
    expect(await fs.readFile(path.join(delivery, ".kocpy-daily-delivery.json"), "utf8")).toBe("corrupt retained marker");
  });

  it("detects selected-scope ancestors of a MEDIA child without reading ancestor contents or sibling trees", async () => {
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const media = path.join(destination, "MEDIA", "DCIM"); await fs.mkdir(media, { recursive: true });
    await fs.mkdir(path.join(destination, "private-sibling"));
    const actualRead = fs.readdir.bind(fs), readPaths: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      readPaths.push(String(target)); return actualRead(target, options);
    }) as typeof fs.readdir);
    const open = vi.spyOn(fs, "open");
    for (const options of [{}, { relativeDirectories: [] }]) {
      const result = await detectBackupSelectionMarker(media, options);
      expect(result.markers).toEqual([{ path: markerPath(), status: "unreadable-or-invalid" }]);
    }
    expect(open).not.toHaveBeenCalled();
    expect(new Set(readPaths)).toEqual(new Set([media, path.dirname(markerPath())]));
  });

  it("detects daily-delivery parent markers and journals when selecting only Media", async () => {
    const media = path.join(destination, "Media"); await fs.mkdir(media);
    const marker = path.join(destination, ".kocpy-daily-delivery.json");
    const journal = path.join(destination, ".kocpy-daily-delivery.journal.ndjson");
    await fs.writeFile(marker, "incomplete or damaged declaration");
    await fs.symlink(path.join(directory, "missing-journal"), journal);
    const open = vi.spyOn(fs, "open");
    const result = await detectBackupSelectionMarker(media, { relativeDirectories: [] });
    expect(result.markers).toEqual([
      { path: marker, status: "unreadable-or-invalid", derivedScopeKind: "daily-delivery" },
      { path: journal, status: "unreadable-or-invalid", derivedScopeKind: "daily-delivery" },
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not let a marked sibling project contaminate an unrelated source", async () => {
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const sibling = path.join(directory, "sibling-daily"); await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, ".kocpy-daily-delivery.json"), "subset");
    const actualRead = fs.readdir.bind(fs), readPaths: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      readPaths.push(String(target)); return actualRead(target, options);
    }) as typeof fs.readdir);
    expect(await detectBackupSelectionMarker(source)).toEqual({ detected: false, markers: [] });
    expect(readPaths).toEqual([source]);
  });

  it("fresh final checks detect a scope marker introduced at an ancestor after initial preflight", async () => {
    const media = path.join(destination, "MEDIA"); await fs.mkdir(media);
    expect((await detectBackupSelectionMarker(media, { relativeDirectories: [] })).detected).toBe(false);
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    expect((await detectBackupSelectionMarker(media, { relativeDirectories: [] })).detected).toBe(true);
  });

  it("fails closed for inaccessible ancestor declarations and never follows an ancestor report symlink", async () => {
    const media = path.join(destination, "Media"), outside = path.join(directory, "outside-reports");
    await fs.mkdir(media); await fs.mkdir(outside);
    const reports = path.dirname(markerPath());
    await fs.symlink(outside, reports);
    const actualRead = fs.readdir.bind(fs), readPaths: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      readPaths.push(String(target)); return actualRead(target, options);
    }) as typeof fs.readdir);
    expect((await detectBackupSelectionMarker(media)).markers).toEqual([{ path: reports, status: "unreadable-or-invalid" }]);
    expect(readPaths).not.toContain(outside); expect(readPaths).not.toContain(reports);
    await fs.unlink(reports); await fs.mkdir(reports);
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      if (String(target) === reports) throw Object.assign(new Error("ancestor declaration is inaccessible"), { code: "EACCES" });
      return actualRead(target, options);
    }) as typeof fs.readdir);
    await expect(detectBackupSelectionMarker(media)).rejects.toThrow("ancestor declaration is inaccessible");
  });

  it("rejects an ancestor directory replaced during reserved-name inspection", async () => {
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const media = path.join(destination, "MEDIA"); await fs.mkdir(media);
    const reports = path.dirname(markerPath()), actualRead = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      const entries = await actualRead(target, options);
      if (String(target) === reports) {
        await fs.rename(destination, `${destination}-moved`);
        await fs.mkdir(reports, { recursive: true }); await fs.mkdir(media);
      }
      return entries;
    }) as typeof fs.readdir);
    await expect(detectBackupSelectionMarker(media)).rejects.toThrow("祖先范围声明目录在检查期间发生变化");
  });

  it("limits transfer checks to successfully scanned directories without reopening excluded folders", async () => {
    const excluded = path.join(destination, ".Trashes"), inaccessible = path.join(destination, "no-access");
    const reports = path.join(destination, "card", "Kocpy报告");
    await fs.mkdir(excluded); await fs.mkdir(inaccessible); await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(path.join(reports, "选定范围_old.json"), "retained declaration");
    const actualRead = fs.readdir.bind(fs), touched: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      touched.push(String(target));
      if ([excluded, inaccessible].includes(String(target))) throw Object.assign(new Error("must remain excluded"), { code: "EACCES" });
      return actualRead(target, options);
    }) as typeof fs.readdir);
    const result = await detectBackupSelectionMarker(destination, { relativeDirectories: ["card", "card/Kocpy报告"] });
    expect(result.detected).toBe(true); expect(result.markers).toHaveLength(1);
    expect(touched).not.toContain(excluded); expect(touched).not.toContain(inaccessible);
    await expect(detectBackupSelectionMarker(destination)).rejects.toThrow("must remain excluded");
  });

  it("rejects escaped or symlinked directories in scanner-provided lists", async () => {
    for (const relative of ["../outside", "/outside", "card/../other", "card\\other", ".", ""]) {
      await expect(detectBackupSelectionMarker(destination, { relativeDirectories: [relative] })).rejects.toThrow(/无效|越界/);
    }
    const insideDirectory = path.join(destination, "real"); await fs.mkdir(insideDirectory);
    await fs.symlink(insideDirectory, path.join(destination, "alias"));
    await expect(detectBackupSelectionMarker(destination, { relativeDirectories: ["alias"] })).rejects.toThrow("真实目录");
    await fs.symlink(source, path.join(destination, "outside"));
    await expect(detectBackupSelectionMarker(destination, { relativeDirectories: ["outside"] })).rejects.toThrow("符号链接");
  });

  it("stops directory detection immediately after cancellation without opening queued children", async () => {
    await fs.mkdir(path.join(destination, "first")); await fs.mkdir(path.join(destination, "second"));
    const controller = new AbortController(), actualRead = fs.readdir.bind(fs), readPaths: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      readPaths.push(String(target)); const entries = await actualRead(target, options);
      controller.abort(new Error("fixture cancelled")); return entries;
    }) as typeof fs.readdir);
    await expect(detectBackupSelectionMarker(destination, { signal: controller.signal })).rejects.toThrow("fixture cancelled");
    expect(readPaths).toEqual([destination]);
  });

  it("stops ancestor inspection on cancellation and does not continue into the selected root", async () => {
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const media = path.join(destination, "Media"); await fs.mkdir(media);
    const controller = new AbortController(), actualRead = fs.readdir.bind(fs), readPaths: string[] = [];
    vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options: any) => {
      readPaths.push(String(target)); const entries = await actualRead(target, options);
      controller.abort(new Error("ancestor check cancelled")); return entries;
    }) as typeof fs.readdir);
    await expect(detectBackupSelectionMarker(media, { signal: controller.signal })).rejects.toThrow("ancestor check cancelled");
    expect(readPaths).toEqual([path.dirname(markerPath())]);
  });

  it("does not swallow cancellation inside marker reads or perform further probes", async () => {
    await writeBackupSelectionIntent(task, task.destinations[0], dependencies);
    const controller = new AbortController(), actualOpen = fs.open.bind(fs), opened: string[] = [];
    vi.spyOn(fs, "open").mockImplementation((async (target: any, ...rest: any[]) => {
      opened.push(String(target)); const handle = await (actualOpen as any)(target, ...rest);
      controller.abort(new Error("marker read cancelled")); return handle;
    }) as typeof fs.open);
    await expect(detectBackupSelectionMarker(destination, { signal: controller.signal })).rejects.toThrow("marker read cancelled");
    expect(opened).toEqual([markerPath()]);
  });

  it("cancels before writing and leaves no success claim", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(writeBackupSelectionIntent(task, task.destinations[0], { ...dependencies, signal: controller.signal })).rejects.toThrow();
    expect(await fs.readdir(destination)).toEqual([]);
  });
});
