import type {
  BackupTask,
  CardDateAllocationGroup,
} from "../main/types";

export interface TaskDateContribution {
  shootingDate: string;
  files: number;
  bytes: number;
  scope: "full-card" | "daily-allocation";
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

const safeCount = (value: number, integer = false) => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return integer ? Math.floor(value) : value;
};

/**
 * Split one complete-card task into read-only shooting-day projections.
 * Delivery runs are deliberately ignored: they are derivative artifacts, not
 * backup attempts or independent-copy evidence.
 */
export function taskDateContributions(
  task: BackupTask,
): TaskDateContribution[] {
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
  const plan = task.dateAllocation;
  if (!plan || plan.sourceTaskId !== task.id || !Array.isArray(plan.groups))
    return [];
  return [
    ...new Set(plan.groups.map(confirmedDate).filter(Boolean)),
  ].sort();
}
