import type { BackupTask, Destination } from "../../main/types";
import { taskTrustState } from "../../common/task-trust";
import { transferPhaseText, transferProgressLabel } from "./task-state";

export type TransferEvidenceState = "waiting" | "active" | "complete" | "attention";

export function observedProgress(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(100, value)
    : undefined;
}

export function evidenceBytes(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return "待更新";
  if (!value) return "0 B";
  const index = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** index).toLocaleString("en-US", {
    maximumFractionDigits: index > 1 ? 1 : 0,
  })} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}

function progressText(value: number | undefined): string {
  const progress = observedProgress(value);
  return progress === undefined
    ? "待更新"
    : transferProgressLabel({ copyProgress: progress }, "copy");
}

function copyRecorded(task: BackupTask, destination: Destination): boolean {
  return observedProgress(destination.copyProgress) === 100 ||
    (task.totalBytes > 0 && typeof destination.copiedBytes === "number" &&
      Number.isFinite(destination.copiedBytes) && destination.copiedBytes >= task.totalBytes) ||
    (task.status === "completed" && destination.verified);
}

/** Uses only destination observations; the task percentage is never a target estimate. */
export function destinationTransferEvidence(task: BackupTask, destination: Destination) {
  const imported = Boolean(task.provenance && task.provenance !== "kocpy-transfer");
  const live = task.status === "running" || task.status === "verifying";
  const hasError = Boolean(destination.error || destination.available === false);
  const state: TransferEvidenceState = hasError
    ? "attention"
    : destination.verified
      ? "complete"
      : live && (observedProgress(destination.copyProgress) || observedProgress(destination.verifyProgress))
        ? "active"
        : "waiting";
  const speed = live
    ? (task.status === "verifying" ? destination.verifySpeedBps : destination.speedBps)
    : undefined;
  return {
    id: destination.id,
    label: destination.label || destination.volumeName || "备份目的地",
    path: destination.resolvedPath || destination.path,
    state,
    imported,
    copyProgress: imported ? undefined : observedProgress(destination.copyProgress),
    verifyProgress: observedProgress(destination.verifyProgress),
    copyText: imported ? "已有副本" : progressText(destination.copyProgress),
    verifyText: progressText(destination.verifyProgress),
    savedText: imported
      ? `记录容量 ${evidenceBytes(task.totalBytes)}`
      : `已复制 ${evidenceBytes(destination.copiedBytes)}`,
    readText: `已回读 ${evidenceBytes(destination.verifiedBytes)}`,
    speedText: typeof speed === "number" && Number.isFinite(speed) && speed > 0
      ? `${evidenceBytes(speed)}/s`
      : undefined,
    result: destination.error || (destination.available === false
      ? "目标不可用；历史记录仍保留"
      : destination.verified
        ? "该目标哈希记录通过"
        : "尚未完成目标校验"),
  };
}

