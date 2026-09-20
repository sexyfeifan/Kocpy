import path from "node:path";
import type { ArchiveTransferProgress, ArchiveTransferTaskSummary } from "./archive-transfer";
import type { OperationRecord } from "./operations";
import type { BackupTask, ProjectConfig, ProxyJob } from "./types";

export type BackgroundActivityKind =
  | "transfer"
  | "proxy"
  | "archive-transfer"
  | "maintenance";
export type BackgroundActivityState =
  | "running"
  | "attention"
  | "completed"
  | "failed";

export interface BackgroundActivitySummary {
  id: string;
  sourceId: string;
  kind: BackgroundActivityKind;
  name: string;
  projectId?: string;
  projectName?: string;
  state: BackgroundActivityState;
  status: string;
  phase: string;
  progress: number;
  completedBytes: number;
  totalBytes: number;
  completedFiles: number;
  totalFiles: number;
  currentFile?: string;
  currentFileBytes: number;
  currentFileTotalBytes: number;
  speedBps: number;
  averageSpeedBps: number;
  etaSeconds: number;
  elapsedMs: number;
  sourcePath?: string;
  destinationPath?: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  route:
    | "transfers"
    | "processing"
    | "reports"
    | "maintenance"
    | "diagnostics";
}

export interface BackgroundActivityInput {
  tasks: BackupTask[];
  proxyJobs: ProxyJob[];
  archiveTransfers: ArchiveTransferTaskSummary[];
  archiveProgress: Map<string, ArchiveTransferProgress>;
  operations: OperationRecord[];
  projects: ProjectConfig[];
}

export function projectArchiveBlockers(
  projectId: string,
  input: Pick<
    BackgroundActivityInput,
    "tasks" | "proxyJobs" | "archiveTransfers" | "operations"
  >,
) {
  const projectTasks = input.tasks.filter((task) => task.projectId === projectId),
    projectTaskIds = new Set(projectTasks.map((task) => task.id));
  return [
    ...projectTasks
      .filter((task) =>
        ["pending", "running", "paused", "verifying"].includes(task.status),
      )
      .map((task) => `传输：${task.name}`),
    ...projectTasks
      .filter(
        (task) =>
          task.automaticReport?.enabled === true &&
          ["pending", "running"].includes(task.automaticReport.status),
      )
      .map((task) => `自动报告：${task.name}`),
    ...projectTasks.flatMap((task) =>
      (task.dailyDeliveryRuns || [])
        .filter((run) => ["pending", "running"].includes(run.status))
        .map((run) => `当日交付：${task.name} · ${run.shootingDate}`),
    ),
    ...input.proxyJobs
      .filter(
        (job) =>
          Boolean(
            job.sourceTaskId &&
              projectTaskIds.has(job.sourceTaskId) &&
              ["pending", "running", "paused"].includes(job.status),
          ),
      )
      .map((job) => `代理：${job.name}`),
    ...input.archiveTransfers
      .filter(
        (task) =>
          task.projectId === projectId &&
          ["ready", "running", "verifying", "interrupted"].includes(
            task.status,
          ),
      )
      .map((task) => `归档转存：${task.archiveName}`),
    ...input.operations
      .filter(
        (record) =>
          record.status === "running" && record.progress?.projectId === projectId,
      )
      .map((record) => `后台操作：${record.name}`),
  ];
}

const clamp = (value: number) => Math.max(0, Math.min(1, value || 0));
const terminalTask = new Set(["completed", "failed", "cancelled", "unverified"]);

function projectLookup(projects: ProjectConfig[]) {
  return new Map(projects.map((project) => [project.id, project.name]));
}

