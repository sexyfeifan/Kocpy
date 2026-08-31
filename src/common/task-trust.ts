import type {
  BackupTask,
  Destination,
  ProjectConfig,
  ProjectCoverage,
} from "../main/types";
import { copyEvidenceSummary } from "./copy-evidence";

/** Decisions are derived from metadata shared by full records and paged IPC
 * summaries. Absence of fileRecords in a list response is not lost evidence. */
export function manifestRequirementMet(task: BackupTask): boolean {
  const manifest = task.externalManifest;
  if (!manifest) return task.provenance !== "manifest-import";
  if (
    ![
      manifest.missing,
      manifest.extra,
      manifest.sizeMismatches,
      manifest.checksumMismatches,
    ].every(Array.isArray)
  )
    return false;
  if (
    manifest.missing?.length ||
    manifest.sizeMismatches?.length ||
    manifest.checksumMismatches?.length
  )
    return false;
  if (manifest.status !== "mismatch" && !manifest.extra?.length) return true;
  return (
    manifest.resolution?.type === "accepted-extra" &&
    task.confidence === "baseline" &&
    Array.isArray(manifest.extra) &&
    manifest.extra.length > 0 &&
    Array.isArray(manifest.missing) &&
    Array.isArray(manifest.sizeMismatches) &&
    Array.isArray(manifest.checksumMismatches) &&
    Number.isFinite(manifest.resolution.resolvedAt) &&
    manifest.resolution.resolvedAt > 0 &&
    Boolean(manifest.resolution.note?.trim())
  );
}

export function taskTrustState(task: BackupTask) {
  const copies = copyEvidenceSummary(task.destinations);
  const imported = Boolean(
    task.provenance && task.provenance !== "kocpy-transfer",
  );
  const manifest = task.externalManifest;
  const basis = !imported
    ? "源与副本哈希比对"
    : task.confidence === "baseline"
      ? "接管时首次哈希基线"
      : task.confidence === "verified"
        ? "外部清单完整校验"
        : "尚无完整校验证据";
  const verifiedAt =
    task.lastVerifiedAt || (imported ? task.importedAt : task.completedAt);
  const result = (
    status: string,
    label: string,
    explanation: string,
    nextStep: string,
    contentVerified = false,
  ) => ({
    status,
    label,
    explanation,
    nextStep,
    contentVerified,
    basis,
    verifiedAt,
    copies,
    countableCopies: contentVerified ? copies.independentCopies : 0,
  });
  const activeLabels: Record<string, string> = {
    pending: "等待开始",
    running: "正在复制",
    paused: "已暂停",
    verifying: "正在回读校验",
  };
  if (activeLabels[task.status])
    return result(
      task.status,
      activeLabels[task.status],
      "当前流程尚未结束，已有校验记录不能代替本次完整结果。",
      task.status === "paused"
        ? "继续任务后等待完整校验。"
        : "等待复制和逐目标回读完成。",
    );
  if (!manifestRequirementMet(task)) {
    const parts = manifest
      ? [
          manifest.missing?.length && `缺少 ${manifest.missing.length}`,
          manifest.extra?.length && `额外 ${manifest.extra.length}`,
          manifest.sizeMismatches?.length &&
            `大小不同 ${manifest.sizeMismatches.length}`,
          manifest.checksumMismatches?.length &&
            `校验不同 ${manifest.checksumMismatches.length}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : "缺少外部清单证据";
    return result(
      "failed",
      `清单差异 · ${parts || "待核对"}`,
      "现有内容与记录的清单要求不一致，不能计作达标副本；旧人工确认不豁免新的缺失或损坏。",
      "打开外部清单差异，核对具体路径；仅从健康副本恢复，或使用明确的审计确认流程。",
    );
  }
  if (task.status === "failed")
    return result(
      "failed",
      imported ? "校验未通过 · 查看详情" : "备份失败",
      "有过校验通过的目标不代表整个任务已经完成。",
      "查看错误原因，完成只读检查后重试或重新校验。",
    );
  if (task.status === "cancelled")
    return result(
      "cancelled",
      "已取消 · 校验未完成",
      "已有文件和历史校验记录保留，不计为本次达标。",
      "确认源和目的地后恢复任务或重新校验。",
    );
  if (
    task.status !== "completed" ||
    !copies.verifiedTargets ||
    (imported && !["baseline", "verified"].includes(task.confidence || "")) ||
    (imported &&
      task.confidence === "verified" &&
      manifest?.status !== "verified")
  ) {
    return result(
      "unverified",
      manifest?.status === "unsupported"
        ? "外部清单格式不支持"
        : "已识别 · 待完整校验",
      "目录识别、文件数和容量不证明内容完整；记录中尚无足够的完整校验证据。",
      imported
        ? "选择已有清单完整比对，或明确建立接管时首次基线。"
        : "重新校验在线目标，补充完整校验证据。",
    );
  }
  let label = imported
    ? task.confidence === "baseline"
      ? "首次基线已建立"
      : "外部清单校验通过"
    : "内容校验通过";
  if (manifest?.resolution?.type === "accepted-extra")
    label = "额外文件已确认 · 当前基线可信";
  if (
    manifest?.status === "verified" &&
    manifest.resolution?.type === "revised-missing"
  )
    label = `修订 MHL 校验通过 · 排除 ${manifest.resolution.excluded.length}`;
  const explanation =
    task.confidence === "baseline"
      ? "证明接管时现存文件已读取并建立哈希，不证明接管前没有丢失；已确认差异仍保留审计。"
      : "内容结论基于最近记录的完整校验，不代表此刻磁盘在线，也不证明接收范围以外没有遗漏。";
  return result(
    "completed",
    label,
    explanation,
    copies.independencePending
      ? "多目标独立性证据不足。重新校验在线目标可更新同次存储关系；保留旧哈希记录。"
      : "按项目要求核对副本数量与存储位置，确认交接；不要仅据完成提示格式化原卡。",
    true,
  );
}

export function taskMeetsCopyRequirement(
  task: BackupTask,
  requiredCopies: number,
): boolean {
  if (
    !Number.isInteger(requiredCopies) ||
    requiredCopies < 1 ||
    requiredCopies > 4
  )
    return false;
  return taskTrustState(task).countableCopies >= requiredCopies;
}

export function projectCoverage(
  project: ProjectConfig,
  tasks: BackupTask[],
): ProjectCoverage {
  const related = tasks.filter((task) => task.projectId === project.id);
  const byProvenance: Record<string, number> = {};
  let verified = 0,
    compliant = 0;
  for (const task of related) {
    const source = task.provenance || "kocpy-transfer";
    byProvenance[source] = (byProvenance[source] || 0) + 1;
    if (taskTrustState(task).contentVerified) verified++;
    if (taskMeetsCopyRequirement(task, project.requiredCopies || 2))
      compliant++;
  }
  return {
    recorded: related.length,
    verified,
    compliant,
    attention: related.length - compliant,
    byProvenance,
    managedSince: project.managedSince,
    expected: project.expectedVolumes,
    coveragePercent: project.expectedVolumes
      ? Math.min(
          100,
          Math.round((related.length / project.expectedVolumes) * 100),
        )
      : undefined,
  };
}

export function savedDestinationBytes(
  task: BackupTask,
  destination: Destination,
): number {
  // Adoption scans existing files; zero bytes newly copied does not mean empty.
  if (task.provenance && task.provenance !== "kocpy-transfer")
    return task.totalBytes;
  return (
    destination.copiedBytes ??
    (destination.verified ? task.totalBytes : destination.bytesWritten)
  );
}
