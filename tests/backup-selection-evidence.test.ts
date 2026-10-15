import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { analyzeBackupSelection, finalizeBackupSelection, backupSelectionScope } from "../src/main/backup-selection";
import { taskTrustState, taskCompletionNotice, taskMeetsCopyRequirement } from "../src/common/task-trust";
import { completedBackupCoversAttempt } from "../src/common/source-scan";
import { generateMhl, generateAscMhl } from "../src/main/backup/ManifestGenerator";
import { generateReport, generateDailyReport, generateProjectReport } from "../src/main/backup/ReportGenerator";
import { sealWorkspaceState, validateWorkspaceState } from "../src/main/workspace-contract";
import type { BackupTask, ProjectConfig } from "../src/main/types";

const project: ProjectConfig = { id: "selection-project", name: "Synthetic range review", devices: ["A"], volumePrefix: "A", requiredCopies: 1 };
let root: string;
let selected: BackupTask;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resealPlan = (task: BackupTask) => {
  const { digest: _old, ...body } = task.selection!;
  task.selection!.digest = digest(body);
  task.inventoryScope = backupSelectionScope(task.selection!);
};
const seal = (task: BackupTask) => sealWorkspaceState({
  schemaVersion: 1, revision: 1, committedAt: Date.now(), tasks: [task], projects: [project],
  taskTombstones: [], projectTombstones: [],
});

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-selection-evidence-")));
  const sourcePath = path.join(root, "source");
  await fs.mkdir(sourcePath);
  await Promise.all([
    fs.writeFile(path.join(sourcePath, "20260101_old.mov"), "synthetic old media"),
    fs.writeFile(path.join(sourcePath, "20260101_old.xml"), "synthetic related metadata"),
    fs.writeFile(path.join(sourcePath, "20260102_new.mov"), "synthetic current media"),
    fs.writeFile(path.join(sourcePath, "original.mhl"), "unchanged original inventory"),
  ]);
  const deps = {
    identifyVolume: async () => ({ id: "fixture-source", uuid: "fixture-source", name: "fixture", device: "disk1" }),
    readEmbeddedDate: async (absolutePath: string) => path.basename(absolutePath).startsWith("20260101") ? "2026-01-01T12:00:00Z" : "2026-01-02T12:00:00Z",
  };
  const preview = await analyzeBackupSelection({ sourcePath, projectId: project.id }, deps);
  const selection = await finalizeBackupSelection(preview, {
    selectedDates: ["2026-01-02"], operator: "Fixture <operator> -- review", allowUnprotectedExclusions: true,
  }, deps);
  selected = new BackupEngine().createTask({
    sourcePath, projectId: project.id, projectName: project.name, selection,
    name: "Selected range fixture", namingTemplate: "A001", devices: ["A"],
    destinationPaths: [path.join(root, "destination")], shootingDate: "2026-01-02", hashAlgorithm: "sha256",
  });
  selected.status = "completed";
  selected.createdAt = 2;
  selected.sourceVolumeUuid = "fixture-source";
  selected.destinations[0].verified = true;
  selected.destinations[0].volumeUuid = "fixture-destination";
  selected.fileRecords = selection.sourceFiles.filter((file) => selection.includedPaths.includes(file.relativePath)).map((file) => ({
    name: path.basename(file.relativePath), relativePath: file.relativePath, size: file.size, srcChecksum: file.sha256,
    ascMhlMd5: "d41d8cd98f00b204e9800998ecf8427e",
    destinations: [{ path: path.join(root, "destination", file.relativePath), checksum: file.sha256, verified: true }],
  }));
  selected.completedFiles = selected.totalFiles;
  expect(selection.excludedFiles).toHaveLength(2);
  expect(selection.includedPaths).toContain("original.mhl");
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("selected backup range evidence", () => {
  it("verifies the selected content while never counting it as a whole-card copy", () => {
    expect(taskTrustState(selected)).toMatchObject({ status: "unverified", contentVerified: true, countableCopies: 0 });
    expect(taskMeetsCopyRequirement(selected, 1)).toBe(false);
    const notice = taskCompletionNotice(selected);
    expect(notice.attention).toBe(true);
    expect(notice.title).toContain("选定范围校验通过");
    expect(notice.body).toContain("未复制 2 个文件");
    expect(notice.body).toContain("不得据此格式化源素材卡");
    expect(taskTrustState({ ...selected, fileRecords: [] })).toEqual(taskTrustState(selected));
  });

  it.each(["pending", "running", "paused", "failed", "cancelled"] as const)("does not promote %s selected tasks to completed content", (status) => {
    expect(taskTrustState({ ...selected, status })).toMatchObject({ status, contentVerified: false, countableCopies: 0 });
  });

  it("cannot hide an earlier whole-card failure even with forged coverage flag", () => {
    const failed = { ...selected, createdAt: 1, status: "failed" as const, selection: undefined };
    expect(completedBackupCoversAttempt(selected, failed)).toBe(false);
    const tampered = structuredClone(selected);
    tampered.selection!.wholeCardCovered = true;
    expect(completedBackupCoversAttempt(tampered, failed)).toBe(false);
    expect(taskTrustState(tampered).countableCopies).toBe(0);
  });

  it("does not downgrade an explicitly confirmed selection that still includes the whole source", () => {
    const full = structuredClone(selected), plan = full.selection!;
    plan.selectedDates = ["2026-01-01", "2026-01-02"];
    plan.includedPaths = plan.sourceFiles.map((file) => file.relativePath).sort();
    plan.excludedFiles = [];
    plan.wholeCardCovered = true;
    resealPlan(full);
    full.totalFiles = plan.sourceFiles.length;
    full.totalBytes = plan.sourceFiles.reduce((sum, file) => sum + file.size, 0);
    full.completedFiles = full.totalFiles;
    full.fileRecords = plan.sourceFiles.map((file) => ({
      name: path.basename(file.relativePath), relativePath: file.relativePath, size: file.size, srcChecksum: file.sha256,
      destinations: [{ path: path.join(root, "destination", file.relativePath), checksum: file.sha256, verified: true }],
    }));
    expect(validateWorkspaceState(seal(full)).tasks[0].totalFiles).toBe(4);
    expect(taskTrustState(full)).toMatchObject({ contentVerified: true, countableCopies: 1 });
  });

  it("retains source, selected, excluded and operator evidence in task/day/project reports", async () => {
    const before = await fs.readFile(path.join(selected.sourcePath, "original.mhl"));
    for (const report of [await generateReport(selected), await generateDailyReport([selected], "2026-01-02"), await generateProjectReport(project, [selected])]) {
      const html = report.toString();
      expect(html).toContain("完整源扫描 4 个文件");
      expect(html).toContain("本次选择 2 个");
      expect(html).toContain("未复制 2 个");
      expect(html).toContain("历史已验证 0 个，未保护 2 个");
      expect(html).toContain("Fixture &lt;operator&gt; -- review");
      expect(html).not.toContain("<operator>");
    }
    const html = (await generateReport(selected)).toString();
    expect(html).not.toContain("完整文件范围 · complete-v2");
    expect(html).toContain("20260101_old.xml");
    expect(html).toContain("不是整卡完整副本");
    expect(await fs.readFile(path.join(selected.sourcePath, "original.mhl"))).toEqual(before);
  });

  it("keeps scope evidence in full-width task detail rows instead of squeezing it into status columns", async () => {
    for (const report of [await generateDailyReport([selected], "2026-01-02"), await generateProjectReport(project, [selected])]) {
      const html = report.toString();
      expect(html).toContain('<tbody class="task-group"><tr>');
      expect(html).toContain('<tr class="task-detail"><td colspan="6"><p><strong>备份范围与确认</strong>');
      const taskGroup = html.match(/<tbody class="task-group">([\s\S]*?)<\/tbody>/)?.[1] || "";
      expect(taskGroup.split('<tr class="task-detail">')[0]).not.toContain("完整源扫描");
      expect(taskGroup).toContain("完整源扫描 4 个文件");
      expect(taskGroup).toContain("下一步");
      expect(html).toContain("td, th { vertical-align: top; line-height: 1.55; }");
      expect(html).not.toContain('<tbody><tbody class="task-group">');
    }
    const daily = (await generateDailyReport([selected], "2026-01-02")).toString();
    expect(daily).toContain('<table class="daily-destination-table">');
    expect(daily).toContain(".daily-destination-table th:nth-child(4) { width: 46%; }");
    const projectHtml = (await generateProjectReport(project, [selected])).toString();
    expect(projectHtml).toContain(".split td:first-child { white-space: normal; overflow-wrap: anywhere; }");
    expect(projectHtml).toContain('<table class="file-detail-table">');
    expect(projectHtml).toContain(".file-detail-table th:nth-child(4) { width: 32%; }");
    const single = (await generateReport(selected)).toString();
    expect(single).toContain('<span class="label">扫描策略排除</span>');
    expect(single).not.toContain('<span class="label">明确排除</span>');
  });

  it("exports only selected hashes and explicit ASC MHL exclusions without revising originals", async () => {
    const mhl = generateMhl(selected), asc = generateAscMhl(selected);
    expect(mhl).toContain("Not a whole-card copy");
    expect(mhl).toContain("Fixture &lt;operator&gt; - - review");
    expect(mhl).not.toContain("<file>20260101_old.mov</file>");
    expect(mhl).toContain("<file>20260102_new.mov</file>");
    expect(asc).toContain("<pattern>20260101_old.mov</pattern>");
    expect(asc).toContain("<pattern>20260101_old.xml</pattern>");
    expect(asc).not.toContain('<path size="18">20260101_old.mov</path>');
    const manifestPath = path.join(root, "selected-asc.mhl");
    await fs.writeFile(manifestPath, asc);
    execFileSync("/usr/bin/xmllint", ["--noout", "--schema", path.resolve("tests/ASCMHL.xsd"), manifestPath]);
    const extra = structuredClone(selected);
    extra.fileRecords[0].relativePath = "20260101_old.mov";
    expect(() => generateMhl(extra)).toThrow(/备份范围/);
  });

  it("wraps long Unicode scan events, destination errors and path cells without a nowrap override", async () => {
    const task = structuredClone(selected);
    const longPath = `素材/跨日摄影机包/${"多日拍摄关联元数据".repeat(40)}/shared.xml`;
    task.faultTimeline = [{ at: 1, phase: "scanning", level: "warning", message: `读取待确认 ${longPath}` }];
    task.destinations[0].error = `目标文件暂时不可读取 ${longPath}`;
    task.destinations[0].verified = false;
    const html = (await generateReport(task)).toString();
    expect(html).toContain(longPath);
    expect(html).toContain('<table class="event-table">');
    expect(html).toContain("white-space: normal; overflow-wrap: anywhere;");
    expect(html).toContain(".event-table th:nth-child(3) { width: 66%; }");
    expect(html).not.toContain("td:nth-child(2), td:last-child { white-space: nowrap;");
  });

  it("round-trips a coherent selected task and rejects plan/task/scope tampering", () => {
    expect(validateWorkspaceState(seal(selected)).tasks[0].selection).toEqual(selected.selection);
    const mutations: Array<(task: BackupTask) => void> = [
      (task) => { task.selection!.operator = "modified without digest"; },
      (task) => { task.sourcePath += "-other"; },
      (task) => { task.projectId = "other-project"; },
      (task) => { task.inventoryScope!.fingerprint = "f".repeat(64); },
      (task) => { task.totalFiles++; },
      (task) => { task.fileRecords[0].size++; },
      (task) => { task.fileRecords[0].srcChecksum = "f".repeat(64); },
      (task) => { task.fileRecords.pop(); },
      (task) => { task.selection!.wholeCardCovered = true; resealPlan(task); },
    ];
    for (const mutation of mutations) {
      const task = structuredClone(selected);
      expect(() => { mutation(task); seal(task); }).toThrow();
    }
  });

  it("accepts an interrupted subset of the confirmed inventory, without counting it", () => {
    const task = structuredClone(selected);
    task.status = "paused";
    task.fileRecords.pop();
    expect(validateWorkspaceState(seal(task)).tasks[0].fileRecords).toHaveLength(1);
    expect(taskTrustState(task)).toMatchObject({ contentVerified: false, countableCopies: 0 });
  });
});
