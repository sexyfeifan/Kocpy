import type {
  BackupTask,
  CardDateAllocationGroup,
  CardDateAllocationPlan,
} from "../main/types";
import { conservativeSelectionFamilies } from "./backup-selection";

export const dailyDeliveryMediaPattern = /\.(mov|mp4|mxf|mkv|avi|m4v|mts|m2ts|r3d|braw|crm|ari|cine|jpg|jpeg|heic|tif|tiff|png|dng|arw|cr2|cr3|nef|nrw|raf|orf|rw2|raw|wav|bwf|mp3|aac|flac|aif|aiff)$/i;
const recognizedSidecar = /\.(xml|xmp|lrf|thm|srt|smi|cue|cpi|bnp|int)$/i;

export function assertCompleteCardForDelivery(task: BackupTask) {
  const selection = task.selection;
  if (selection && (!selection.wholeCardCovered || selection.excludedFiles.length > 0 ||
    new Set(selection.includedPaths).size !== selection.sourceFiles.length))
    throw new Error("此任务只备份了选定范围，不能作为完整卡生成当日交付。请先保留并校验原整卡副本，再从完整卡整理交付。");
}

export function dailyDeliveryFamilyMustBeRetained(relativePaths: string[], packageProtected: boolean) {
  return packageProtected || !relativePaths.some((relative) => dailyDeliveryMediaPattern.test(relative)) ||
    relativePaths.some((relative) => !dailyDeliveryMediaPattern.test(relative) && !recognizedSidecar.test(relative));
}

export interface TaskDateContribution {
  shootingDate: string;
  files: number;
  bytes: number;
  scope: "full-card" | "daily-allocation" | "selected-scope";
  pendingAllocation: boolean;
  pendingGroups: number;
}

const dateKey = (value?: string) => {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value || "");
  if (!match) return "";
  const iso = `${match[1]}-${match[2]}-${match[3]}`,
    parsed = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === iso
    ? iso
    : "";
};

const confirmedDate = (group: CardDateAllocationGroup) => {
  const assigned = dateKey(group.assignedDate);
  return assigned &&
    Number.isFinite(group.confirmedAt) &&
    Boolean(group.confirmedBy?.trim())
    ? assigned
    : "";
};

/** Shared, pure delivery closure for execution and persisted-run validation.
 * Evidence digests and on-disk identity/checksums are checked by the caller. */
export function dailyDeliverySelectedRecords(task: BackupTask, plan: CardDateAllocationPlan, shootingDate: string) {
  assertCompleteCardForDelivery(task);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(shootingDate) || !dateKey(shootingDate) || dateKey(shootingDate) !== shootingDate) throw new Error("请选择有效拍摄日期");
  if (plan.sourceTaskId !== task.id) throw new Error("日期归属依据已变化，请重新分析并确认");
  const selected = plan.groups.filter((group) => confirmedDate(group) === shootingDate);
  if (!selected.length) throw new Error("该拍摄日没有已确认归属的文件");
  const paths = new Set(selected.flatMap((group) => group.relativePaths));
  const knownPaths = new Set(task.fileRecords.map((record) => record.relativePath));
  const plannedPaths = new Set<string>();
  for (const group of plan.groups) {
    for (const relative of group.relativePaths) {
      if (!knownPaths.has(relative) || plannedPaths.has(relative)) throw new Error("日期归属文件记录重复或已不存在，请重新分析");
      plannedPaths.add(relative);
      if (group.requiredForDelivery || !confirmedDate(group)) paths.add(relative);
    }
  }
  // Old saved assignments cannot authorize splitting a package or dropping
  // shared/unknown files, an unconfirmed group, or files absent from the plan.
  for (const family of conservativeSelectionFamilies([...knownPaths], task.sourcePath)) {
    if (family.protectionReason || dailyDeliveryFamilyMustBeRetained(family.relativePaths, family.packageProtected) ||
      family.relativePaths.some((relative) => paths.has(relative) || !plannedPaths.has(relative)))
      family.relativePaths.forEach((relative) => paths.add(relative));
  }
  const records = task.fileRecords.filter((record) => paths.has(record.relativePath));
  if (!records.length) throw new Error("该拍摄日没有已确认归属的文件");
  if (records.length !== paths.size) throw new Error("日期归属包含重复或已不存在的文件记录");
  return records;
}

const safeCount = (value: number, integer = false) => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return integer ? Math.floor(value) : value;
};

/** A filtered task only owns its included paths. Historical exclusions and the
 * original scan totals must never inflate its project or shooting-day totals. */
