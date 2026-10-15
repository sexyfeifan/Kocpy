import type { ProjectConfig } from "../main/types";
import { shootingDateKey } from "./shooting-dates";
import { renderProjectCardPath } from "./project-layout";

export interface ProjectDayDevice {
  device: string;
  positions: string[];
  allowUnpositioned: boolean;
  temporary: boolean;
}

const pathKey = (value: string) => value.normalize("NFD").toLowerCase();
const dayKeys = (project: ProjectConfig, date: string) =>
  Object.entries(project.expectedDevicesByDate || {})
    .filter(([key]) => shootingDateKey(key) === shootingDateKey(date))
    .flatMap(([, values]) => values);

/** Only explicit plans for this date grant access to a temporary device. */
export function projectDayDevices(
  project: ProjectConfig,
  date: string,
): ProjectDayDevice[] {
  const devices = new Map<string, ProjectDayDevice>();
  for (const device of project.devices) {
    devices.set(device, {
      device,
      positions: [...new Set(project.devicePositions?.[device] || [])],
      allowUnpositioned: true,
      temporary: false,
    });
  }
  for (const key of dayKeys(project, date)) {
    const [device, position, extra] = key.split("::");
    if (!device || extra !== undefined || position === "unassigned") continue;
    const entry = devices.get(device) || {
      device,
      positions: [],
      allowUnpositioned: false,
      temporary: true,
    };
    if (position) {
      if (!entry.positions.includes(position)) entry.positions.push(position);
    } else entry.allowUnpositioned = true;
    devices.set(device, entry);
  }
  return [...devices.values()];
}

export function assertProjectDayDeviceAllowed(
  project: ProjectConfig,
  date: string,
  device: string,
  position?: string,
): void {
  if (project.status === "archived") throw new Error("项目已归档，请先恢复项目后再创建备份");
  temporaryDeviceScheduleKey(device, position);
  const entry = projectDayDevices(project, date).find((item) => item.device === device);
  if (!entry) throw new Error("所选设备尚未加入此拍摄日，请先添加当日设备");
  if (position ? !entry.positions.includes(position) : !entry.allowUnpositioned)
    throw new Error("所选机位尚未加入此拍摄日，请选择已配置机位或添加当日机位");
}

/** New names must be path-safe as entered, never silently renamed by sanitizing. */
export function temporaryDeviceScheduleKey(device: string, position?: string): string {
  const clean = (value: string) => {
    const result = value.trim().normalize("NFC");
    if (!result || result.length > 100 || result === "." || result === ".." ||
      /[<>:"/\\|?*\x00-\x1f\x7f]/.test(result))
      throw new Error("设备或机位名称无效：请使用不超过 100 字符的名称，不能包含路径或特殊符号");
    return result;
  };
  const name = clean(device), cameraPosition = position?.trim() ? clean(position) : undefined;
  if (cameraPosition === "unassigned") throw new Error("请填写实际机位名称，不能使用保留名称 unassigned");
  const key = cameraPosition ? `${name}::${cameraPosition}` : name;
  if (key.length > 160) throw new Error("设备和机位名称合计最多 160 个字符");
  return key;
}

export function validateTemporaryDevicePlan(
  project: ProjectConfig,
  date: string,
  scheduleKey: string,
): string {
  if (project.status === "archived") throw new Error("项目已归档，请先恢复项目后再添加设备");
  const [rawDevice, rawPosition, extra] = scheduleKey.split("::");
  if (extra !== undefined) throw new Error("设备或机位名称无效");
  const canonical = temporaryDeviceScheduleKey(rawDevice, rawPosition);
  const [device, position] = canonical.split("::");
  // Include historical plans when checking spelling: the same device should not
  // acquire an ambiguous alias on a later date or a case-insensitive volume.
  const allKeys = [
    ...project.devices.flatMap((name) => [name, ...(project.devicePositions?.[name] || []).map((p) => `${name}::${p}`)]),
    ...Object.values(project.expectedDevicesByDate || {}).flat(),
    ...Object.values(project.unusedDevicesByDate || {}).flat(),
  ];
  for (const key of allKeys) {
    const [existingDevice, existingPosition] = key.split("::");
    if (pathKey(existingDevice) === pathKey(device) && existingDevice !== device)
      throw new Error(`设备名称与「${existingDevice}」指向相同目录，请使用已有名称`);
    if (existingDevice === device && position && existingPosition &&
      pathKey(existingPosition) === pathKey(position) && existingPosition !== position)
      throw new Error(`机位名称与「${existingPosition}」指向相同目录，请使用已有名称`);
  }
  const directory = (name: string, cameraPosition?: string) => pathKey(renderProjectCardPath(project.namingRule, {
    projectName: project.name,
    projectFolderName: project.projectFolderName || project.name,
    projectStartDate: project.shootingDateStart || project.shootingDate || date,
    shootingDate: date,
    device: name,
    position: cameraPosition,
    card: "KocpyDirectoryCheck",
  }));
  const proposed = directory(device, position);
  for (const entry of projectDayDevices(project, date)) {
    const positions = [...(entry.allowUnpositioned ? [undefined] : []), ...entry.positions];
    for (const candidatePosition of positions) {
      if (entry.device === device && candidatePosition === position) continue;
      if (directory(entry.device, candidatePosition) === proposed)
        throw new Error(`当前目录规则会使该设备与「${entry.device}${candidatePosition ? ` · ${candidatePosition}` : ""}」共用目录，请先调整命名规则`);
    }
  }
  return canonical;
}
