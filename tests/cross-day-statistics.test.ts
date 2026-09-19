import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import {
  dailyReportContribution,
  generateDailyReport,
  generateProjectReport,
} from "../src/main/backup/ReportGenerator";
import {
  projectCellStatus,
  projectDaySummary,
  verifiedPhysicalCopyCount,
} from "../src/main/project-closeout";
import type {
  BackupTask,
  DailyDeliveryRun,
  ProjectConfig,
} from "../src/main/types";
import { projectDates } from "../src/common/shooting-dates";

const firstDay = "2026-09-15",
  secondDay = "2026-09-16";

function fixture() {
  const project: ProjectConfig = {
      id: "cross-day-project",
      name: "Cross day",
      devices: ["FX3"],
      volumePrefix: "A_",
      requiredCopies: 1,
      shootingDateStart: firstDay,
      shootingDateEnd: firstDay,
    },
    task = new BackupEngine().createTask({
      name: "A001",
      sourcePath: "/tmp/cross-day-source",
      destinationPaths: ["/tmp/cross-day-target"],
      devices: ["FX3"],
      shootingDate: firstDay,
      hashAlgorithm: "sha256",
      namingTemplate: "A001",
      projectId: project.id,
    });
  task.status = "completed";
  task.destinations[0].verified = true;
  task.totalFiles = 5;
  task.totalBytes = 500;
  task.fileRecords = Array.from({ length: 5 }, (_, index) => ({
    name: `clip-${index + 1}.mov`,
    relativePath: `DCIM/clip-${index + 1}.mov`,
    size: 100,
    srcChecksum: String(index).padStart(64, "0"),
    destinations: [
      {
        path: `/tmp/cross-day-target/DCIM/clip-${index + 1}.mov`,
        checksum: String(index).padStart(64, "0"),
        verified: true,
      },
    ],
  }));
  task.dateAllocation = {
    schemaVersion: 1,
    sourceTaskId: task.id,
    sourceEvidenceDigest: "allocation-evidence",
    generatedAt: 1,
    updatedAt: 2,
    groups: [
      {
        id: "day-one",
        label: "day-one",
        relativePaths: ["DCIM/clip-1.mov", "DCIM/clip-2.mov"],
        files: 2,
        bytes: 200,
        suggestionBasis: "user-confirmed",
        suggestionConfidence: "high",
        evidence: [],
        assignedDate: firstDay,
        confirmedAt: 2,
        confirmedBy: "DIT",
      },
      {
        id: "day-two",
        label: "day-two",
        relativePaths: ["DCIM/clip-3.mov", "DCIM/clip-4.mov"],
        files: 2,
        bytes: 250,
        suggestionBasis: "user-confirmed",
        suggestionConfidence: "high",
        evidence: [],
        assignedDate: secondDay,
        confirmedAt: 2,
        confirmedBy: "DIT",
      },
      {
        id: "pending",
        label: "pending",
        relativePaths: ["DCIM/clip-5.mov"],
        files: 1,
        bytes: 50,
        suggestionBasis: "unknown",
        suggestionConfidence: "unknown",
        evidence: [],
      },
    ],
  };
  return { project, task };
}

function deliveryRun(task: BackupTask, id: string): DailyDeliveryRun {
  return {
    id,
    sourceTaskId: task.id,
    projectId: task.projectId,
    shootingDate: secondDay,
    operator: "DIT",
    createdAt: 3,
    completedAt: 4,
    status: "completed",
    sourceDestinationId: task.destinations[0].id,
    sourceRoot: "/tmp/cross-day-target",
    destinationParent: "/tmp/delivery",
    finalPath: `/tmp/delivery/${id}`,
    hashAlgorithm: "sha256",
    allocationDigest: "allocation-evidence",
    totalFiles: 2,
    totalBytes: 250,
    completedFiles: 2,
    completedBytes: 250,
    files: [],
  };
}