export function collectBackgroundActivities({
  tasks,
  proxyJobs,
  archiveTransfers,
  archiveProgress,
  operations,
  projects,
}: BackgroundActivityInput): BackgroundActivitySummary[] {
  const names = projectLookup(projects),
    taskById = new Map(tasks.map((task) => [task.id, task])),
    archiveIds = new Set(archiveTransfers.map((task) => task.id)),
    rows: BackgroundActivitySummary[] = [];

  for (const task of tasks) {
    const verifying = task.status === "verifying",
      reportActive =
        task.status === "completed" &&
        task.automaticReport?.enabled === true &&
        ["pending", "running"].includes(task.automaticReport.status),
      reportNeedsAttention =
        task.status === "completed" &&
        task.automaticReport?.enabled === true &&
        task.automaticReport.status === "failed",
      verifyCopies = verifying
        ? Math.max(
            1,
            task.totalFiles > 0 && task.verifyTotalFiles
              ? Math.ceil(task.verifyTotalFiles / task.totalFiles)
              : task.destinations.filter((item) => item.available !== false).length,
          )
        : 1,
      totalBytes = (task.totalBytes || 0) * verifyCopies,
      rawCompletedBytes = verifying
        ? task.verifiedBytes || 0
        : task.transferredBytes || 0,
      completedBytes = Math.min(rawCompletedBytes, totalBytes),
      state: BackgroundActivityState = reportActive
        ? "running"
        : reportNeedsAttention
          ? "attention"
          : ["running", "verifying"].includes(task.status)
        ? "running"
        : ["pending", "paused"].includes(task.status)
          ? "attention"
          : task.status === "completed"
            ? "completed"
            : "failed";
    rows.push({
      id: `transfer:${task.id}`,
      sourceId: task.id,
      kind: "transfer",
      name: task.name,
      projectId: task.projectId,
      projectName: task.projectId ? names.get(task.projectId) : undefined,
      state,
      status: task.status,
      phase: reportActive
        ? "reporting"
        : reportNeedsAttention
          ? "attention"
          : task.transferPhase || task.status,
      progress: totalBytes ? clamp(completedBytes / totalBytes) : terminalTask.has(task.status) ? 1 : 0,
      completedBytes,
      totalBytes,
      completedFiles: verifying
        ? task.verifyCompletedFiles || 0
        : task.completedFiles || 0,
      totalFiles: verifying
        ? task.verifyTotalFiles || task.totalFiles
        : task.totalFiles,
      currentFile: task.currentFile,
      currentFileBytes: 0,
      currentFileTotalBytes: 0,
      speedBps: verifying ? task.verifySpeedBps || 0 : task.aggregateSpeedBps || task.speedBps || 0,
      averageSpeedBps: task.aggregateSpeedBps || task.speedBps || 0,
      etaSeconds: verifying ? task.verifyEta || 0 : task.eta || 0,
      elapsedMs: task.startedAt
        ? Math.max(0, (task.completedAt || Date.now()) - task.startedAt)
        : 0,
      sourcePath: task.sourcePath,
      destinationPath: task.destinations.map((item) => item.resolvedPath || item.path).join(" · "),
      startedAt: task.startedAt || task.createdAt || 0,
      completedAt: task.completedAt,
      error: reportNeedsAttention
        ? task.automaticReport?.error || "自动 PDF 报告尚未完成"
        : task.errorMessage,
      route: "transfers",
    });
  }

  for (const job of proxyJobs) {
    const sourceTask = job.sourceTaskId ? taskById.get(job.sourceTaskId) : undefined,
      state: BackgroundActivityState = job.status === "running"
        ? "running"
        : ["pending", "paused"].includes(job.status)
          ? "attention"
          : job.status === "completed"
            ? "completed"
            : "failed";
    rows.push({
      id: `proxy:${job.id}`,
      sourceId: job.id,
      kind: "proxy",
      name: job.name,
      projectId: sourceTask?.projectId,
      projectName: sourceTask?.projectId ? names.get(sourceTask.projectId) : undefined,
      state,
      status: job.status,
      phase: job.stage || job.status,
      progress: clamp((job.progress || 0) / 100),
      completedBytes: 0,
      totalBytes: 0,
      completedFiles: job.status === "completed" ? 1 : 0,
      totalFiles: 1,
      currentFile: path.basename(job.input),
      currentFileBytes: 0,
      currentFileTotalBytes: 0,
      speedBps: 0,
      averageSpeedBps: 0,
      etaSeconds: 0,
      elapsedMs: job.startedAt
        ? Math.max(0, (job.completedAt || Date.now()) - job.startedAt)
        : 0,
      sourcePath: job.input,
      destinationPath: job.outputDir,
      startedAt: job.startedAt || job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      route: "processing",
    });
  }

  for (const task of archiveTransfers) {
    const live = archiveProgress.get(task.id),
      completedBytes = live?.overallProcessedBytes ?? task.verifiedBytes,
      totalBytes = live?.overallTotalBytes ?? task.inventory.totalBytes,
      state: BackgroundActivityState = ["running", "verifying"].includes(task.status) || task.reportStatus === "generating"
        ? "running"
        : ["ready", "interrupted"].includes(task.status)
          ? "attention"
          : task.status === "completed" && task.reportStatus === "completed"
            ? "completed"
            : "failed";
    rows.push({
      id: `archive-transfer:${task.id}`,
      sourceId: task.id,
      kind: "archive-transfer",
      name: task.archiveName,
      projectId: task.projectId,
      projectName: task.projectId ? names.get(task.projectId) : undefined,
      state,
      status: task.status,
      phase: live?.phase || (task.reportStatus === "generating" ? "reporting" : task.status),
      progress: totalBytes ? clamp(completedBytes / totalBytes) : state === "completed" ? 1 : 0,
      completedBytes,
      totalBytes,
      completedFiles: live?.completedFiles ?? task.completedFiles,
      totalFiles: live?.totalFiles ?? task.inventory.totalFiles,
      currentFile: live?.currentFile || task.currentFile,
      currentFileBytes: live?.currentFileBytes || 0,
      currentFileTotalBytes: live?.currentFileTotalBytes || 0,
      speedBps: live?.speedBps || 0,
      averageSpeedBps: live?.averageSpeedBps || 0,
      etaSeconds: live?.etaSeconds || 0,
      elapsedMs: live?.elapsedMs || (task.startedAt
        ? Math.max(0, (task.completedAt || Date.now()) - task.startedAt)
        : 0),
      sourcePath: task.sourcePath,
      destinationPath: task.finalPath,
      startedAt: task.startedAt || task.createdAt,
      completedAt: task.completedAt,
      error: task.error,
      route: "maintenance",
    });
  }

  for (const record of operations) {
    const progress = record.progress || {};
    if (progress.sourceId && archiveIds.has(progress.sourceId)) continue;
    const state: BackgroundActivityState = record.status === "running"
      ? "running"
      : record.status === "completed"
        ? "completed"
        : record.status === "cancelled"
          ? "completed"
          : "failed";
    rows.push({
      id: `maintenance:${record.id}`,
      sourceId: progress.sourceId || record.id,
      kind: "maintenance",
      name: record.name,
      projectId: progress.projectId,
      projectName: progress.projectId ? names.get(progress.projectId) : undefined,
      state,
      status: record.status,
      phase: progress.phase || progress.message || record.status,
      progress: progress.totalBytes ? clamp((progress.completedBytes || 0) / progress.totalBytes) : state === "completed" ? 1 : 0,
      completedBytes: progress.completedBytes || 0,
      totalBytes: progress.totalBytes || 0,
      completedFiles: progress.completedFiles || 0,
      totalFiles: progress.totalFiles || 0,
      currentFile: progress.currentFile,
      currentFileBytes: progress.currentFileBytes || 0,
      currentFileTotalBytes: progress.currentFileTotalBytes || 0,
      speedBps: progress.speedBps || 0,
      averageSpeedBps: progress.averageSpeedBps || 0,
      etaSeconds: progress.etaSeconds || 0,
      elapsedMs: progress.elapsedMs || Math.max(
        0,
        (record.completedAt || Date.now()) - record.startedAt,
      ),
      sourcePath: progress.sourcePath,
      destinationPath: progress.destinationPath,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      result: record.result || (record.status === "cancelled" ? "已取消" : undefined),
      error: record.error,
      route: progress.route || "maintenance",
    });
  }

  const sorted = rows.sort((left, right) => right.startedAt - left.startedAt),
    active = sorted.filter((item) => ["running", "attention"].includes(item.state)),
    history = sorted.filter((item) => !["running", "attention"].includes(item.state)).slice(0, 50);
  return [...active, ...history];
}
