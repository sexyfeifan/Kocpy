import { validSelectionDate, type BackupSelectionGroup } from "../../common/backup-selection";

/** This only edits an unconfirmed UI draft, never a frozen selection or media. */
export function batchAssignableGroups(groups: BackupSelectionGroup[], assignments: Record<string, string>, from: string) {
  if (!validSelectionDate(from)) return [];
  return groups.filter(group => !group.mandatory && validSelectionDate(group.suggestedDate) &&
    validSelectionDate(assignments[group.id] || group.suggestedDate) &&
    (assignments[group.id] || group.suggestedDate) === from);
}

export function applyBatchShootingDate(groups: BackupSelectionGroup[], assignments: Record<string, string>, selectedDates: string[], from: string, to: string) {
  if (!validSelectionDate(to) || from === to) throw new Error("请选择不同且有效的拍摄归属日");
  const eligible = batchAssignableGroups(groups, assignments, from);
  if (!eligible.length) throw new Error("该日期没有可批量修正的素材组；必须保留或未知日期内容不会自动归属");
  return {
    assignedDates: { ...assignments, ...Object.fromEntries(eligible.map(group => [group.id, to])) },
    // Keep every prior inclusion. This action is not an instruction to exclude
    // other dates, including the source date when other groups still use it.
    selectedDates: [...new Set([...selectedDates, to])],
    changedGroups: eligible.length,
    changedFiles: eligible.reduce((sum, group) => sum + group.files, 0),
    acknowledged: false as const,
  };
}
