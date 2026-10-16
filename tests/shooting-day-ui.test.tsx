import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupTask, ProjectConfig } from "../src/main/types";
import type { BackupSelectionGroup } from "../src/common/backup-selection";
import { projectShootingDates, readProjectShootingChoice, resolveProjectShootingChoice } from "../src/renderer/src/project-shooting-choice";
import { applyBatchShootingDate, batchAssignableGroups } from "../src/renderer/src/selection-date-assignment";

const project: ProjectConfig = {
  id: "synthetic-night", name: "Generated overnight fixture", devices: ["Camera"],
  devicePositions: { Camera: ["A", "B"] }, volumePrefix: "CARD_",
  shootingDateStart: "2026-10-14", shootingDateEnd: "2026-10-17",
  expectedDevicesByDate: { "2026-10-15": ["Drone::B", "Recorder", "Recorder::A"] },
};
const tasks = [
  { projectId: project.id, shootingDate: "20261012" },
  { projectId: project.id, shootingDate: "2026-02-31" },
  { projectId: "another-project", shootingDate: "2026-10-11" },
] as BackupTask[];
const group = (id: string, date?: string, mandatory = false): BackupSelectionGroup => ({
  id, label: id, files: 2, bytes: 10, relativePaths: [`${id}.MP4`, `${id}.XML`],
  suggestedDate: date, candidateDates: date ? [date] : [], basis: "file-modified-time",
  confidence: date ? "review" : "unknown", evidence: ["Synthetic file-time clue"],
  mandatory, mandatoryReason: mandatory ? "Shared package" : undefined,
  historyState: "not-found", historyCopies: 0, historyEvidence: [],
});

afterEach(() => vi.unstubAllGlobals());

describe("project shooting day is a persistent human choice, not a midnight clock", () => {
  it("offers historical task days and future project days but not foreign or impossible dates", () => {
    expect(projectShootingDates(project, tasks)).toEqual([
      "2026-10-12", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17",
    ]);
  });

  it("uses explicit day before remembered day, then today or the project start", () => {
    const recent = { shootDate: "2026-10-15" };
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", { shootingDate: "20261012" }, recent).shootDate).toBe("2026-10-12");
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, recent).shootDate).toBe("2026-10-15");
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16").shootDate).toBe("2026-10-16");
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-25").shootDate).toBe("2026-10-14");
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", { shootingDate: "2026-02-31" }, { shootDate: "2026-02-31" }).shootDate).toBe("2026-10-16");
  });

  it("preserves temporary positions and an intentional unpositioned choice only on their planned day", () => {
    const recent = { shootDate: "2026-10-15", camera: "Drone", multiPosition: true, cameraPosition: "B" };
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, recent)).toEqual({ ...recent, shootDateExplicit: true });
    const otherDay = resolveProjectShootingChoice(project, tasks, "2026-10-16", { shootingDate: "2026-10-16" }, recent);
    expect(otherDay.camera).toBe("Camera");
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, {
      shootDate: "2026-10-15", camera: "Recorder", multiPosition: false, cameraPosition: "A",
    }).multiPosition).toBe(false);
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {
      shootingDate: "2026-10-15", device: "Drone", position: "B",
    }).cameraPosition).toBe("B");
  });

  it("reads and validates local preferences without writing them on initial resolution", () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ shootDate: "2026-10-15", camera: "Drone", cameraPosition: "B", multiPosition: true }), setItem });
    const recent = readProjectShootingChoice(project.id);
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, recent).shootDate).toBe("2026-10-15");
    expect(setItem).not.toHaveBeenCalled();
    for (const content of ["null", "[]", "not-json"] ) {
      vi.stubGlobal("localStorage", { getItem: () => content });
      expect(readProjectShootingChoice(project.id)).toEqual({});
    }
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); } });
    expect(readProjectShootingChoice(project.id)).toEqual({});
  });

  it("does not reuse an automatically chosen day as a recent human choice after midnight", () => {
    const first = resolveProjectShootingChoice(project, tasks, "2026-10-15");
    expect(first.shootDateExplicit).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(first) });
    const next = resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, readProjectShootingChoice(project.id));
    expect(next.shootDate).toBe("2026-10-16");
    expect(next.shootDateExplicit).toBe(false);
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ ...first, shootDateExplicit: true }) });
    expect(resolveProjectShootingChoice(project, tasks, "2026-10-16", {}, readProjectShootingChoice(project.id)).shootDate).toBe("2026-10-15");
  });

  it("renders historical/future temporary-device options and explains overnight behavior", async () => {
    vi.stubGlobal("window", { api: {} });
    const { TemporaryDeviceForm } = await import("../src/renderer/src/TemporaryDeviceForm");
    const html = renderToStaticMarkup(<TemporaryDeviceForm project={project} tasks={tasks} shootingDate="2026-10-12" operator="Fixture DIT" onClose={() => {}} onSaved={() => {}} />);
    expect(html).toContain('value="2026-10-12" selected=""');
    expect(html).toContain('value="2026-10-17"');
    expect(html).not.toContain('value="2026-02-31"');
    expect(html).toContain("拍摄归属日");
    expect(html).toContain("不随零点自动切换");
    expect(html).toContain("不提前创建空文件夹");
    expect(html).toContain("已保存的日计划仍保留");
  });
});

