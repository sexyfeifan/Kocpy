import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  ArchiveVerificationRun,
  BackupTask,
  ProjectConfig,
  ProjectDeletionPreview,
  ProxyJob,
} from "./types";

export function buildProjectDeletionPreview(
  project: ProjectConfig,
  tasks: BackupTask[],
  proxyJobs: ProxyJob[],
  healthRecords: ArchiveHealthRecord[],
  archiveChanges: ArchiveChangeRecord[],
  archiveReminders: ArchiveReminder[],
  archiveRuns: ArchiveVerificationRun[] = [],
  archiveTransfers: Array<{ projectId?: string }> = [],
): ProjectDeletionPreview {
  const relatedTasks = tasks.filter((task) => task.projectId === project.id),
    taskIds = new Set(relatedTasks.map((task) => task.id)),
    relatedProxyJobs = proxyJobs.filter(
      (job) => Boolean(job.sourceTaskId && taskIds.has(job.sourceTaskId)),
    ),
    blockingTasks = relatedTasks.filter((task) =>
      ["pending", "running", "paused", "verifying"].includes(task.status),
    ).length,
    blockingProxyJobs = relatedProxyJobs.filter((job) =>
      ["pending", "running", "paused"].includes(job.status),
    ).length;
  return {
    projectId: project.id,
    projectName: project.name,
    status: project.status === "archived" ? "archived" : "active",
    taskCount: relatedTasks.length,
    proxyJobCount: relatedProxyJobs.length,
    unfinishedDailyDeliveryCount: relatedTasks.flatMap(task => task.dailyDeliveryRuns || [])
      .filter(run => run.status !== "completed" || run.reportStatus !== "completed").length,
    retainedArchiveTransferCount: archiveTransfers.filter(item => item.projectId === project.id).length,
    healthRecordCount: healthRecords.filter(
      (item) => item.projectId === project.id,
    ).length,
    archiveChangeCount: archiveChanges.filter(
      (item) => item.projectId === project.id,
    ).length,
    reminderCount: archiveReminders.filter(
      (item) => item.projectId === project.id,
    ).length,
    archiveRunCount: archiveRuns.filter(
      (item) => item.projectId === project.id,
    ).length,
    blockingTasks,
    blockingProxyJobs,
    canDelete: blockingTasks === 0 && blockingProxyJobs === 0,
  };
}
