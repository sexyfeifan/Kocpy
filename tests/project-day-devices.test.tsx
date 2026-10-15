import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProjectDayDeviceAllowed, projectDayDevices, temporaryDeviceScheduleKey, validateTemporaryDevicePlan } from "../src/common/project-day-devices";
import { recordDailyPlanDecision } from "../src/main/project-evidence";
import { projectDaySummary } from "../src/main/project-closeout";
import type { ProjectConfig } from "../src/main/types";

const project = (): ProjectConfig => ({
  id: "day-device-fixture",
  name: "Generated test project",
  projectFolderName: "20261014_Generated",
  shootingDateStart: "2026-10-14",
  shootingDateEnd: "2026-10-16",
  devices: ["FX3"],
  devicePositions: { FX3: ["A", "B"] },
  volumePrefix: "CARD_",
  directoryCreationMode: "precreate",
});
const add = (value: ProjectConfig, key: string, day = "2026-10-15") => recordDailyPlanDecision(value, {
  date: day, scheduleKey: key, decision: "expected", operator: "Fixture DIT", purpose: "temporary-device", at: 123,
});

afterEach(() => vi.unstubAllGlobals());

describe("temporary devices belong to their selected shooting day", () => {
  it("keeps the permanent configuration and existing project untouched", () => {
    const original = project(), before = structuredClone(original);
    const result = add(original, "Drone::A");
    expect(original).toEqual(before);
    expect(result.devices).toEqual(["FX3"]);
    expect(result.devicePositions).toEqual({ FX3: ["A", "B"] });
    expect(result.directoryCreationMode).toBe("precreate");
    expect(result.managedProjectDirectories).toBeUndefined();
    expect(result.expectedDevicesByDate).toEqual({ "2026-10-15": ["Drone::A"] });
    expect(result.dailyPlanDecisions).toEqual([expect.objectContaining({ date: "2026-10-15", scheduleKey: "Drone::A", operator: "Fixture DIT" })]);
  });

  it("appears in today's summary and not other project dates", () => {
    const value = add(project(), "Drone::A");
    expect(projectDaySummary(value, [], "2026-10-15").cells.map((cell) => cell.scheduleKey)).toContain("Drone::A");
    expect(projectDaySummary(value, [], "2026-10-14").cells.map((cell) => cell.scheduleKey)).not.toContain("Drone::A");
    expect(projectDaySummary(value, [], "2026-10-16").cells.map((cell) => cell.scheduleKey)).not.toContain("Drone::A");
  });

  it("permits an explicitly configured day and position but rejects cross-day or unconfigured selections", () => {
    const value = add(project(), "Drone::A");
    expect(() => assertProjectDayDeviceAllowed(value, "20261015", "Drone", "A")).not.toThrow();
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-14", "Drone", "A")).toThrow(/加入此拍摄日/);
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-15", "Drone")).toThrow(/机位/);
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-15", "Drone", "B")).toThrow(/机位/);
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-15", "FX3", "A")).not.toThrow();
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-15", "FX3")).not.toThrow();
  });

  it("supports a temporary extra position of a permanent device without expanding it to other days", () => {
    const value = add(project(), "FX3::C");
    expect(projectDayDevices(value, "2026-10-15")[0].positions).toEqual(["A", "B", "C"]);
    expect(projectDayDevices(value, "2026-10-16")[0].positions).toEqual(["A", "B"]);
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-16", "FX3", "C")).toThrow(/机位/);
  });

  it("supports an unpositioned temporary device and preserves a later explicitly selected position", () => {
    const value = add(add(project(), "Recorder"), "Recorder::B");
    expect(projectDayDevices(value, "2026-10-15").find((entry) => entry.device === "Recorder")).toEqual({ device: "Recorder", positions: ["B"], allowUnpositioned: true, temporary: true });
    expect(() => assertProjectDayDeviceAllowed(value, "2026-10-15", "Recorder")).not.toThrow();
    const cells = projectDaySummary(value, [], "2026-10-15").cells;
    expect(cells.find((cell) => cell.scheduleKey === "Recorder::unassigned")).toMatchObject({ expected: true, complete: false });
    expect(cells.find((cell) => cell.scheduleKey === "Recorder::B")).toMatchObject({ expected: true, complete: false });
  });

  it("revokes today's parent unused exemption only for the added position and audits preserved siblings", () => {
    const value = { ...project(), unusedDevicesByDate: { "20261015": ["FX3"], "2026-10-16": ["FX3"] } };
    const saved = add(value, "FX3::C");
    const cells = projectDaySummary(saved, [], "2026-10-15").cells;
    expect(cells.find((cell) => cell.scheduleKey === "FX3::C")).toMatchObject({ expected: true, exempt: false, complete: false });
    expect(cells.find((cell) => cell.scheduleKey === "FX3::A")).toMatchObject({ exempt: true, complete: true });
    expect(cells.find((cell) => cell.scheduleKey === "FX3::B")).toMatchObject({ exempt: true, complete: true });
    expect(saved.unusedDevicesByDate?.["2026-10-15"]).toEqual(expect.arrayContaining(["FX3::A", "FX3::B"]));
    expect(saved.unusedDevicesByDate?.["2026-10-15"]).not.toContain("FX3");
    expect(saved.unusedDevicesByDate?.["2026-10-16"]).toEqual(["FX3"]);
    expect(saved.dailyPlanDecisions?.map(({ scheduleKey, decision }) => [scheduleKey, decision])).toEqual([
      ["FX3", "clear"], ["FX3::A", "unused"], ["FX3::B", "unused"], ["FX3::C", "expected"],
    ]);
    expect(add(saved, "FX3::C")).toEqual(saved);
    expect(value.unusedDevicesByDate["20261015"]).toEqual(["FX3"]);
  });

  it("restores an explicitly unused unpositioned unit without exempting or changing positioned units", () => {
    const saved = add({ ...project(), unusedDevicesByDate: { "2026-10-15": ["FX3::unassigned", "FX3::A"] } }, "FX3");
    const cells = projectDaySummary(saved, [], "2026-10-15").cells;
    expect(cells.find((cell) => cell.scheduleKey === "FX3::unassigned")).toMatchObject({ expected: true, exempt: false, complete: false });
    expect(cells.find((cell) => cell.scheduleKey === "FX3::A")).toMatchObject({ exempt: true, complete: true });
  });

  it("makes duplicate saves idempotent without duplicating audit decisions", () => {
    const once = add(project(), "Drone::A");
    expect(add(once, "Drone::A")).toEqual(once);
    expect(add(once, "Drone::A").dailyPlanDecisions).toHaveLength(1);
  });

  it("records restoration of a rest day and never silently leaves the new plan exempt", () => {
    const original = { ...project(), restDays: ["20261015"] };
    const saved = add(original, "Drone");
    expect(saved.restDays).toEqual([]);
    expect(saved.dailyPlanDecisions?.map((entry) => entry.decision)).toEqual(["working", "expected"]);
    expect(projectDaySummary(saved, [], "2026-10-15").cells.find((cell) => cell.device === "Drone")?.statusLabel).toContain("缺少备份");
    expect(original.restDays).toEqual(["20261015"]);
  });

  it("allows choosing a historical device for another day only after an explicit new decision", () => {
    const once = add(project(), "Drone");
    expect(() => assertProjectDayDeviceAllowed(once, "2026-10-16", "Drone")).toThrow();
    const twice = add(once, "Drone", "2026-10-16");
    expect(() => assertProjectDayDeviceAllowed(twice, "2026-10-16", "Drone")).not.toThrow();
    expect(twice.devices).toEqual(["FX3"]);
    expect(twice.dailyPlanDecisions).toHaveLength(2);
  });

  it("treats unused or cleared temporary devices as unavailable for new backups", () => {
    const value = add(project(), "Drone");
    const unused = recordDailyPlanDecision(value, { date: "2026-10-15", scheduleKey: "Drone", decision: "unused", operator: "Fixture DIT" });
    expect(() => assertProjectDayDeviceAllowed(unused, "2026-10-15", "Drone")).toThrow();
    const restored = add(unused, "Drone");
    expect(() => assertProjectDayDeviceAllowed(restored, "2026-10-15", "Drone")).not.toThrow();
    expect(restored.unusedDevicesByDate?.["2026-10-15"]).toEqual([]);
  });

  it.each(["../Drone", "A/B", "A\\B", "A:B", "A?B", "..", ".", "a\0b", "A".repeat(101)])("rejects unsafe or silently renamed new name %j", (name) => {
    expect(() => temporaryDeviceScheduleKey(name)).toThrow(/名称/);
  });

  it("rejects aliases, reserved positions and custom rules that collapse distinct devices", () => {
    expect(() => validateTemporaryDevicePlan(project(), "2026-10-15", "fx3")).toThrow(/相同目录/);
    expect(() => validateTemporaryDevicePlan(project(), "2026-10-15", "FX3::a")).toThrow(/相同目录/);
    expect(() => temporaryDeviceScheduleKey("Drone", "unassigned")).toThrow(/保留名称/);
    expect(() => add({ ...project(), namingRule: "{date}_{project}/{shootingDate}/{card}" }, "Drone")).toThrow(/共用目录/);
    const accented = add(project(), "Café");
    expect(() => validateTemporaryDevicePlan(accented, "2026-10-16", "CAFÉ")).toThrow(/相同目录/);
  });

  it("requires an operator and rejects archived projects", () => {
    expect(() => recordDailyPlanDecision(project(), { date: "2026-10-15", scheduleKey: "Drone", decision: "expected", purpose: "temporary-device", operator: " " })).toThrow(/操作人/);
    const archived = { ...project(), status: "archived" as const };
    expect(() => add(archived, "Drone")).toThrow(/归档/);
    expect(() => assertProjectDayDeviceAllowed(archived, "2026-10-15", "FX3")).toThrow(/归档/);
    expect(() => assertProjectDayDeviceAllowed({ ...project(), expectedDevicesByDate: { "2026-10-15": ["../old-device"] } }, "2026-10-15", "../old-device")).toThrow(/名称/);
  });

  it("preserves the day context on the primary project-day action and exposes the saved-plan explanation", async () => {
    vi.stubGlobal("window", { api: {} });
    const { ProjectDayGroups } = await import("../src/renderer/src/App");
    const { TemporaryDeviceForm } = await import("../src/renderer/src/TemporaryDeviceForm");
    const value = project();
    const dayMarkup = renderToStaticMarkup(<ProjectDayGroups project={value} summaries={[projectDaySummary(value, [], "2026-10-15", "2026-10-15")]} expandedSafeDays={{}} onToggleSafeDay={() => {}} onUpdateSchedule={() => {}} onOpenTask={() => {}} onManifestIssue={() => {}} onBaseline={() => {}} onNewBackup={() => {}} />);
    expect(dayMarkup).toContain("当日新建备份");
    expect(dayMarkup).toContain("添加当日设备并备份");
    const formMarkup = renderToStaticMarkup(<TemporaryDeviceForm project={value} shootingDate="2026-10-15" operator="Fixture DIT" onClose={() => {}} onSaved={() => {}} />);
    expect(formMarkup).toContain('value="2026-10-15" selected=""');
    expect(formMarkup).toContain("实际操作人");
    expect(formMarkup).toContain("已保存的日计划仍保留");
    expect(formMarkup).toContain("不提前创建空文件夹");
  });
});
