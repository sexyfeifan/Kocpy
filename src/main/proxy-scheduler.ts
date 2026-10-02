import type { ProxyJob, ProxyConcurrency } from "./types";

export interface ProxyResources {
  keys: string[];
  exclusive: boolean;
  autoLimit: 1 | 2;
  reason: string;
}

export function validateProxyConcurrency(value: unknown): ProxyConcurrency {
  if (value === "auto" || value === 1 || value === 2 || value === 3) return value;
  throw new Error("并行任务数必须为自动、1、2 或 3");
}

/** Slot reservation happens synchronously before any persistence or process start. */
export class ProxyRunRegistry {
  persistenceError?: string;
  failPersistence(error: unknown) {
    this.persistenceError = `代理记录保存失败，队列已停止启动新任务：${error instanceof Error ? error.message : String(error)}`;
  }
  readonly runs = new Map<string, {
    controller: AbortController;
    pauseReason?: "user" | "backup-priority";
    resources: ProxyResources;
    limit: number;
  }>();
  get busy() { return this.runs.size > 0; }
  reserve(job: ProxyJob, resources: ProxyResources, queueLimit: number) {
    if (this.persistenceError) return undefined;
    const choice = validateProxyConcurrency(job.concurrency ?? 1);
    const limit = choice === "auto" ? resources.autoLimit : choice;
    if (this.runs.has(job.id) || this.runs.size >= Math.min(queueLimit, limit,
      ...[...this.runs.values()].map((run) => run.limit))) return undefined;
    for (const run of this.runs.values())
      if (resources.keys.includes("unknown-storage") || run.resources.keys.includes("unknown-storage") ||
        (resources.exclusive || run.resources.exclusive) &&
        resources.keys.some((key) => run.resources.keys.includes(key))) return undefined;
    const controller = new AbortController();
    this.runs.set(job.id, { controller, resources, limit });
    return controller;
  }
  pause(job: ProxyJob, reason: "user" | "backup-priority") {
    const run = this.runs.get(job.id);
    if (!run) return false;
    if (reason === "backup-priority" && (run.pauseReason || run.controller.signal.aborted)) return false;
    run.pauseReason = reason;
    job.pauseReason = reason;
    run.controller.abort(new Error(reason === "user" ? "用户暂停代理任务" : "备份任务优先，代理已安全暂停"));
    return true;
  }
  cancel(id: string) {
    const run = this.runs.get(id);
    if (!run) return false;
    run.pauseReason = undefined;
    run.controller.abort(new Error("用户取消代理任务"));
    return true;
  }
  release(id: string) { this.runs.delete(id); }
}
