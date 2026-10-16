import { describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { appendProjectHandoffEvidence } from "../src/main/project-evidence";
import { groupLogicalVolumes } from "../src/common/logical-volumes";
import { taskDateContributions } from "../src/common/date-allocation";
import {
  recordsForShootingDay,
  requireShootingDay,
  shootingDayArchiveScopeNote,
  taskBelongsToShootingDay,
} from "../src/common/shooting-day-records";
import type { BackupSelectionPlan } from "../src/common/backup-selection";
import type { BackupTask, CardDateAllocationGroup, ProjectConfig } from "../src/main/types";

const firstDay = "2026-10-15", secondDay = "2026-10-16";
function fixture(): BackupTask {
  const task = new BackupEngine().createTask({ name: "Synthetic night shoot", sourcePath: "/synthetic/source", destinationPaths: ["/synthetic/backup"], devices: ["FX3"], shootingDate: firstDay, hashAlgorithm: "sha256", namingTemplate: "card", projectId: "generated-project" });
  task.status = "completed";
  task.createdAt = task.completedAt = Date.parse("2026-10-17T12:00:00Z");
  task.fileRecords = ["before-midnight.mov", "after-midnight.mov", "unknown.mov", "after-midnight.xml"].map((relativePath, index) => ({ name: relativePath, relativePath, size: 10 * (index + 1), srcChecksum: "a".repeat(64), destinations: [{ path: `/synthetic/backup/${relativePath}`, checksum: "a".repeat(64), verified: true }] }));
  task.totalFiles = 4;
  task.totalBytes = 100;
  return task;
}
function allocation(task: BackupTask) {
  const group = (id: string, relativePaths: string[], assignedDate?: string): CardDateAllocationGroup => ({ id, label: id, relativePaths, files: relativePaths.length, bytes: task.fileRecords.filter((record) => relativePaths.includes(record.relativePath)).reduce((sum, record) => sum + record.size, 0), suggestionBasis: "embedded-media", suggestionConfidence: "review", suggestedDate: secondDay, evidence: [], assignedDate, confirmedAt: assignedDate ? 2 : undefined, confirmedBy: assignedDate ? "Fixture DIT" : undefined });
  task.dateAllocation = { schemaVersion: 1, sourceTaskId: task.id, sourceEvidenceDigest: "a".repeat(64), generatedAt: 1, updatedAt: 2, groups: [group("before", ["before-midnight.mov"], firstDay), group("after", ["after-midnight.mov", "after-midnight.xml"], secondDay), group("unknown", ["unknown.mov"])] };
  return task;
}
function selected(task: BackupTask) {
  const groups = task.dateAllocation!.groups;
  // The projection consumes a previously validated persisted plan, not a new
  // authorization. This fixture intentionally supplies only fields it reads.
  task.selection = {
    schemaVersion: 1, confirmedAt: 2, operator: "Fixture DIT", wholeCardCovered: false,
    includedPaths: ["after-midnight.mov", "after-midnight.xml", "unknown.mov"],
    excludedFiles: [{ relativePath: "before-midnight.mov", groupId: "before", reason: "user-date", historyEvidence: [] }],
    sourceFiles: task.fileRecords.map((record) => ({ relativePath: record.relativePath, size: record.size })),
    groups, assignedDates: { before: firstDay, after: secondDay },
  } as unknown as BackupSelectionPlan;
  return task;
}
const names = (task: BackupTask, day: string) => recordsForShootingDay(task, day).map((row) => row.file.relativePath);

describe("read-only shooting-day consumers", () => {
  it("keeps an unallocated full night-shoot card on its chosen start day", () => {
    const task = fixture();
    expect(names(task, firstDay)).toEqual(task.fileRecords.map((file) => file.relativePath));
    expect(names(task, secondDay)).toEqual([]);
    expect(taskBelongsToShootingDay(task, firstDay)).toBe(true);
    expect(taskBelongsToShootingDay(task, secondDay)).toBe(false);
  });

  it("selects a task on its assigned second day but never exports the other day's confirmed files", () => {
    const task = allocation(fixture()), before = structuredClone(task);
    expect(taskBelongsToShootingDay(task, secondDay)).toBe(true);
    expect(names(task, secondDay)).toEqual(["after-midnight.mov", "unknown.mov", "after-midnight.xml"]);
    expect(names(task, firstDay)).toEqual(["before-midnight.mov", "unknown.mov"]);
    expect(recordsForShootingDay(task, secondDay).find((row) => row.file.name === "unknown.mov")).toMatchObject({ shootingDate: undefined, dateStatus: "pending-allocation", reportDate: secondDay });
    expect(recordsForShootingDay(task, secondDay).find((row) => row.file.name === "after-midnight.mov")).toMatchObject({ shootingDate: secondDay, dateStatus: "confirmed-assignment" });
    expect(task).toEqual(before);
  });

  it("lets an explicitly confirmed overnight session stay together on its start day", () => {
    const task = allocation(fixture());
    task.dateAllocation!.groups[1].assignedDate = firstDay;
    expect(names(task, firstDay)).toHaveLength(4);
    expect(taskBelongsToShootingDay(task, secondDay)).toBe(false);
    expect(names(task, secondDay)).toEqual([]);
  });

  it("never treats a natural date suggestion or unsigned assignment as confirmed", () => {
    const task = allocation(fixture());
    task.dateAllocation!.groups.forEach((group) => { group.confirmedBy = " "; });
    expect(taskBelongsToShootingDay(task, secondDay)).toBe(false);
    expect(recordsForShootingDay(task, firstDay).every((row) => row.dateStatus === "pending-allocation" && !row.shootingDate)).toBe(true);
  });

  it("keeps partial selection exclusions out even if stale records or later full-card assignments mention them", () => {
    const task = selected(allocation(fixture()));
    task.dateAllocation!.groups[0].assignedDate = secondDay;
    expect(names(task, secondDay)).toEqual(["after-midnight.mov", "unknown.mov", "after-midnight.xml"]);
    expect(names(task, firstDay)).not.toContain("before-midnight.mov");
    expect(taskDateContributions(task).find((row) => row.shootingDate === secondDay)?.files).toBe(2);
  });

  it("prefers subsequent confirmed full-card allocation but does not rewrite frozen task dates", () => {
    const task = selected(allocation(fixture()));
    task.selection!.wholeCardCovered = true;
    task.selection!.includedPaths.push("before-midnight.mov");
    task.selection!.excludedFiles = [];
    task.dateAllocation!.groups[1].assignedDate = firstDay;
    expect(names(task, firstDay)).toHaveLength(4);
    expect(names(task, secondDay)).toEqual([]);
    expect(task.shootingDate).toBe(firstDay);
  });

  it("retains unplanned and conflicting records as explicitly unresolved, not last-writer-wins", () => {
    const task = allocation(fixture());
    task.dateAllocation!.groups[0].relativePaths.push("after-midnight.mov");
    task.dateAllocation!.groups.pop();
    const rows = recordsForShootingDay(task, secondDay);
    expect(rows.find((row) => row.file.name === "after-midnight.mov")?.dateStatus).toBe("pending-allocation");
    expect(rows.find((row) => row.file.name === "unknown.mov")?.dateStatus).toBe("pending-allocation");
  });

  it("canonicalizes old compact dates but rejects impossible and unrelated date strings", () => {
    const task = fixture(); task.shootingDate = "20261015";
    expect(names(task, firstDay)).toHaveLength(4);
    expect(requireShootingDay("20261015")).toBe(firstDay);
    for (const day of ["2026-02-30", "2026-13-01", "tomorrow", ""]) expect(() => recordsForShootingDay(task, day)).toThrow(/有效/);
  });

  it("preserves the legacy export fallback explicitly without inventing dates for archive scope", () => {
    const task = fixture(); task.shootingDate = "";
    const legacy = new Date(task.completedAt!).toLocaleDateString("sv-SE");
    expect(recordsForShootingDay(task, legacy).every((row) => row.dateStatus === "legacy-completion-date")).toBe(true);
    expect(taskBelongsToShootingDay(task, legacy)).toBe(false);
    task.shootingDate = "2026-02-30";
    expect(names(task, legacy)).toEqual([]);
  });

  it("retains unresolved files when an ordinary task has assigned dates but no project shooting date", () => {
    const task = allocation(fixture()); task.shootingDate = "";
    expect(names(task, secondDay)).toContain("unknown.mov");
    expect(recordsForShootingDay(task, secondDay).find((row) => row.file.name === "unknown.mov")?.shootingDate).toBeUndefined();
  });

  it("records conservative whole-recorded-volume scope rather than claiming a strict single-day check", () => {
    expect(shootingDayArchiveScopeNote(secondDay)).toContain("每个命中任务的全部已记录文件与目录");
    expect(shootingDayArchiveScopeNote(secondDay)).toContain("不是仅核验该日文件");
    expect(shootingDayArchiveScopeNote(secondDay)).toContain("不提升为整卡完整副本");
  });

  it("includes second-day allocated risk in actual handoff evidence and close-signing task scope", () => {
    const task = allocation(fixture());
    const project: ProjectConfig = { id: task.projectId!, name: "Generated night project", devices: ["FX3"], volumePrefix: "A", requiredCopies: 1, shootingDateStart: firstDay, shootingDateEnd: secondDay };
    const result = appendProjectHandoffEvidence(project, [task], { operator: "Test DIT", note: "Unverified destination disclosed", scope: "day", shootingDate: secondDay, at: 3 });
    expect(result.handoffNotes![0].closeoutEvidence).toMatchObject({ logicalVolumes: 1, compliantVolumes: 0, pendingCells: 1 });
    const safetyTasks = [task].filter((item) => taskBelongsToShootingDay(item, secondDay));
    expect(groupLogicalVolumes(safetyTasks, 1).some((volume) => !volume.compliant)).toBe(true);
    expect(project.handoffNotes).toBeUndefined();
  });
});

describe("local calendar reference for daily summaries", () => {
  it("uses the local day on both sides of UTC midnight while preserving explicit reference dates", () => {
    const bundle = buildSync({ stdin: { contents: `
      import { projectDaySummary } from './src/main/project-closeout';
      const ActualDate = Date;
      class FrozenDate extends ActualDate { constructor(...args) { args.length ? super(...args) : super('2026-10-16T00:30:00Z'); } static now() { return ActualDate.parse('2026-10-16T00:30:00Z'); } }
      globalThis.Date = FrozenDate;
      const local = new Date().toLocaleDateString('sv-SE');
      const project = {id:'synthetic',name:'Generated',devices:['FX3'],volumePrefix:'A'};
      const current = projectDaySummary(project, [], local);
      const explicit = projectDaySummary(project, [], '2026-10-16', '2026-10-15');
      process.stdout.write(JSON.stringify({local,current:current.current,future:current.future,risk:current.risk,explicitCurrent:explicit.current,explicitFuture:explicit.future}));
    `, resolveDir: path.resolve(".") }, bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent" }).outputFiles[0].text;
    for (const [tz, expected] of [["Asia/Shanghai", "2026-10-16"], ["America/Los_Angeles", "2026-10-15"]]) {
      const result = spawnSync(process.execPath, ["-e", bundle], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ local: expected, current: true, future: false, risk: 1, explicitCurrent: false, explicitFuture: true });
    }
  });
});
