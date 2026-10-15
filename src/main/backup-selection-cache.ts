import type { BackupSelectionPlan } from "../common/backup-selection";

/** Unlike analysis drafts, confirmed scopes belong to an editable composer and
 * cannot be silently evicted while that composer still displays confirmation. */
export function retainConfirmedSelection(cache: Map<string, BackupSelectionPlan>, plan: BackupSelectionPlan) {
  cache.set(plan.id, structuredClone(plan));
}

export function discardConfirmedSelections(cache: Map<string, BackupSelectionPlan>, ids: unknown) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    throw new Error("无效的范围确认编号");
  for (const id of ids) cache.delete(id);
}
