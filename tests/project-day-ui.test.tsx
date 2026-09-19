import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDaySummary } from "../src/main/project-closeout";
import type { ProjectConfig } from "../src/main/types";

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
    expect(html).toContain("确认未使用");
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
});
