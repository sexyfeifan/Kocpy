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
  const newest = (snapshot.lastCheckpointAt || 0) > (live.lastCheckpointAt || 0)
    ? snapshot : live;
  return { ...snapshot, ...newest, fileRecords: snapshot.fileRecords };
}

export function transferPhaseText(task: BackupTask): string {
  if (task.status === "paused") return "已暂停 · 继续后从安全检查点恢复";
  if (task.status === "verifying") return "正在独立回读校验目的地";
  return {
    scanning: "正在扫描与预检",
    hashing: "正在读取源文件并计算哈希",
    copying: "正在复制（新文件同步计算源哈希）",
    publishing: "正在安全落盘与检查素材源",
  }[task.transferPhase || "scanning"] || "等待任务更新";
}
