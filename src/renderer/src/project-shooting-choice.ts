import type { BackupTask, ProjectConfig } from "../../main/types";
import { projectDates, shootingDateKey } from "../../common/shooting-dates";
import { projectDayDevices } from "../../common/project-day-devices";
import { canonicalCalendarDate } from "../../common/calendar-date";

export interface ProjectShootingChoice {
  shootDate: string;
  camera: string;
  multiPosition: boolean;
  cameraPosition: string;
  shootDateExplicit?: boolean;
}

export function projectShootingDates(project: ProjectConfig, tasks: BackupTask[]) {
  return projectDates(project, tasks.filter(task => task.projectId === project.id))
    .filter(date => canonicalCalendarDate(date) === date);
}

export function readProjectShootingChoice(projectId: string): Partial<ProjectShootingChoice> {
  try {
    const value = JSON.parse(localStorage.getItem(`kocpy-project-choice-${projectId}`) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      // Older releases did not record this flag; keep their valid saved choice.
      // New automatic defaults must not masquerade as a human-selected day.
      shootDate: value.shootDateExplicit !== false && typeof value.shootDate === "string" ? value.shootDate : undefined,
      camera: typeof value.camera === "string" ? value.camera : undefined,
      cameraPosition: typeof value.cameraPosition === "string" ? value.cameraPosition : undefined,
      multiPosition: typeof value.multiPosition === "boolean" ? value.multiPosition : undefined,
      shootDateExplicit: typeof value.shootDateExplicit === "boolean" ? value.shootDateExplicit : undefined,
    };
  } catch { return {}; }
}

/** Resolve before the first persistence effect. A production day is a human
 * choice, never a midnight cutoff or a rewrite of a source timestamp. */
export function resolveProjectShootingChoice(
  project: ProjectConfig,
  tasks: BackupTask[],
  naturalToday: string,
  explicit: { shootingDate?: string; device?: string; position?: string } = {},
  recent: Partial<ProjectShootingChoice> = {},
): ProjectShootingChoice {
  const allowed = projectShootingDates(project, tasks);
  const shootDate = [explicit.shootingDate, recent.shootDate, naturalToday,
    project.shootingDateStart || project.shootingDate, allowed[0]]
    .map(shootingDateKey).find(date => allowed.includes(date)) || "";
  const shootDateExplicit = [explicit.shootingDate, recent.shootDate]
    .map(shootingDateKey).some(date => allowed.includes(date));
  const devices = projectDayDevices(project, shootDate);
  const camera = [explicit.device, recent.camera, devices[0]?.device]
    .find(name => devices.some(device => device.device === name)) || "";
  const entry = devices.find(device => device.device === camera), positions = entry?.positions || [];
  const explicitPosition = explicit.device === camera && positions.includes(explicit.position || "") ? explicit.position : undefined;
  const rememberedPosition = recent.camera === camera && positions.includes(recent.cameraPosition || "") ? recent.cameraPosition : undefined;
  const multiPosition = Boolean(positions.length) && (Boolean(explicitPosition) || !entry?.allowUnpositioned ||
    !(recent.camera === camera && recent.multiPosition === false));
  return { shootDate, camera, multiPosition, cameraPosition: explicitPosition || rememberedPosition || positions[0] || "A", shootDateExplicit };
}
