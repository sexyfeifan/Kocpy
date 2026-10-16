import { createHash } from "node:crypto";
import { existingSourceKey } from "./existing-records";
import type { BackupTask, ExistingImportPreview, ProjectConfig, ProjectRuleSnapshot } from "./types";

export const existingRefreshMetadataNote = "刷新保留已记录的拍摄日期、设备、机位与素材卷名称（包括未确认归属），不使用当前项目规则重新解释旧任务。需要更改归属时，请由操作人显式核对并确认映射；本次扫描数量不替代原校验基线。";

function usableSnapshot(snapshot: ProjectRuleSnapshot): boolean {
  const rules = snapshot.rules;
  return Boolean(rules && typeof rules === "object" &&
    typeof rules.namingRule === "string" &&
    Array.isArray(rules.devices) && rules.devices.every((device) => typeof device === "string") &&
    rules.devicePositions && typeof rules.devicePositions === "object" && !Array.isArray(rules.devicePositions) &&
    Object.values(rules.devicePositions).every((positions) => Array.isArray(positions) && positions.every((position) => typeof position === "string")) &&
    /^[a-f0-9]{64}$/.test(snapshot.sha256) &&
    createHash("sha256").update(JSON.stringify(rules)).digest("hex") === snapshot.sha256);
}

/** Build a detached read-only interpretation of the original task's rules.
 * Missing, duplicate or damaged historical evidence never falls back to the
 * current project's rule. A snapshot is integrity evidence, not a signature. */
export function existingRefreshContext(task: BackupTask, project: ProjectConfig) {
  const snapshots = task.projectId === project.id && task.projectRuleSnapshotId
    ? (project.ruleSnapshots || []).filter((item) => item.id === task.projectRuleSnapshotId)
    : [];
  const snapshot = snapshots.length === 1 && usableSnapshot(snapshots[0]) ? snapshots[0] : undefined;
  const view: ProjectConfig | undefined = snapshot ? {
    id: project.id,
    name: task.reportContext?.projectName || task.projectFolderName || project.id,
    ...structuredClone(snapshot.rules),
    shootingDate: snapshot.rules.shootingDateStart,
    activeRuleSnapshotId: snapshot.id,
    ruleSnapshots: [structuredClone(snapshot)],
  } : undefined;
  const ruleStatus = snapshot ? "frozen-snapshot" as const :
    task.projectRuleSnapshotId ? "snapshot-unavailable" as const : "legacy-without-snapshot" as const;
  return {
    project: view,
    ruleStatus,
    // Identical source paths with distinct historical mappings must not share
    // the preview produced under a different snapshot or selected date.
    cacheKey: JSON.stringify([existingSourceKey(task.sourcePath), task.projectId,
      snapshot?.id || task.projectRuleSnapshotId || "", snapshot?.sha256 || ruleStatus, task.shootingDate]),
  };
}

/** Refresh observes today's files; it does not authorize a new date/device/card
 * mapping, fill an unknown field, or promote a stat count to verified evidence. */
export function existingRefreshObservation(task: BackupTask, preview: ExistingImportPreview) {
  return {
    metadata: {
      shootingDate: task.shootingDate,
      devices: [...task.devices],
      cameraPosition: task.cameraPosition,
      name: task.name,
    },
    observedInventory: { files: preview.files, bytes: preview.bytes, scannedAt: preview.scannedAt },
    metadataPreserved: true as const,
  };
}
