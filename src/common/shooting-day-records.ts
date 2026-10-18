import type { BackupTask, FileRecord } from "../main/types";
import { validSelectionDate } from "./backup-selection";
import { taskDateContribution } from "./date-allocation";
import { shootingDateKey } from "./shooting-dates";

function canonicalDay(value?: string): string {
  const day = shootingDateKey(value);
  return validSelectionDate(day) ? day : "";
}

export function requireShootingDay(value: string): string {
  const day = canonicalDay(value);
  if (!day) throw new Error("请选择真实有效的拍摄日期");
  return day;
}

function legacyTaskDay(task: BackupTask): string {
  // A present but invalid project date is not permission to invent a new date.
  if (task.shootingDate) return "";
  const timestamp = task.completedAt || task.createdAt;
  return timestamp && Number.isFinite(timestamp)
    ? canonicalDay(new Date(timestamp).toLocaleDateString("sv-SE"))
    : "";
}

/** The archive caller intentionally verifies the entire recorded volume once
 * this read-only projection selects it, never just an unchecked subset. */
export function taskBelongsToShootingDay(
  task: BackupTask,
  shootingDate: string,
  allowLegacyTimestamp = false,
): boolean {
  const day = requireShootingDay(shootingDate);
  return Boolean(taskDateContribution(task, day)) ||
    (allowLegacyTimestamp && legacyTaskDay(task) === day);
}

export interface ShootingDayRecord {
  file: FileRecord;
  /** Blank for unresolved material: never present a suggestion as a fact. */
  shootingDate?: string;
  dateStatus: "confirmed-assignment" | "task-date" | "legacy-completion-date" | "pending-allocation";
  reportDate: string;
}

/** Media-list projection only, not a copy plan. Keep unresolved records from a
 * selected task visible, explicitly unassigned, rather than silently omit them.
 * A confirmed assignment to another date is never exported as this day's media.
 * Frozen task metadata, original paths and prior reports are never rewritten. */
export function recordsForShootingDay(
  task: BackupTask,
  shootingDate: string,
): ShootingDayRecord[] {
  const day = requireShootingDay(shootingDate);
  if (!taskBelongsToShootingDay(task, day, true)) return [];
  return projectFileDateRecords(task, true).filter(record => !record.shootingDate || record.shootingDate === day)
    .map(record => ({ ...record, reportDate: day }));
}

/** One row per copied file, with an explicit unresolved state, never an inferred task day. */
export function projectFileDateRecords(task: BackupTask, allowLegacyTimestamp = false): Omit<ShootingDayRecord, "reportDate">[] {
  const selection = task.selection,
    plan = task.dateAllocation,
    originalDay = canonicalDay(task.shootingDate),
    legacyDay = allowLegacyTimestamp ? legacyTaskDay(task) : "";
  const excluded = new Set(selection?.excludedFiles.map((entry) => entry.relativePath));
  const included = selection
    ? new Set(selection.includedPaths.filter((relative) => !excluded.has(relative)))
    : undefined;
  const assignments = new Map<string, string>();
  const addGroups = (groups: Array<{ relativePaths: string[] }>, date: (index: number) => string) => {
    const next = new Map<string, string>();
    groups.forEach((group, index) => {
      const assigned = date(index);
      for (const relative of group.relativePaths) {
        // Contradictory membership must remain unresolved, not last-writer-wins.
        next.set(relative, next.has(relative) ? "" : assigned);
      }
    });
    for (const [relative, assigned] of next) assignments.set(relative, assigned);
  };
  if (selection) {
    const confirmed = Number.isFinite(selection.confirmedAt) && Boolean(selection.operator.trim());
    addGroups(selection.groups, (index) => confirmed
      ? canonicalDay(selection.assignedDates[selection.groups[index].id]) : "");
  }
  if ((!selection || selection.wholeCardCovered) && plan?.schemaVersion === 1 && plan.sourceTaskId === task.id) {
    addGroups(plan.groups, (index) => {
      const group = plan.groups[index];
      return Number.isFinite(group.confirmedAt) && group.confirmedBy?.trim()
        ? canonicalDay(group.assignedDate) : "";
    });
  }
  const hasAllocation = Boolean(selection || plan);
  return task.fileRecords.flatMap((file): Omit<ShootingDayRecord, "reportDate">[] => {
    if (included && !included.has(file.relativePath)) return [];
    if (!hasAllocation) {
      return [{ file, shootingDate: originalDay || legacyDay || undefined,
        dateStatus: originalDay ? "task-date" : legacyDay ? "legacy-completion-date" : "pending-allocation" }];
    }
    const assigned = assignments.get(file.relativePath);
    return [{ file, shootingDate: assigned || undefined,
      dateStatus: assigned ? "confirmed-assignment" : "pending-allocation" }];
  });
}

export function shootingDayArchiveScopeNote(shootingDate: string): string {
  return `${requireShootingDay(shootingDate)}：按拍摄日归属选择相关素材卷，复校验每个命中任务的全部已记录文件与目录，可能包含其他拍摄日；不是仅核验该日文件。选定范围任务仍只代表其原有范围，不提升为整卡完整副本。`;
}