describe("cross-day card statistics", () => {
  it("selects assigned days for reports while preserving legacy completion-date reports", () => {
    const { task } = fixture();
    expect(dailyReportContribution(task, secondDay)).toMatchObject({
      files: 2,
      bytes: 250,
      scope: "daily-allocation",
    });
    const legacy = {
      ...task,
      shootingDate: undefined,
      dateAllocation: undefined,
      completedAt: new Date(`${secondDay}T12:00:00`).getTime(),
    };
    expect(dailyReportContribution(legacy, secondDay)).toMatchObject({
      files: 5,
      bytes: 500,
      scope: "full-card",
    });
    expect(dailyReportContribution(legacy, firstDay)).toBeUndefined();
  });

  it("allocates confirmed groups to both days and keeps unresolved material on the task date", () => {
    const { project, task } = fixture(),
      first = projectDaySummary(project, [task], firstDay, secondDay),
      second = projectDaySummary(project, [task], secondDay, secondDay);

    expect(projectDates(project, [task])).toEqual([firstDay, secondDay]);
    expect(first).toMatchObject({
      volumes: 1,
      compliantVolumes: 1,
      files: 3,
      bytes: 250,
      pendingAllocationGroups: 1,
      attention: 1,
    });
    expect(first.logicalVolumes[0]).toMatchObject({
      dateFiles: 3,
      dateBytes: 250,
      allocationScope: "daily-allocation",
      pendingAllocation: true,
      pendingAllocationGroups: 1,
      compliant: true,
    });
    expect(second).toMatchObject({
      volumes: 1,
      compliantVolumes: 1,
      files: 2,
      bytes: 250,
      pendingAllocationGroups: 0,
    });
    expect(first.files + second.files).toBe(task.totalFiles);
    expect(first.bytes + second.bytes).toBe(task.totalBytes);

    expect(
      projectCellStatus(project, [task], firstDay, "FX3"),
    ).toMatchObject({
      safe: 1,
      files: 3,
      bytes: 250,
      pendingAllocationGroups: 1,
      complete: false,
    });
    expect(
      projectCellStatus(project, [task], secondDay, "FX3"),
    ).toMatchObject({
      safe: 1,
      files: 2,
      bytes: 250,
      pendingAllocationGroups: 0,
      complete: true,
    });
  });

  it("never turns daily-delivery runs into backup tasks or independent copies", async () => {
    const { project, task } = fixture(),
      copiesBefore = verifiedPhysicalCopyCount(task),
      summaryBefore = projectDaySummary(project, [task], secondDay, secondDay);
    task.dailyDeliveryRuns = [
      deliveryRun(task, "delivery-one"),
      deliveryRun(task, "delivery-two"),
    ];
    const summaryAfter = projectDaySummary(
        project,
        [task],
        secondDay,
        secondDay,
      ),
      report = (await generateDailyReport([task], secondDay)).toString();

    expect(copiesBefore).toBe(1);
    expect(verifiedPhysicalCopyCount(task)).toBe(copiesBefore);
    expect(summaryAfter.volumes).toBe(summaryBefore.volumes);
    expect(summaryAfter.logicalVolumes).toHaveLength(1);
    expect(summaryAfter.logicalVolumes[0].attempts).toHaveLength(1);
    expect(report).toContain("<strong>1</strong><span>BACKUPS / 备份任务</span>");
    expect(report).toContain("当日分配");
    expect(report).not.toContain("delivery-one");
    expect(report).not.toContain("delivery-two");
  });

  it("does not promote an assigned-date suggestion without confirmation", () => {
    const { project, task } = fixture();
    delete task.dateAllocation!.groups[1].confirmedAt;
    delete task.dateAllocation!.groups[1].confirmedBy;

    expect(projectDates(project, [task])).toEqual([firstDay]);
    expect(
      projectDaySummary(project, [task], firstDay, secondDay),
    ).toMatchObject({
      files: 5,
      bytes: 500,
      pendingAllocationGroups: 2,
    });
    expect(projectDaySummary(project, [task], secondDay, secondDay).volumes).toBe(
      0,
    );
  });

  it("uses allocated quantities in the project report daily trend and matrix", async () => {
    const { project, task } = fixture(),
      report = (await generateProjectReport(project, [task])).toString();
    expect(report).toContain(
      `<td>${firstDay}</td><td>1</td><td>3</td><td>250 B</td>`,
    );
    expect(report).toContain(
      `<td>${secondDay}</td><td>1</td><td>2</td><td>250 B</td>`,
    );
    expect(report).toContain("1 组日期待分配");
  });
});