/** Copy completion, current content trust and physical independence are separate facts. */
export function transferEvidenceModel(task: BackupTask) {
  const trust = taskTrustState(task);
  const imported = Boolean(task.provenance && task.provenance !== "kocpy-transfer");
  const permissionCount = task.inventoryScope?.exclusions.filter(
    (entry) => entry.reason === "permission-denied",
  ).length || 0;
  const stopped = task.status === "failed" || task.status === "cancelled";
  const copyComplete = !imported && task.destinations.length > 0 &&
    task.destinations.every((destination) => copyRecorded(task, destination));
  const scanRecorded = Boolean(task.inventoryScope) ||
    (!imported && (task.status === "verifying" || task.status === "completed" ||
      (task.transferPhase && task.transferPhase !== "scanning")));
  const scanActive = !imported && task.status === "running" &&
    (!task.transferPhase || task.transferPhase === "scanning");
  const copying = !imported && task.status === "running" && !scanActive;
  const verifying = task.status === "verifying";
  const report = task.automaticReport;
  const reportText = report?.enabled
    ? ({ pending: "自动报告待生成", running: "自动报告生成中", completed: "自动报告已生成", failed: "自动报告生成失败", disabled: "" }[report.status])
    : "";
  const phase = (
    key: string,
    label: string,
    state: TransferEvidenceState,
    detail: string,
  ) => ({ key, label, state, detail });
  const phases = [
    phase("scan", imported ? "范围记录" : "扫描", permissionCount
      ? "attention" : scanActive ? "active" : scanRecorded ? "complete" : "waiting",
    permissionCount ? `权限排除 ${permissionCount} 项` : task.inventoryScope
      ? `纳入 ${task.inventoryScope.includedFiles} 个文件`
      : scanActive ? "扫描与预检中" : imported ? "识别接管范围 · 未保存冻结快照" : scanRecorded ? "范围已记录" : "等待扫描"),
    phase("copy", imported ? "已有副本" : "复制", imported ? "waiting" :
      copyComplete ? "complete" : stopped ? "attention" : copying ? "active" : "waiting",
    imported ? "本次接管未执行复制" : copyComplete ? "逐目标复制记录完成" :
      task.status === "paused" ? "任务已暂停" : copying ? transferPhaseText(task) : stopped ? "复制流程未完整结束" : "等待复制"),
    phase("verify", "回读", trust.contentVerified ? "complete" : verifying ? "active" :
      stopped || task.status === "completed" || task.status === "unverified" ? "attention" : "waiting",
    trust.contentVerified ? "纳入范围的内容校验通过" : verifying ? "逐目标回读与哈希比对" :
      stopped ? "本次未完整通过" : "等待完整内容校验"),
    phase("record", "记录", task.status === "completed"
      ? report?.status === "failed" || !trust.contentVerified || permissionCount ? "attention" : "complete"
      : stopped ? "attention" : "waiting",
    task.status === "completed" ? reportText ? `校验记录已保留 · ${reportText}` : "任务结果已记录" :
      stopped ? "失败或取消记录已保留" : "等待本次结果记录"),
  ];
  const copyValue = imported ? "已有副本接管" : copyComplete ? "复制记录完成" :
    task.status === "paused" ? "已暂停" : `全任务 ${progressText(task.copyProgress)}`;
  const copies = trust.copies;
  const recordedRelationship = copies.verifiedTargets === 0 ? "存储关系待核对" :
    copies.independencePending ? `${copies.verifiedTargets} 个目标存储关系待核对` :
      copies.verifiedTargets > copies.independentCopies ? `${copies.verifiedTargets} 个目标存在共享存储域` :
        copies.verifiedTargets > 1 ? `${copies.verifiedTargets} 个目标存储域独立` : "单目标，暂无多目标关系";
  const independenceValue = !trust.contentVerified && copies.verifiedTargets > 0
    ? "历史存储关系记录" : recordedRelationship;
  const relationshipLimit = copies.verifiedTargets === 0 ? "完成校验后结合存储关系判断" :
    copies.independencePending ? "多个目标路径不证明物理独立" :
      copies.verifiedTargets > copies.independentCopies ? "共享存储域不能逐路径累计" :
        copies.verifiedTargets === 1 ? "单个目标不证明多副本物理独立" : "依据同次存储关系记录；不代表此刻磁盘在线";
  const independenceDetail = [
    !trust.contentVerified && copies.verifiedTargets > 0 ? recordedRelationship : undefined,
    `当前任务可计 ${trust.countableCopies} 份`,
    permissionCount > 0 ? "完整源范围未确认" : !trust.contentVerified ? "待本次完整校验" : undefined,
    relationshipLimit,
  ].filter(Boolean).join(" · ");
  return {
    imported,
    phases,
    targets: task.destinations.map((destination) => destinationTransferEvidence(task, destination)),
    permissionCount,
    caption: task.status === "completed" || stopped || task.status === "unverified"
      ? trust.label : transferPhaseText(task),
    sourceLabel: imported ? "接管范围" : task.sourceVolumeName || "素材源",
    scopeText: task.inventoryScope
      ? `纳入 ${task.inventoryScope.includedFiles} 个文件 · ${evidenceBytes(task.inventoryScope.includedBytes)}`
      : scanActive || task.status === "pending" ? "范围待扫描" : `记录 ${task.totalFiles} 个文件 · ${evidenceBytes(task.totalBytes)}`,
    facts: [
      { key: "copy", label: imported ? "副本来源" : "复制", value: copyValue,
        state: (copyComplete ? "complete" : stopped ? "attention" : copying ? "active" : "waiting") as TransferEvidenceState,
        detail: imported ? "现存文件的接管，不证明接管前没有遗漏" : "复制进度与内容校验分别记录" },
      { key: "verify", label: "内容校验", value: trust.contentVerified ? "范围内校验通过" : verifying ? "正在逐目标回读" : stopped ? "本次未完整通过" : "待完整校验",
        state: (trust.contentVerified ? "complete" : verifying ? "active" : stopped || task.status === "completed" || task.status === "unverified" ? "attention" : "waiting") as TransferEvidenceState,
        detail: trust.basis },
      { key: "independence", label: "物理独立性", value: independenceValue,
        state: (trust.contentVerified && !permissionCount && copies.verifiedTargets > 1 && !copies.independencePending && copies.independentCopies === copies.verifiedTargets
          ? "complete" : copies.verifiedTargets > 1 ? "attention" : "waiting") as TransferEvidenceState,
        detail: independenceDetail },
    ],
  };
}