describe("safe batch assignment only edits unconfirmed UI metadata", () => {
  const groups = [group("day-before", "2026-10-14"), group("after-midnight", "2026-10-16"), group("shared", "2026-10-16", true), group("unknown"), group("invalid", "2026-02-31")];

  it("keeps families intact, does not mutate source evidence, and never assigns mandatory or unknown groups", () => {
    const assignments = { unknown: "2026-10-16" }, dates = ["2026-10-14", "2026-10-16"];
    const before = structuredClone({ groups, assignments, dates });
    const result = applyBatchShootingDate(groups, assignments, dates, "2026-10-16", "2026-10-15");
    expect(result).toEqual({ assignedDates: { unknown: "2026-10-16", "after-midnight": "2026-10-15" }, selectedDates: ["2026-10-14", "2026-10-16", "2026-10-15"], changedGroups: 1, changedFiles: 2, acknowledged: false });
    expect({ groups, assignments, dates }).toEqual(before);
    expect(result.assignedDates).not.toHaveProperty("shared");
    expect(result.assignedDates).not.toHaveProperty("invalid");
  });

  it("respects the current manual assignment, never the original date after a correction", () => {
    const assignments = { "after-midnight": "2026-10-15" };
    expect(batchAssignableGroups(groups, assignments, "2026-10-16")).toHaveLength(0);
    expect(batchAssignableGroups(groups, assignments, "2026-10-15").map(item => item.id)).toEqual(["after-midnight"]);
    expect(() => applyBatchShootingDate(groups, assignments, [], "2026-10-16", "2026-10-15")).toThrow(/没有可批量修正/);
  });

  it("rejects invalid and no-op edits rather than changing inclusion or silently picking a day", () => {
    for (const date of ["", "2026-02-31", "2026-10-16"]) expect(() => applyBatchShootingDate(groups, {}, [], "2026-10-16", date)).toThrow(/不同且有效/);
    expect(batchAssignableGroups(groups, {}, "2026-02-31")).toEqual([]);
  });

  it("renders collapsed with empty from/to choices, a disabled action and explicit final-confirmation scope", async () => {
    vi.stubGlobal("window", { api: {} });
    const { BatchShootingDateAssignment } = await import("../src/renderer/src/BackupSelectionPanel");
    const html = renderToStaticMarkup(<BatchShootingDateAssignment groups={groups} assignedDates={{}} selectedDates={["2026-10-16"]} shootingDate="2026-10-15" disabled={false} onApply={() => {}} />);
    expect(html).toContain('<details class="backup-selection-batch">');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('value="" selected=""');
    expect(html).toContain('type="date"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>应用到 0 组<\/button>/);
    expect(html).toContain("不修改源文件时间");
    expect(html).toContain("不自动取消任何日期的备份");
    expect(html).toContain("这里的修正不会改变该目录");
    expect(html).not.toContain('value="2026-02-31"');
  });
});
