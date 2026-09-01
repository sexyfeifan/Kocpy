import type { BackupTask } from "../main/types";
import { taskMeetsCopyRequirement } from "./task-trust";

export interface LogicalVolumeGroup {
  id: string;
  attempts: BackupTask[];
  representative: BackupTask;
  compliant: boolean;
}

export function groupLogicalVolumes(
  tasks: BackupTask[],
  requiredCopies: number,
): LogicalVolumeGroup[] {
  const groups = new Map<string, BackupTask[]>();
  for (const task of tasks) {
    const id = task.logicalVolumeId || task.id;
    groups.set(id, [...(groups.get(id) || []), task]);
  }
  return [...groups.entries()].map(([id, attempts]) => ({
    id,
    attempts,
    representative: [...attempts].sort(
      (a, b) =>
        (b.completedAt || b.createdAt || 0) -
        (a.completedAt || a.createdAt || 0),
    )[0],
    compliant: attempts.some((task) =>
      taskMeetsCopyRequirement(task, requiredCopies),
    ),
  }));
}
