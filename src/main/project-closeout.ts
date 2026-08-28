import type { BackupTask, Destination, ProjectConfig } from "./types";

export function physicalDestinationKey(destination: Destination): string {
  if (destination.volumeUuid) return `uuid:${destination.volumeUuid}`;
  if (destination.volumeId) return `id:${destination.volumeId}`;
  const match = destination.path.match(/^\/Volumes\/([^/]+)/);
  if (match) return `volume:${match[1].toLocaleLowerCase()}`;
  // Old records without volume identity on the system disk must not turn
  // separate folders into separate safety copies.
  return "system-volume";
}

export function verifiedPhysicalCopyCount(task: BackupTask): number {
  return new Set(task.destinations.filter((destination) => destination.verified).map(physicalDestinationKey)).size;
}

export function taskMeetsCopyRequirement(task: BackupTask, requiredCopies: number): boolean {
  return task.status === "completed" && verifiedPhysicalCopyCount(task) >= requiredCopies;
}

export function projectCellStatus(project: ProjectConfig, tasks: BackupTask[], shootingDate: string, device: string) {
  const rows = tasks.filter((task) => task.shootingDate === shootingDate && task.devices.includes(device));
  const required = project.requiredCopies || 2;
  const rest = Boolean(project.restDays?.includes(shootingDate));
  const unused = Boolean(project.unusedDevicesByDate?.[shootingDate]?.includes(device));
  const safe = rows.filter((task) => taskMeetsCopyRequirement(task, required)).length;
  return {
    rows,
    safe,
    exempt: rest || unused,
    complete: rest || unused || Boolean(rows.length && safe === rows.length),
    label: rest ? "休息日" : unused ? "当天未使用" : rows.length && safe === rows.length ? "已满足收工要求" : rows.length ? `${safe} / ${rows.length} 达到 ${required} 份物理独立副本` : "尚未备份",
  };
}

export function projectCloseoutSummary(project: ProjectConfig, tasks: BackupTask[], dates: string[]) {
  const cells = dates.flatMap((shootingDate) => project.devices.map((device) => ({ shootingDate, device, ...projectCellStatus(project, tasks, shootingDate, device) })));
  return { total: cells.length, complete: cells.filter((cell) => cell.complete).length, pending: cells.filter((cell) => !cell.complete) };
}
