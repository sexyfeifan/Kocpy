import type { BackupTask, Destination, ProjectConfig } from "./types";
import { copyEvidenceSummary, volumeCopyKey } from "../common/copy-evidence";
import { shootingDateKey } from "../common/shooting-dates";
import { groupLogicalVolumes } from "../common/logical-volumes";
export { manifestRequirementMet, taskMeetsCopyRequirement } from "../common/task-trust";

export function physicalDestinationKey(destination: Destination): string {
  // Legacy export: a volume key is NOT a physical-independence conclusion.
  return volumeCopyKey(destination);
}

export function verifiedPhysicalCopyCount(task: BackupTask): number {
  return copyEvidenceSummary(task.destinations).independentCopies;
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
  const tasksForDate = tasks.filter(
    (task) =>
      !shootingDate ||
      shootingDateKey(task.shootingDate) === shootingDateKey(shootingDate),
  );
  const declaredKeys = [
    ...Object.entries(project.expectedDevicesByDate || {}),
    ...Object.entries(project.unusedDevicesByDate || {}),
  ]
    .filter(
      ([date]) =>
        !shootingDate ||
        shootingDateKey(date) === shootingDateKey(shootingDate),
    )
    .flatMap(([, values]) => values)
    .filter(Boolean);
  const devices = [
    ...new Set([
      ...project.devices,
      ...tasksForDate.flatMap((task) => task.devices || []),
      ...declaredKeys.map((key) => key.split("::")[0]),
    ]),
  ];
  return devices.flatMap((device) => {
    const positions = [
      ...new Set([
        ...(project.devicePositions?.[device] || []),
        ...tasksForDate
          .filter((task) => task.devices.includes(device))
          .map((task) => task.cameraPosition)
          .filter((position): position is string => Boolean(position)),
        ...declaredKeys
          .filter((key) => key.startsWith(device + "::"))
          .map((key) => key.split("::")[1])
          .filter((position) => position && position !== "unassigned"),
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
      tasksForDate.some(
        (task) => task.devices.includes(device) && !task.cameraPosition,
      )
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
      shootingDateKey(task.shootingDate) === shootingDateKey(shootingDate) && task.devices.includes(device),
  );
  const hasPositionedRows =
    Boolean(project.devicePositions?.[device]?.length) ||
    deviceTasks.some(
      (task) => task.devices.includes(device) && Boolean(task.cameraPosition),
    );
  const rows = cameraPosition
    ? deviceTasks.filter((task) => task.cameraPosition === cameraPosition)
    : hasPositionedRows
      ? deviceTasks.filter((task) => !task.cameraPosition)
      : deviceTasks;
  const required = project.requiredCopies || 2;
  const logicalVolumes = groupLogicalVolumes(rows, required);
  const logicalRows = logicalVolumes.map((item) => item.representative);
  const rest = Boolean(project.restDays?.some(date => shootingDateKey(date) === shootingDateKey(shootingDate)));
  const keysFor = (byDate?: Record<string, string[]>) => Object.entries(byDate || {}).filter(([date]) => shootingDateKey(date) === shootingDateKey(shootingDate)).flatMap(([, keys]) => keys);
  const unusedKeys = keysFor(project.unusedDevicesByDate);
  const expectedKeys = keysFor(project.expectedDevicesByDate);
  const scheduleKey = cameraPosition ? `${device}::${cameraPosition}` : device;
  const unused = cameraPosition
    ? unusedKeys.includes(scheduleKey) || unusedKeys.includes(device)
    : unusedKeys.includes(device) ||
      unusedKeys.includes(`${device}::unassigned`);
  const expected = cameraPosition
    ? expectedKeys.includes(scheduleKey) || expectedKeys.includes(device)
    : expectedKeys.includes(device) ||
      expectedKeys.includes(`${device}::unassigned`);
  const safe = logicalVolumes.filter((item) => item.compliant).length;
  // A schedule declaration can explain an empty cell; it cannot waive the
  // verification requirements of material that is actually present.
  const exempt = !logicalRows.length && (rest || unused);
  return {
    rows: logicalRows,
    attempts: rows,
    logicalVolumes,
    safe,
    expected,
    unconfirmed: !rest && !unused && !expected && !logicalRows.length,
    attention: !exempt && (logicalRows.length ? safe !== logicalRows.length : expected),
    exempt,
    complete: exempt || Boolean(logicalRows.length && safe === logicalRows.length),
    label: exempt && rest
      ? "休息日"
      : exempt && unused
        ? "当天未使用"
        : logicalRows.length && safe === logicalRows.length
          ? "已满足收工要求"
          : logicalRows.length
            ? `${safe} / ${logicalRows.length} 个素材卷达到 ${required} 份物理独立副本`
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
  const cells = [...new Set(dates.map(shootingDateKey))].flatMap((shootingDate) =>
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
