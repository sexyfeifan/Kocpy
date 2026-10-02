import type { ProxyJob } from "./types";

export function orderedPendingProxies(jobs: ProxyJob[]) {
  return jobs.filter((job) => job.status === "pending").sort((a, b) =>
    (b.priority || 0) - (a.priority || 0) || (a.queueOrder ?? a.createdAt) - (b.queueOrder ?? b.createdAt));
}
export function mutateProxyQueue(jobs: ProxyJob[], ids: string[], action: "pause" | "resume" | "cancel" | "retry", controls: {
  pause(job: ProxyJob): void; cancel(job: ProxyJob): void;
}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
    throw new Error("请选择 1–1000 个不同的代理任务");
  if (!["pause", "resume", "cancel", "retry"].includes(action)) throw new Error("不支持的队列操作");
  const selected = ids.map((id) => jobs.find((job) => job.id === id));
  if (selected.some((job) => !job)) throw new Error("选中的代理任务已不存在，请刷新");
  let affected = 0;
  for (const job of selected as ProxyJob[]) {
    if (action === "pause" && ["running", "pending"].includes(job.status)) {
      if (job.status === "running") controls.pause(job);
      else Object.assign(job, { status: "paused", pauseReason: "user" });
    } else if (action === "cancel" && ["running", "pending", "paused"].includes(job.status)) {
      if (job.status === "running") controls.cancel(job);
      else Object.assign(job, { status: "cancelled", completedAt: Date.now(), pauseReason: undefined });
    } else if ((action === "resume" && job.status === "paused") ||
      (action === "retry" && ["failed", "cancelled"].includes(job.status))) {
      Object.assign(job, { status: "pending", stage: "queued", progress: 0, error: undefined, pauseReason: undefined,
        completedAt: undefined, outputPath: undefined, outputEvidence: undefined, validation: undefined,
        deliveryCheck: undefined, deliveryApproval: undefined });
    } else continue;
    affected++;
  }
  return affected;
}
export function reprioritizeProxy(jobs: ProxyJob[], id: string, priority: number, beforeId?: string) {
  const job = jobs.find((item) => item.id === id);
  if (!job || job.status !== "pending") throw new Error("只能调整等待中的任务");
  if (![0, 1, 2].includes(priority)) throw new Error("优先级必须为 0、1 或 2");
  const pending = orderedPendingProxies(jobs).filter((item) => item.id !== id);
  let index = pending.length;
  if (beforeId) {
    index = pending.findIndex((item) => item.id === beforeId);
    if (index < 0) throw new Error("目标任务不再等待，请刷新");
    priority = pending[index].priority || 0;
  }
  job.priority = priority as 0 | 1 | 2;
  pending.splice(index, 0, job);
  pending.forEach((item, order) => { item.queueOrder = order; });
}
