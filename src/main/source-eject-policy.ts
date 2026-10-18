import { createHash } from "node:crypto";
import type { BackupTask, ProjectConfig } from "./types";
import { manifestRequirementMet, taskMeetsCopyRequirement } from "../common/task-trust";

/** Qualified ejection is not a plain OS unmount and never authorizes formatting. */
export function ejectCopyRequirement(task: BackupTask, project?: ProjectConfig): number | undefined {
  if (!task.projectId) return 1;
  if (!project || project.id !== task.projectId) return undefined;
  if (task.projectRuleSnapshotId) {
    const snapshots = project.ruleSnapshots?.filter(item => item.id === task.projectRuleSnapshotId) || [];
    if (snapshots.length !== 1) return undefined;
    const snapshot = snapshots[0];
    if (createHash("sha256").update(JSON.stringify(snapshot.rules)).digest("hex") !== snapshot.sha256)
      return undefined;
    return snapshot.rules.requiredCopies;
  }
  // Legacy tasks without a frozen reference use the explicit current policy.
  return project.requiredCopies || 2;
}

export function qualifiedForEjection(task: BackupTask, project?: ProjectConfig, requiredOverride?: number): boolean {
  const required = ejectCopyRequirement(task, project);
  return required !== undefined && task.status === "completed" && task.destinations.length > 0 &&
    task.destinations.every(destination => destination.verified) && manifestRequirementMet(task) &&
    taskMeetsCopyRequirement(task, Math.max(required, requiredOverride || 0));
}
