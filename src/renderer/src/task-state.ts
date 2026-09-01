import type { BackupTask } from "./api";

/** File records are fetched on demand; live task headers must not be frozen by that snapshot. */
export function selectLiveTask(
  id: string | null,
  tasks: BackupTask[],
  detail: BackupTask | null,
): BackupTask | undefined {
  const live = tasks.find((task) => task.id === id);
  const snapshot = detail?.id === id ? detail : undefined;
  if (!live) return snapshot;
  if (!snapshot) return live;
  // A detail response may arrive after a newer progress event, or before a later list refresh.
  const newest =
    (snapshot.lastCheckpointAt || 0) > (live.lastCheckpointAt || 0)
      ? snapshot
      : live;
  return {
    ...snapshot,
    ...newest,
    fileRecords: snapshot.fileRecords,
    // Task lists and progress events are intentionally lightweight. They may
    // lag behind an explicit detail refresh after a completion action, so they
    // must not overwrite the audited action state that was just fetched.
    completionActionRecords:
      snapshot.completionActionRecords ?? live.completionActionRecords,
  };
}

export function transferPhaseText(task: BackupTask): string {
  if (task.status === "pending") return "等待队列开始";
  if (task.status === "paused") return "已暂停 · 继续后从安全检查点恢复";
  if (task.status === "verifying") return "正在独立回读校验目的地";
  return (
    {
      scanning: "正在扫描与预检",
      hashing: "正在读取源文件并计算哈希",
      copying: "正在复制（新文件同步计算源哈希）",
      publishing: "正在安全落盘与检查素材源",
    }[task.transferPhase || "scanning"] || "等待任务更新"
  );
}

/** ETA is a phase estimate, never a claim that all verification is complete. */
export function transferTiming(task: BackupTask) {
  if (task.status === "paused")
    return { speed: 0, seconds: 0, label: "已暂停" };
  if (task.status === "running" && task.transferPhase === "scanning")
    return { speed: 0, seconds: 0, label: "预检中" };
  if (task.status === "running" || task.status === "verifying") {
    const verifying = task.status === "verifying";
    const speed = verifying ? task.verifySpeedBps || 0 : task.speedBps || 0;
    return {
      speed,
      seconds:
        speed > 0 ? (verifying ? task.verifyEta || 0 : task.eta || 0) : 0,
      label: "本阶段预计剩余",
    };
  }
  return {
    speed: 0,
    seconds:
      task.startedAt && task.completedAt
        ? Math.max(0, task.completedAt - task.startedAt) / 1000
        : 0,
    label: task.status === "pending" ? "等待开始" : "总用时",
  };
}

export function transferProgressLabel(
  task: Pick<BackupTask, "copyProgress" | "verifyProgress">,
  phase: "copy" | "verify",
) {
  const value = phase === "copy" ? task.copyProgress : task.verifyProgress;
  const progress = Number.isFinite(value)
    ? Math.max(0, Math.min(100, value || 0))
    : 0;
  if (progress >= 100) return "100%";
  if (progress >= 99) return `${(Math.floor(progress * 10) / 10).toFixed(1)}%`;
  return `${Math.floor(progress)}%`;
}
