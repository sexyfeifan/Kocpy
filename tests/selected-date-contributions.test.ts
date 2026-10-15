import { describe, expect, it } from "vitest";
import { taskDateContributions, assignedShootingDates } from "../src/common/date-allocation";
import { projectDaySummary } from "../src/main/project-closeout";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { BackupSelectionPlan } from "../src/common/backup-selection";
import type { ProjectConfig } from "../src/main/types";

const originalDay = "2026-10-15", otherDay = "2026-10-14";
function fixture() {
  const task = new BackupEngine().createTask({ name: "Generated selection", sourcePath: "/synthetic/card", destinationPaths: ["/synthetic/backup"], devices: ["FX3"], shootingDate: originalDay, hashAlgorithm: "sha256", namingTemplate: "selected", projectId: "selected-project" });
  const sourceFiles = ["A.mov", "B.mov", "B.xml", "unknown.dat", "excluded.mov"].map((relativePath, index) => ({ relativePath, size: (index + 1) * 10, sha256: "a".repeat(64), mtimeMs: 1, ctimeMs: 1, dev: 1, ino: index + 1 }));
  const group = (id: string, paths: string[], suggestedDate?: string) => ({ id, label: id, relativePaths: paths, files: paths.length, bytes: sourceFiles.filter((file) => paths.includes(file.relativePath)).reduce((sum, file) => sum + file.size, 0), suggestedDate, candidateDates: suggestedDate ? [suggestedDate] : [], basis: "unknown" as const, confidence: "unknown" as const, evidence: [], mandatory: !suggestedDate, historyState: "not-found" as const, historyCopies: 0, historyEvidence: [] });
  task.selection = {
    schemaVersion: 1, id: "generated-plan", sourcePath: task.sourcePath, projectId: task.projectId, requiredCopies: 1, generatedAt: 1,
    sourceScope: { policy: { version: "complete-v2", mode: "complete", createdAt: 1, includeHidden: true, includeAppleDouble: true, includeSystemMetadata: true, includeEmptyDirectories: true, symlinkPolicy: "fail", specialFilePolicy: "fail" }, capturedAt: 1, sourcePath: task.sourcePath, fingerprint: "a".repeat(64), includedFiles: 5, includedBytes: 150, includedDirectories: 0, includedDirectoryPaths: [], excludedFiles: 0, excludedBytes: 0, excludedDirectories: 0, exclusions: [] },
    sourceVolumeIdentity: { id: "generated", name: "Synthetic", device: "disk-test" }, sourceRootBinding: { dev: 1, ino: 1 }, sourceFiles,
    groups: [group("a", ["A.mov"], originalDay), group("b", ["B.mov", "B.xml"], otherDay), group("unknown", ["unknown.dat"]), group("excluded", ["excluded.mov"], originalDay)],
    digest: "a".repeat(64), selectedDates: [originalDay, otherDay], assignedDates: { a: originalDay, b: otherDay }, includedPaths: ["A.mov", "B.mov", "B.xml", "unknown.dat"],
    excludedFiles: [{ relativePath: "excluded.mov", groupId: "excluded", reason: "user-date", historyEvidence: [] }], confirmedAt: 2, operator: "Fixture DIT", wholeCardCovered: false,
  } satisfies BackupSelectionPlan;
  task.totalFiles = 4; task.totalBytes = 100;
  return task;
}

describe("selected scope day projections", () => {
  it("counts only included paths once, assigns confirmed dates and keeps unknown on the task day", () => {
    const task = fixture();
    task.selection!.includedPaths.push("B.mov");
    expect(taskDateContributions(task)).toEqual([
      { shootingDate: otherDay, files: 2, bytes: 50, scope: "selected-scope", pendingAllocation: false, pendingGroups: 0 },
      { shootingDate: originalDay, files: 2, bytes: 50, scope: "selected-scope", pendingAllocation: true, pendingGroups: 1 },
    ]);
    expect(assignedShootingDates(task)).toEqual([otherDay, originalDay]);
    const project: ProjectConfig = { id: "selected-project", name: "Generated", devices: ["FX3"], volumePrefix: "A" };
    const sum = [otherDay, originalDay].map((day) => projectDaySummary(project, [task], day));
    expect(sum.reduce((count, day) => count + day.files, 0)).toBe(4);
    expect(sum.reduce((bytes, day) => bytes + day.bytes, 0)).toBe(100);
  });

  it("does not treat suggested dates or selected date checkboxes as confirmed assignments", () => {
    const task = fixture(); task.selection!.assignedDates = {};
    expect(taskDateContributions(task)).toEqual([{ shootingDate: originalDay, files: 4, bytes: 100, scope: "selected-scope", pendingAllocation: true, pendingGroups: 3 }]);
  });

  it("does not use unsigned assignments and never adds previously excluded files from a later plan", () => {
    const task = fixture(); task.selection!.operator = " ";
    task.dateAllocation = { schemaVersion: 1, sourceTaskId: task.id, sourceEvidenceDigest: "a".repeat(64), generatedAt: 1, updatedAt: 2, groups: [{ id: "wrong", label: "wrong", relativePaths: ["excluded.mov"], files: 1, bytes: 50, suggestionBasis: "user-confirmed", suggestionConfidence: "high", evidence: [], assignedDate: otherDay, confirmedAt: 3, confirmedBy: "DIT" }] };
    const contributions = taskDateContributions(task);
    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({ files: 4, bytes: 100, pendingAllocation: true });
  });

  it("does not choose a winner when duplicate group membership disagrees", () => {
    const task = fixture();
    task.selection!.groups[0].relativePaths.push("B.mov");
    expect(taskDateContributions(task)).toEqual([
      { shootingDate: otherDay, files: 1, bytes: 30, scope: "selected-scope", pendingAllocation: false, pendingGroups: 0 },
      { shootingDate: originalDay, files: 3, bytes: 70, scope: "selected-scope", pendingAllocation: true, pendingGroups: 2 },
    ]);
  });
});
