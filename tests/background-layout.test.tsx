import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BackgroundActivityOverview, BackgroundTasksPage } from "../src/renderer/src/BackgroundTasks";
import type { BackgroundActivitySummary } from "../src/renderer/src/api";

vi.hoisted(() => { vi.stubGlobal("window", { api: {} }); });

const activity = {
  id: "synthetic-task", kind: "maintenance", name: "范围复核", state: "completed",
  phase: "validating", progress: 1, totalBytes: 1024, completedBytes: 1024,
  totalFiles: 2, completedFiles: 2, speedBps: 2048, etaSeconds: 60,
  sourcePath: `/generated/${"long-source/".repeat(25)}source`,
  destinationPath: `/generated/${"long-destination/".repeat(25)}destination`,
  startedAt: 1, completedAt: 1001, elapsedMs: 1000, averageSpeedBps: 1024,
  currentFile: "MEDIA/long-file.MP4", currentFileBytes: 0, currentFileTotalBytes: 0,
} as BackgroundActivitySummary;
const render = (item = activity) => renderToStaticMarkup(
  <BackgroundTasksPage activities={[item]} notices={[]} projects={[]} onOpenRoute={() => {}} />,
);
const css = fs.readFileSync("src/renderer/src/style.css", "utf8");
function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "m"));
  expect(match, selector).not.toBeNull();
  return match![1];
}

describe("background and detail layout guards (desktop acceptance still required)", () => {
  it("labels portable evidence compilation honestly instead of presenting a transfer speed", () => {
    const html = render({ ...activity, state: "running", phase: "portable-recording" });
    expect(html).toContain("汇编原校验证据（非重新校验）");
    expect(html).toContain("记录进度，不统计传输速度");
    expect(html).not.toContain("正在计算速度");
  });
  it("shows complete labeled paths and separates the task list from its filters", () => {
    const html = render();
    expect(html).toContain(activity.sourcePath);
    expect(html).toContain(activity.destinationPath);
    expect(html).toContain("源路径"); expect(html).toContain("目的地路径");
    expect(html).toContain('class="background-page"');
    expect(html).not.toContain('class="panel background-task-list"');
    expect(rule(".background-page")).toContain("gap: 20px");
    expect(rule(".background-paths code")).toContain("overflow-wrap: anywhere");
    expect(rule(".background-paths code")).toContain("white-space: normal");
    expect(rule(".background-paths code")).not.toContain("ellipsis");
  });
  it("keeps settled tasks from claiming an active speed or countdown", () => {
    for (const state of ["completed", "failed", "attention"] as const) {
      const html = render({ ...activity, state });
      expect(html).not.toContain("正在计算速度");
      expect(html).not.toContain("约剩");
      expect(html).not.toContain("2 KB/s");
      expect(html).toContain("复核筛选范围");
    }
    expect(render({ ...activity, state: "running", speedBps: 0 })).toContain("正在计算速度");
    expect(render({ ...activity, state: "running" })).toContain("2 KB/s");
  });
  it("insets empty states and numeric cards instead of shrinking their text", () => {
    const html = renderToStaticMarkup(<BackgroundActivityOverview activities={[]} onOpen={() => {}} />);
    expect(html).toContain("当前没有运行中或待处理的后台任务</span>");
    expect(rule(".background-idle")).toContain("padding: 18px 22px");
    expect(rule(".background-overview")).toContain("margin-bottom: 24px");
    expect(rule(".background-overview-list")).toContain("padding: 18px 22px");
    expect(rule(".background-messages > p")).toContain("margin: 0 22px 16px");
    expect([...css.matchAll(/^\.background-messages > p\s*\{/gm)]).toHaveLength(1);
    expect(rule(".background-messages > p.red-text")).toContain("color: var(--danger)");
    expect(rule(".background-task > p.red-text")).toContain("color: var(--danger)");
    expect(rule(".background-task > p.green-text")).toContain("color: var(--green)");
    expect(rule(".detail-stats > div")).toContain("padding: 18px 20px");
    expect(rule(".detail-stats > div")).toContain("min-width: 0");
    expect(rule(".completion-summary div")).toContain("padding: 16px");
    for (const selector of [".background-current-file > span", ".archive-transfer-current-file > span:first-child", ".current-file", ".chosen-path strong", ".chosen-path div span"])
      expect(rule(selector)).toContain("overflow-wrap: anywhere");
  });
  it("keeps radio controls compact and copy layout labels beside their controls", () => {
    expect(css).toMatch(/input\[type="checkbox"\],\s*input\[type="radio"\]\s*\{[^}]*min-height: 17px/);
    const label = rule(".composer-main .copy-layout-choice label");
    expect(label).toContain("grid-template-columns: 17px minmax(0, 1fr)");
    expect(label).toContain("margin: 0");
  });
});
