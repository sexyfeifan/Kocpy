import { describe, expect, it } from "vitest";
import {
  collectBackgroundActivities,
  projectArchiveBlockers,
} from "../src/main/background-activities";

const baseTask = {
  id: "task-1",
  name: "A001",
  projectId: "project-1",
  status: "running",
  transferPhase: "copying",
  sourcePath: "/Volumes/CARD",
  destinations: [{ path: "/Volumes/BACKUP/A001" }],
  totalBytes: 1000,
  transferredBytes: 500,
  verifiedBytes: 0,
  totalFiles: 2,
  completedFiles: 1,
  speedBps: 100,
  aggregateSpeedBps: 100,
  eta: 5,
  currentFile: "DCIM/A001.mov",
  createdAt: 10,
  startedAt: 20,
  fileRecords: [],
} as any;

describe("unified background activity", () => {
  it("blocks project archiving for every active project-bound workflow but not stopped failures", () => {
    const blockers = projectArchiveBlockers("project-1", {
      tasks: [
        baseTask,
        {
          ...baseTask,
          id: "completed-with-report",
          status: "completed",
          automaticReport: { enabled: true, status: "running" },
          dailyDeliveryRuns: [
            { status: "running", shootingDate: "2026-09-20" },
          ],
        },
        { ...baseTask, id: "stopped-failure", status: "failed" },
      ],
      proxyJobs: [
        {
          id: "proxy-1",
          name: "代理任务",
          sourceTaskId: "task-1",
          status: "paused",
        } as any,
      ],
      archiveTransfers: [
        {
          id: "archive-1",
          projectId: "project-1",
          archiveName: "NAS 归档",
          status: "interrupted",
        } as any,
      ],
      operations: [
        {
          id: "operation-1",
          name: "复校验",
          status: "running",
          startedAt: 1,
          progress: { projectId: "project-1" },
        },
        {
          id: "operation-2",
          name: "已停止失败",
          status: "failed",
          startedAt: 1,
        },
      ],
    });
    expect(blockers).toEqual(
      expect.arrayContaining([
        "传输：A001",
        "自动报告：A001",
        "当日交付：A001 · 2026-09-20",
        "代理：代理任务",
        "归档转存：NAS 归档",
        "后台操作：复校验",
      ]),
    );
    expect(blockers.some((item) => item.includes("已停止失败"))).toBe(false);
  });

  it("combines running work, actionable report failure and only the latest 50 history rows", () => {
    const activities = collectBackgroundActivities({
      tasks: [
        baseTask,
        {
          ...baseTask,
          id: "report-failed",
          name: "A002",
          status: "completed",
          transferredBytes: 1000,
          completedAt: 30,
          automaticReport: {
            enabled: true,
            status: "failed",
            error: "目标离线",
          },
        },
      ],
      proxyJobs: [
        {
          id: "proxy-1",
          name: "A001 proxy",
          sourceTaskId: "task-1",
          input: "/Volumes/BACKUP/A001.mov",
          outputDir: "/Volumes/PROXY",
          status: "running",
          stage: "transcoding",
          progress: 25,
          createdAt: 40,
        } as any,
      ],
      archiveTransfers: [],
      archiveProgress: new Map(),
      operations: Array.from({ length: 55 }, (_, index) => ({
        id: `operation-${index}`,
        name: `维护 ${index}`,
        status: "completed" as const,
        startedAt: 100 + index,
        completedAt: 200 + index,
      })),
      projects: [
        { id: "project-1", name: "测试项目", status: "active" } as any,
      ],
    });

    expect(activities.filter((item) => item.state === "running")).toHaveLength(2);
    expect(activities.find((item) => item.id === "transfer:report-failed")).toMatchObject({
      state: "attention",
      phase: "attention",
      completedBytes: 1000,
      totalBytes: 1000,
      error: "目标离线",
      projectName: "测试项目",
    });
    expect(activities.filter((item) => item.state === "completed")).toHaveLength(50);
    expect(activities.some((item) => item.id === "maintenance:operation-54")).toBe(
      true,
    );
    expect(activities.some((item) => item.id === "maintenance:operation-0")).toBe(
      false,
    );
  });

  it("uses transient archive bytes and deduplicates its operation-history mirror", () => {
    const progress = {
      taskId: "archive-1",
      status: "running",
      phase: "copying",
      currentFile: "Media/clip.mov",
      currentFileBytes: 300,
      currentFileTotalBytes: 800,
      overallProcessedBytes: 1400,
      overallTotalBytes: 2000,
      processedBytes: 400,
      completedFiles: 1,
      totalFiles: 3,
      verifiedBytes: 100,
      totalBytes: 1000,
      speedBps: 200,
      averageSpeedBps: 150,
      elapsedMs: 2000,
      etaSeconds: 3,
    } as const;
    const activities = collectBackgroundActivities({
      tasks: [],
      proxyJobs: [],
      archiveTransfers: [
        {
          id: "archive-1",
          projectId: "project-1",
          archiveName: "归档项目",
          status: "running",
          reportStatus: "pending",
          inventory: { totalBytes: 1000, totalFiles: 3 },
          verifiedBytes: 100,
          completedFiles: 1,
          sourcePath: "/source",
          finalPath: "/nas/归档项目",
          createdAt: 1,
          reportAttempts: [],
        } as any,
      ],
      archiveProgress: new Map([["archive-1", progress as any]]),
      operations: [
        {
          id: "operation-1",
          name: "归档转存",
          status: "running",
          startedAt: 1,
          progress: { sourceId: "archive-1" },
        },
      ],
      projects: [{ id: "project-1", name: "项目" } as any],
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      id: "archive-transfer:archive-1",
      progress: 0.7,
      completedFiles: 1,
      totalFiles: 3,
      currentFileBytes: 300,
      speedBps: 200,
      elapsedMs: 2000,
      etaSeconds: 3,
    });
  });

  it("normalizes copy bytes and uses all selected readback copies as the verify total", () => {
    const activities = collectBackgroundActivities({
      tasks: [
        { ...baseTask, id: "copy", status: "failed", transferredBytes: 2000 },
        {
          ...baseTask,
          id: "verify",
          status: "verifying",
          verifiedBytes: 1500,
          verifyCompletedFiles: 3,
          verifyTotalFiles: 4,
        },
      ],
      proxyJobs: [],
      archiveTransfers: [],
      archiveProgress: new Map(),
      operations: [],
      projects: [],
    });
    expect(activities.find((item) => item.sourceId === "copy")).toMatchObject({
      completedBytes: 1000,
      totalBytes: 1000,
      progress: 1,
    });
    expect(activities.find((item) => item.sourceId === "verify")).toMatchObject({
      completedBytes: 1500,
      totalBytes: 2000,
      completedFiles: 3,
      totalFiles: 4,
      progress: 0.75,
    });
  });
});
