import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDaySummary } from "../src/main/project-closeout";
import type { ProjectConfig } from "../src/main/types";
import { BackupEngine } from "../src/main/backup/BackupEngine";

afterEach(() => vi.unstubAllGlobals());

describe("project detail date groups", () => {
  it("collapses a safe day but keeps current risk and its status visible", async () => {
    vi.stubGlobal("window", { api: {} });
    const { ProjectDayGroups } = await import("../src/renderer/src/App");
    const project: ProjectConfig = {
      id: "day-groups",
      name: "Day groups",
      devices: ["FX3"],
      volumePrefix: "FX3_",
      requiredCopies: 2,
      restDays: ["2026-09-18"],
      expectedDevicesByDate: { "2026-09-19": ["FX3"] },
    };
    const summaries = [
      projectDaySummary(project, [], "2026-09-18", "2026-09-19"),
      projectDaySummary(project, [], "2026-09-19", "2026-09-19"),
      projectDaySummary(project, [], "2026-09-20", "2026-09-19"),
    ];
    const html = renderToStaticMarkup(
      <ProjectDayGroups
        project={project}
        summaries={summaries}
        expandedSafeDays={{}}
        onToggleSafeDay={() => {}}
        onUpdateSchedule={() => {}}
        onOpenTask={() => {}}
        onManifestIssue={() => {}}
        onBaseline={() => {}}
      />,
    );
    expect(html).toContain("20260918");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("20260919");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("风险 1");
    expect(html).toContain("当日状态");
    expect(html).toContain("FX3");
    expect(html).toContain("应该有素材 · 缺少备份");
    expect(html).toContain("确认未使用");
    expect(html).toContain("20260920");
    expect(html).toContain("计划日");
    expect(html).toContain("展开这个未来计划日");
    expect(html).toContain("project-day-group planned");
    expect(html).toContain("完整卡副本达标");
  });

  it("uses horizontal scrolling and stable text sizes at narrow widths", () => {
    const css = fs.readFileSync(
      path.resolve("src/renderer/src/style.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.project-day-matrix\s*\{[^}]*overflow-x:\s*auto/s,
    );
    expect(css).toMatch(
      /\.project-day-matrix-head,[\s\S]*?min-width:\s*700px;[\s\S]*?font-size:\s*12px;/,
    );
    expect(css).toMatch(
      /@media \(max-width: 980px\)[\s\S]*?\.project-day-header\s*\{[^}]*grid-template-columns:\s*1fr auto/s,
    );
  });

  it("labels date allocations separately from full-card totals", async () => {
    vi.stubGlobal("window", { api: {} });
    const { ProjectDayGroups } = await import("../src/renderer/src/App"),
      project: ProjectConfig = {
        id: "cross-day-ui",
        name: "Cross day UI",
        devices: ["FX3"],
        volumePrefix: "A_",
        requiredCopies: 1,
      },
      engine = new BackupEngine(),
      allocated = engine.createTask({
        name: "A001",
        sourcePath: "/tmp/a-source",
        destinationPaths: ["/tmp/a-target"],
        devices: ["FX3"],
        shootingDate: "2026-09-18",
        hashAlgorithm: "sha256",
        namingTemplate: "A001",
        projectId: project.id,
      }),
      fullCard = engine.createTask({
        name: "A002",
        sourcePath: "/tmp/b-source",
        destinationPaths: ["/tmp/b-target"],
        devices: ["FX3"],
        shootingDate: "2026-09-19",
        hashAlgorithm: "sha256",
        namingTemplate: "A002",
        projectId: project.id,
      });
    allocated.status = fullCard.status = "completed";
    allocated.destinations[0].verified = true;
    fullCard.destinations[0].verified = true;
    allocated.totalFiles = 3;
    allocated.totalBytes = 300;
    fullCard.totalFiles = 2;
    fullCard.totalBytes = 200;
    allocated.dateAllocation = {
      schemaVersion: 1,
      sourceTaskId: allocated.id,
      sourceEvidenceDigest: "evidence",
      generatedAt: 1,
      updatedAt: 2,
      groups: [
        {
          id: "first",
          label: "first",
          relativePaths: ["first.mov"],
          files: 1,
          bytes: 100,
          suggestionBasis: "user-confirmed",
          suggestionConfidence: "high",
          evidence: [],
          assignedDate: "2026-09-18",
          confirmedAt: 2,
          confirmedBy: "DIT",
        },
        {
          id: "second",
          label: "second",
          relativePaths: ["second.mov"],
          files: 1,
          bytes: 100,
          suggestionBasis: "user-confirmed",
          suggestionConfidence: "high",
          evidence: [],
          assignedDate: "2026-09-19",
          confirmedAt: 2,
          confirmedBy: "DIT",
        },
        {
          id: "pending",
          label: "pending",
          relativePaths: ["pending.mov"],
          files: 1,
          bytes: 100,
          suggestionBasis: "unknown",
          suggestionConfidence: "unknown",
          evidence: [],
        },
      ],
    };
    const summaries = [
        projectDaySummary(
          project,
          [allocated, fullCard],
          "2026-09-18",
          "2026-09-19",
        ),
        projectDaySummary(
          project,
          [allocated, fullCard],
          "2026-09-19",
          "2026-09-19",
        ),
      ],
      html = renderToStaticMarkup(
        <ProjectDayGroups
          project={project}
          summaries={summaries}
          expandedSafeDays={{ "cross-day-ui:2026-09-19": true }}
          onToggleSafeDay={() => {}}
          onUpdateSchedule={() => {}}
          onOpenTask={() => {}}
          onManifestIssue={() => {}}
          onBaseline={() => {}}
        />,
      );

    expect(html).toContain("当日分配");
    expect(html).toContain("整卡");
    expect(html).toContain("1 组待分配（暂留原日期）");
    expect(html).toContain("文件与容量按当日分配统计");
    expect(html).not.toContain("3 个文件 · 300 B · 当日分配");
  });
});
