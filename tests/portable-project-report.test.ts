import { describe, expect, it } from "vitest";
import { generateProjectReport } from "../src/main/backup/ReportGenerator";
import { assertProjectReportAvailable } from "../src/main/portable-project-report";
import { validateWorkspacePackage } from "../src/main/lifecycle";
import {
  applyWorkspaceMerge,
  type WorkspaceExchangeState,
} from "../src/main/workstation-exchange";
import { appendProjectRuleSnapshot } from "../src/main/project-evidence";
import type { ProjectConfig } from "../src/main/types";
import type { PortableProjectImportRecord } from "../src/common/portable-project";
const receipt: PortableProjectImportRecord = {
  id: "receipt-one",
  projectId: "project-one",
  sha256: "a".repeat(64),
  revision: "revision-one",
  root: "/synthetic/source",
  operator: "合成人 <script>",
  importedAt: 1,
  project: {
    id: "project-one",
    name: "合成项目",
    devices: ["FX3"],
    plannedStart: "2026-10-15",
    plannedEnd: "2026-10-16",
  },
  rolls: [
    {
      id: "original-task",
      name: "A001",
      dates: ["2026-10-15"],
      devices: ["FX3"],
      status: "completed",
      files: 2,
      bytes: 42,
      scope: "选定范围（不是整卡）",
    },
  ],
  provenance: "recorded-history",
  files: 2,
  bytes: 42,
  exclusions: 1,
};
const project: ProjectConfig = {
  id: receipt.projectId,
  name: "合成项目",
  devices: ["FX3"],
  volumePrefix: "CARD_",
  portableHistory: [receipt],
};
describe("portable history downstream consumers", () => {
  it("allows PDF and JSON references without inventing task CSV or archive manifests", () => {
    for (const format of ["pdf", "json"])
      expect(() =>
        assertProjectReportAvailable(project, 0, format),
      ).not.toThrow();
    for (const format of ["csv", "bundle"])
      expect(() => assertProjectReportAvailable(project, 0, format)).toThrow(
        "本机尚无拷卡任务",
      );
    expect(() =>
      assertProjectReportAvailable(
        { ...project, portableHistory: [] },
        0,
        "pdf",
      ),
    ).toThrow("没有可导出");
    expect(() =>
      assertProjectReportAvailable(project, 1, "bundle"),
    ).not.toThrow();
  });
  it("does not let ordinary project editing erase or forge inheritance evidence", () => {
    expect(
      appendProjectRuleSnapshot(project, { ...project, portableHistory: [] })
        .portableHistory,
    ).toEqual([receipt]);
    expect(
      appendProjectRuleSnapshot(undefined, project).portableHistory,
    ).toEqual([]);
  });
  it("produces a reference report instead of false empty day grids or an invented closeout result", async () => {
    const html = (await generateProjectReport(project, [])).toString();
    expect(html).toContain("合成项目");
    expect(html).toContain("随盘项目历史参考报告");
    expect(html).toContain("本机没有拷卡任务");
    expect(html).toContain("不计入下方本机任务与独立副本统计");
    expect(html).toContain("2026-10-15");
    expect(html).toContain("A001");
    expect(html).toContain("有意移除 1 项");
    expect(html).not.toContain("全部拍摄日和设备均满足收工要求");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("validates project identity for historical references, including exchanged metadata", () => {
    const value = {
      application: "Kocpy",
      schema: 1,
      projects: [project],
      tasks: [],
    };
    expect(validateWorkspacePackage(value).projects[0].portableHistory).toEqual(
      [receipt],
    );
    expect(() =>
      validateWorkspacePackage({
        ...value,
        projects: [
          { ...project, portableHistory: [{ ...receipt, projectId: "other" }] },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateWorkspacePackage({
        ...value,
        projects: [{ ...project, portableHistory: [receipt, receipt] }],
      }),
    ).toThrow("重复");
  });
  it("merges receipts append-only and idempotently, rather than overwriting local evidence as ordinary configuration", () => {
    const current: WorkspaceExchangeState = {
      projects: [project],
      tasks: [],
      templates: [],
      healthRecords: [],
      archiveChanges: [],
      archiveReminders: [],
      archiveRuns: [],
      taskTombstones: [],
      projectTombstones: [],
    };
    const incoming = validateWorkspacePackage({
      application: "Kocpy",
      schema: 1,
      projects: [
        {
          ...project,
          portableHistory: [{ ...receipt, id: "receipt-two", importedAt: 2 }],
        },
      ],
      tasks: [],
    });
    const merged = applyWorkspaceMerge({
      current,
      value: incoming,
      decisions: [],
    });
    expect(merged.state.projects[0].portableHistory?.map((r) => r.id)).toEqual([
      "receipt-one",
      "receipt-two",
    ]);
    expect(
      applyWorkspaceMerge({
        current: merged.state,
        value: incoming,
        decisions: [],
      }).state.projects[0].portableHistory,
    ).toHaveLength(2);
    expect(merged.state.tasks).toEqual([]);
  });
});
