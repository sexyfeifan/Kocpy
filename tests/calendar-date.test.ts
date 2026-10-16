import { describe, expect, it } from "vitest";
import {
  canonicalCalendarDate,
  compactCalendarDate,
} from "../src/common/calendar-date";
import { renderProjectCardPath } from "../src/common/project-layout";
import { projectDates, shootingDateKey } from "../src/common/shooting-dates";
import { compactDate, projectShootingDates } from "../src/main/project-path";
import type { BackupTask, ProjectConfig } from "../src/main/types";

const project = (start: string, end = start): ProjectConfig => ({
  id: "calendar",
  name: "Calendar",
  devices: ["FX3"],
  volumePrefix: "FX3_",
  shootingDateStart: start,
  shootingDateEnd: end,
});

describe("strict calendar dates for project paths", () => {
  it.each([
    ["20240229", "2024-02-29"],
    ["2024-02-29", "2024-02-29"],
    ["20261231", "2026-12-31"],
    ["2026-12-31", "2026-12-31"],
  ])("accepts 8-digit and ISO real dates: %s", (input, expected) => {
    expect(canonicalCalendarDate(input)).toBe(expected);
    expect(shootingDateKey(input)).toBe(expected);
    expect(compactCalendarDate(input, "invalid")).toBe(
      expected.replace(/-/g, ""),
    );
    expect(compactDate(input)).toBe(expected.replace(/-/g, ""));
  });

  it.each([
    "2026-02-29",
    "2026-02-30",
    "2024-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026/08/07",
  ])("rejects impossible or unsupported path date %s", (input) => {
    expect(canonicalCalendarDate(input)).toBeUndefined();
    expect(() => compactDate(input)).toThrow("项目拍摄日期无效");
    expect(() =>
      renderProjectCardPath("{shootingDate}/{card}", {
        projectFolderName: "20261015_Calendar",
        projectName: "Calendar",
        projectStartDate: "2026-10-15",
        shootingDate: input,
        device: "FX3",
        card: "A001",
      }),
    ).toThrow("项目拍摄日期无效");
  });

  it("renders identical paths independent of local DST or timezone offsets", () => {
    expect(projectShootingDates("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(projectShootingDates("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("does not roll invalid project boundaries into a different real day", () => {
    expect(projectDates(project("2026-02-30"), [])).toEqual([
      "2026-02-30",
    ]);
    expect(projectDates(project("2026-02-28", "2026-02-30"), [])).toEqual([
      "2026-02-28",
      "2026-02-30",
    ]);
  });

  it("keeps an invalid historical task key visible without treating it as a real range day", () => {
    const legacy = {
      id: "legacy",
      projectId: "calendar",
      shootingDate: "2026-02-30",
    } as BackupTask;
    expect(projectDates(project("2026-03-01"), [legacy])).toEqual([
      "2026-02-30",
      "2026-03-01",
    ]);
  });
});
