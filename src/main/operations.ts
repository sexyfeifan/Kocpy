import { randomUUID } from "node:crypto";
import { readableOperationError } from "../common/interaction";
export interface OperationRecord {
  id: string;
  name: string;
  status: "running" | "completed" | "cancelled" | "failed";
  startedAt: number;
  completedAt?: number;
  error?: string;
  result?: string;
  progress?: any;
}
export class OperationRegistry {
  private records: OperationRecord[] = [];
  constructor(
    private save?: (records: OperationRecord[]) => Promise<unknown>,
  ) {}
  restore(records: OperationRecord[]) {
    this.records = records
      .slice(-50)
      .map((record) =>
        record.status === "running"
          ? {
              ...record,
              status: "failed",
              error:
                "上次运行被中断，结果尚未确认。请重新检查目标与记录，再从原入口重试；不要按成功处理。",
              completedAt: Date.now(),
            }
          : record,
      );
  }
  get active() {
    return this.records.some((record) => record.status === "running");
  }
  list() {
    return this.records.map((record) => ({ ...record }));
  }
  progress(value: any) {
    const current = this.records.find((record) => record.status === "running");
    if (current) current.progress = value;
  }
  async run<T>(name: string, action: () => Promise<T>): Promise<T> {
    if (this.active)
      throw new Error(
        "已有维护操作执行中，请在后台操作面板查看进度，完成后再开始",
      );
    const record: OperationRecord = {
      id: randomUUID(),
      name,
      startedAt: Date.now(),
      status: "running",
    };
    this.records = [...this.records.slice(-49), record];
    try {
      await this.save?.(this.list());
      const result = await action();
      record.status =
        result === null || result === false ? "cancelled" : "completed";
      const value = result as any,
        health = value?.record || value;
      if (health?.taskCount !== undefined)
        record.result = `${health.healthyTasks}/${health.taskCount} 项健康；${health.missingCopies || 0} 个副本问题`;
      else if (value?.repaired !== undefined)
        record.result = `修复 ${value.repaired} 个文件；保留原损坏文件 ${value.preservedDamagedOriginals || 0} 个`;
      else if (value?.tasksAdded !== undefined)
        record.result = `新增 ${value.tasksAdded}，重复 ${value.duplicates}；冲突：${value.conflicts?.join("；") || "无"}`;
      else if (Array.isArray(value) && value.some((item) => item?.sourcePath))
        record.result = `记录 ${value.length} 卷，仍需处理 ${value.filter((item) => item.status !== "completed" || item.externalManifest?.status === "mismatch").length} 卷；到项目详情查看可信状态。`;
      else if (value?.importedTasks !== undefined)
        record.result = `刷新接管：合并重复 ${value.duplicatesMerged || 0}，移除汇总重复 ${value.aggregateRecordsRemoved || 0}；待建立基线 ${value.baselinesNeeded || 0}；清单差异 ${value.manifestDifferences || 0}；不可访问 ${value.unavailableSources || 0}。`;
      else if (Array.isArray(value)) record.result = `处理 ${value.length} 项`;
      else if (typeof value === "string") record.result = value;
      return result;
    } catch (error) {
      record.status = "failed";
      record.error = readableOperationError(error);
      throw error;
    } finally {
      record.completedAt = Date.now();
      await this.save?.(this.list());
    }
  }
}
