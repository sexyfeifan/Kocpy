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
  return new Set(
    task.destinations
      .filter((destination) => destination.verified)
      .map(physicalDestinationKey),
  ).size;
}

export function taskMeetsCopyRequirement(
  task: BackupTask,
  requiredCopies: number,
): boolean {
  return (
    task.status === "completed" &&
    verifiedPhysicalCopyCount(task) >= requiredCopies
  );
}

export interface ProjectDeviceCell {
  device: string;
  cameraPosition?: string;
  label: string;
  scheduleKey: string;
}

export function projectDeviceCells(
  project: ProjectConfig,
  tasks: BackupTask[] = [],
  shootingDate?: string,
): ProjectDeviceCell[] {
  const devices = [
    ...new Set([
      ...project.devices,
      ...tasks
        .filter((task) => !shootingDate || task.shootingDate === shootingDate)
        .flatMap((task) => task.devices || []),
    ]),
  ];
  return devices.flatMap((device) => {
    const positions = [
      ...new Set([
        ...(project.devicePositions?.[device] || []),
        ...tasks
          .filter((task) => task.devices.includes(device))
          .map((task) => task.cameraPosition)
          .filter((position): position is string => Boolean(position)),
      ]),
    ];
    if (!positions.length)
      return [{ device, label: device, scheduleKey: device }];
    const cells: ProjectDeviceCell[] = positions.map((cameraPosition) => ({
      device,
      cameraPosition,
      label: `${device} · ${cameraPosition}`,
      scheduleKey: `${device}::${cameraPosition}`,
    }));
    if (
      tasks.some(
        (task) => task.devices.includes(device) && !task.cameraPosition,
      ) &&
      (!shootingDate ||
        tasks.some(
          (task) =>
            task.shootingDate === shootingDate &&
            task.devices.includes(device) &&
            !task.cameraPosition,
        ))
    )
      cells.push({
        device,
        label: `${device} · 未标机位`,
        scheduleKey: `${device}::unassigned`,
      });
    return cells;
  });
}

export function projectCellStatus(
  project: ProjectConfig,
  tasks: BackupTask[],
  shootingDate: string,
  device: string,
  cameraPosition?: string,
) {
  const deviceTasks = tasks.filter(
    (task) =>
      task.shootingDate === shootingDate && task.devices.includes(device),
  );
  const hasPositionedRows =
    Boolean(project.devicePositions?.[device]?.length) ||
    tasks.some(
      (task) => task.devices.includes(device) && Boolean(task.cameraPosition),
    );
  const rows = cameraPosition
    ? deviceTasks.filter((task) => task.cameraPosition === cameraPosition)
    : hasPositionedRows
      ? deviceTasks.filter((task) => !task.cameraPosition)
      : deviceTasks;
  const required = project.requiredCopies || 2;
  const rest = Boolean(project.restDays?.includes(shootingDate));
  const unusedKeys = project.unusedDevicesByDate?.[shootingDate] || [];
  const expectedKeys = project.expectedDevicesByDate?.[shootingDate] || [];
  const scheduleKey = cameraPosition ? `${device}::${cameraPosition}` : device;
  const unused = cameraPosition
    ? unusedKeys.includes(scheduleKey) || unusedKeys.includes(device)
    : unusedKeys.includes(device) ||
      unusedKeys.includes(`${device}::unassigned`);
  const expected = cameraPosition
    ? expectedKeys.includes(scheduleKey) || expectedKeys.includes(device)
    : expectedKeys.includes(device) ||
      expectedKeys.includes(`${device}::unassigned`);
  const safe = rows.filter((task) =>
    taskMeetsCopyRequirement(task, required),
  ).length;
  return {
    rows,
    safe,
    expected,
    unconfirmed: !rest && !unused && !expected && !rows.length,
    attention:
      !rest &&
      !unused &&
      (expected ? !rows.length : Boolean(rows.length && safe !== rows.length)),
    exempt: rest || unused,
    complete: rest || unused || Boolean(rows.length && safe === rows.length),
    label: rest
      ? "休息日"
      : unused
        ? "当天未使用"
        : rows.length && safe === rows.length
          ? "已满足收工要求"
          : rows.length
            ? `${safe} / ${rows.length} 个素材卷达到 ${required} 份物理独立副本`
            : expected
              ? "应该有素材 · 缺少备份"
              : "当天未发现素材 · 待确认",
  };
}

export function projectCloseoutSummary(
  project: ProjectConfig,
  tasks: BackupTask[],
  dates: string[],
) {
  const cells = dates.flatMap((shootingDate) =>
    projectDeviceCells(project, tasks, shootingDate).map((cell) => ({
      shootingDate,
      ...cell,
      ...projectCellStatus(
        project,
        tasks,
        shootingDate,
        cell.device,
        cell.cameraPosition,
      ),
    })),
  );
  return {
    total: cells.length,
    complete: cells.filter((cell) => cell.complete).length,
    pending: cells.filter((cell) => cell.attention),
    unconfirmed: cells.filter((cell) => cell.unconfirmed),
  };
}
