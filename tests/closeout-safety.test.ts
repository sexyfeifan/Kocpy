import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { projectCellStatus, projectCloseoutSummary } from "../src/main/project-closeout";
import type { ProjectConfig } from "../src/main/types";
import { projectDates, updateSchedule } from "../src/common/shooting-dates";

const date = "2026-08-25";
function fixture() {
  const project: ProjectConfig = {
    id: "synthetic-closeout", name: "Synthetic", devices: ["FX3"],
    volumePrefix: "CARD", requiredCopies: 1,
    expectedDevicesByDate: { [date]: ["FX3"] },
  };
  const task = new BackupEngine().createTask({
    name: "A001", sourcePath: "/tmp/synthetic-source", destinationPaths: ["/tmp/synthetic-target"],
    hashAlgorithm: "sha256", devices: ["FX3"], shootingDate: date, namingTemplate: "A001",
  });
  return { project, task };
}

describe("closeout cannot hide recorded unsafe material", () => {
  it.each(["pending", "running", "paused", "verifying", "failed", "cancelled", "unverified"] as const)(
    "includes an expected device with %s material in attention", (status) => {
      const { project, task } = fixture();
      task.status = status;
      const cell = projectCellStatus(project, [task], date, "FX3");
      expect(cell.complete).toBe(false);
      expect(cell.attention).toBe(true);
      expect(projectCloseoutSummary(project, [task], [date]).pending).toHaveLength(1);
    },
  );
  it.each(["rest", "unused"])("does not exempt existing failed material using a %s declaration", (declaration) => {
    const { project, task } = fixture();
    if (declaration === "rest") project.restDays = [date];
    else project.unusedDevicesByDate = { [date]: ["FX3"] };
    task.status = "failed";
    const cell = projectCellStatus(project, [task], date, "FX3");
    expect(cell.exempt).toBe(false);
    expect(cell.complete).toBe(false);
    expect(cell.attention).toBe(true);
    expect(cell.label).not.toMatch(/休息日|当天未使用/);
    // The original declaration is preserved; only the live conclusion changes.
    expect(projectCellStatus(project, [], date, "FX3").exempt).toBe(true);
  });
  it("keeps a verified expected device complete, but a missing expected device pending", () => {
    const { project, task } = fixture();
    task.status = "completed";
    task.destinations[0].verified = true;
    expect(projectCellStatus(project, [task], date, "FX3")).toMatchObject({ complete: true, attention: false });
    expect(projectCellStatus(project, [], date, "FX3")).toMatchObject({ complete: false, attention: true });
  });
  it("treats compact and ISO dates as the same shooting day without mutating history", () => {
    const { project, task } = fixture(); task.shootingDate = "20260825";
    task.status = "completed"; task.destinations[0].verified = true;
    expect(projectCellStatus(project, [task], date, "FX3").safe).toBe(1);
    expect(projectCloseoutSummary(project, [task], [date, "20260825"]).total).toBe(1);
    expect(task.shootingDate).toBe("20260825");
    expect(projectDates({ ...project, shootingDateStart: date, shootingDateEnd: date }, [task])).toEqual([date]);
    project.unusedDevicesByDate = { "20260825": ["FX3"] };
    expect(projectCellStatus(project, [], date, "FX3").exempt).toBe(true);
    const cleared = updateSchedule(project, date, "FX3", "clear");
    expect(projectCellStatus(cleared, [], date, "FX3").exempt).toBe(false);
    expect(project.unusedDevicesByDate["20260825"]).toEqual(["FX3"]);
  });
});
