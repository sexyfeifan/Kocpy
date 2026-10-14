export interface DestinationSelectionNoticeInput {
  mode: "ordinary" | "project";
  destinationCount: number;
  requiredCopies?: number;
}

export interface DestinationSelectionNotice {
  tone: "neutral" | "warning";
  title: string;
  message: string;
  selection: "missing" | "below-project-requirement" | "selected";
  storageEvidence: "pending";
}

const pendingEvidence =
  "目的地数量不等于物理独立副本数；复制、逐文件校验与存储关系核对完成后，才判断是否达标。";

/** Configuration guidance only. This model never decides start eligibility,
 *  changes a project requirement, or counts verified/independent copies. */
export function destinationSelectionNotice({
  mode,
  destinationCount,
  requiredCopies,
}: DestinationSelectionNoticeInput): DestinationSelectionNotice {
  if (mode === "project") {
    // Match the existing project's legacy default without modifying its data.
    const required = requiredCopies || 2;
    const shortage = Math.max(0, required - destinationCount);
    return {
      tone: shortage > 0 ? "warning" : "neutral",
      title: shortage > 0 ? "目的地数量不足" : "项目副本要求",
      message: `项目要求 ${required} 份物理独立校验副本，已选 ${destinationCount} 个目的地${shortage > 0 ? `，目的地数量还差 ${shortage} 个` : ""}。${pendingEvidence}`,
      selection: destinationCount === 0
        ? "missing"
        : shortage > 0 ? "below-project-requirement" : "selected",
      storageEvidence: "pending",
    };
  }
  if (destinationCount === 0) {
    return {
      tone: "warning",
      title: "尚未选择目的地",
      message: `请先选择至少一个备份目的地。${pendingEvidence}`,
      selection: "missing",
      storageEvidence: "pending",
    };
  }
  return {
    tone: "neutral",
    title: destinationCount === 1 ? "独立副本建议" : "副本核对",
    message: destinationCount === 1
      ? `当前已选 1 个备份目的地。重要素材建议另存一份独立副本；此建议不影响是否可开始，开始前仍由素材、目的地与引擎预检判断。${pendingEvidence}`
      : `当前已选 ${destinationCount} 个备份目的地。${pendingEvidence}`,
    selection: "selected",
    storageEvidence: "pending",
  };
}

/** Neutral guidance never inherits an error, success or amber presentation. */
export function destinationNoticeClassName(notice: Pick<DestinationSelectionNotice, "tone">) {
  return notice.tone === "warning" ? "notice amber" : "notice";
}