function selectedScopeContributions(task: BackupTask): TaskDateContribution[] {
  const selection = task.selection!, originalDate = dateKey(task.shootingDate);
  if (!Array.isArray(selection.includedPaths) || !Array.isArray(selection.sourceFiles) || !Array.isArray(selection.groups))
    return originalDate ? [{ shootingDate: originalDate, files: safeCount(task.totalFiles, true), bytes: safeCount(task.totalBytes), scope: "selected-scope", pendingAllocation: true, pendingGroups: 1 }] : [];
  const excluded = new Set(selection.excludedFiles?.map((file) => file.relativePath) || []);
  const included = new Set(selection.includedPaths.filter((relative) => !excluded.has(relative)));
  const files = new Map(selection.sourceFiles.map((file) => [file.relativePath, file]));
  const assignments = new Map<string, { date: string; group: string }>();
  const confirmed = Number.isFinite(selection.confirmedAt) && Boolean(selection.operator?.trim());
  for (const group of selection.groups) {
    const assigned = confirmed ? dateKey(selection.assignedDates?.[group.id]) : "";
    for (const relative of group.relativePaths) {
      if (!included.has(relative)) continue;
      const previous = assignments.get(relative);
      // Duplicate path membership cannot silently move a file to one of two days.
      assignments.set(relative, previous ? { date: "", group: `overlap:${relative}` } : { date: assigned, group: group.id });
    }
  }
  // A subsequently reviewed allocation can refine a complete card, but a
  // partial task is never promoted to complete-card evidence by that record.
  if (selection.wholeCardCovered && task.dateAllocation?.sourceTaskId === task.id) {
    const later = new Map<string, { date: string; group: string }>();
    for (const group of task.dateAllocation.groups) {
      for (const relative of group.relativePaths) {
        if (!included.has(relative)) continue;
        later.set(relative, later.has(relative) ? { date: "", group: `overlap:${relative}` } : { date: confirmedDate(group), group: group.id });
      }
    }
    for (const [relative, assignment] of later) assignments.set(relative, assignment);
  }
  const buckets = new Map<string, TaskDateContribution>();
  const pending = new Map<string, Set<string>>();
  for (const relative of included) {
    const assignment = assignments.get(relative), assigned = assignment?.date || "";
    const day = assigned || originalDate;
    if (!day) continue;
    const item = buckets.get(day) || { shootingDate: day, files: 0, bytes: 0, scope: "selected-scope" as const, pendingAllocation: false, pendingGroups: 0 };
    item.files += 1;
    item.bytes += safeCount(files.get(relative)?.size || 0);
    if (!assigned || !files.has(relative)) {
      const groups = pending.get(day) || new Set<string>();
      groups.add(assignment?.group || "unassigned-included-files");
      pending.set(day, groups);
      item.pendingAllocation = true;
      item.pendingGroups = groups.size;
    }
    buckets.set(day, item);
  }
  return [...buckets.values()].sort((left, right) => left.shootingDate.localeCompare(right.shootingDate));
}

/**
 * Split one complete-card task into read-only shooting-day projections.
 * Delivery runs are deliberately ignored: they are derivative artifacts, not
 * backup attempts or independent-copy evidence.
 */
export function taskDateContributions(
  task: BackupTask,
): TaskDateContribution[] {
  if (task.selection) return selectedScopeContributions(task);
  const originalDate = dateKey(task.shootingDate),
    totalFiles = safeCount(task.totalFiles, true),
    totalBytes = safeCount(task.totalBytes),
    plan = task.dateAllocation;
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    plan.sourceTaskId !== task.id ||
    !Array.isArray(plan.groups) ||
    !plan.groups.length
  )
    return originalDate
      ? [
          {
            shootingDate: originalDate,
            files: totalFiles,
            bytes: totalBytes,
            scope: "full-card",
            pendingAllocation: Boolean(plan),
            pendingGroups: plan ? 1 : 0,
          },
        ]
      : [];

  const contributions = new Map<string, TaskDateContribution>();
  let remainingFiles = totalFiles,
    remainingBytes = totalBytes;
  const add = (
    shootingDate: string,
    files: number,
    bytes: number,
    pending: boolean,
  ) => {
    if (!shootingDate || (!files && !bytes)) return;
    const current = contributions.get(shootingDate) || {
      shootingDate,
      files: 0,
      bytes: 0,
      scope: "daily-allocation" as const,
      pendingAllocation: false,
      pendingGroups: 0,
    };
    current.files += files;
    current.bytes += bytes;
    current.pendingAllocation ||= pending;
    if (pending) current.pendingGroups += 1;
    contributions.set(shootingDate, current);
  };

  for (const group of plan.groups) {
    const files = Math.min(remainingFiles, safeCount(group.files, true)),
      bytes = Math.min(remainingBytes, safeCount(group.bytes)),
      assignedDate = confirmedDate(group),
      contributionDate = assignedDate || originalDate;
    remainingFiles -= files;
    remainingBytes -= bytes;
    add(contributionDate, files, bytes, !assignedDate);
  }

  // A partial or stale allocation must never make recorded card material
  // disappear from statistics. Keep any residual on the original task date
  // and make the unresolved boundary visible.
  add(originalDate, remainingFiles, remainingBytes, true);
  return [...contributions.values()].sort((left, right) =>
    left.shootingDate.localeCompare(right.shootingDate),
  );
}

export function taskDateContribution(
  task: BackupTask,
  shootingDate: string,
) {
  const day = dateKey(shootingDate);
  return taskDateContributions(task).find(
    (contribution) => contribution.shootingDate === day,
  );
}

export function assignedShootingDates(task: BackupTask) {
  if (task.selection) return selectedScopeContributions(task).map((contribution) => contribution.shootingDate);
  const plan = task.dateAllocation;
  if (!plan || plan.sourceTaskId !== task.id || !Array.isArray(plan.groups))
    return [];
  return [
    ...new Set(plan.groups.map(confirmedDate).filter(Boolean)),
  ].sort();
}
