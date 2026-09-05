import { normalizePositions } from "../common/interaction";
import { makeProjectFolderName } from "./project-path";
import type { ProjectConfig } from "./types";

/**
 * Return the canonical persisted representation of a project.
 *
 * Keep this pure so imported projects can be normalized before the authority
 * commit and therefore remain byte-stable across a restart.
 */
export function normalizeProject(project: ProjectConfig): ProjectConfig {
  const shootingDateStart =
    project.shootingDateStart ||
    project.shootingDate ||
    new Date().toLocaleDateString("sv-SE");
  const devices = project.devices?.length
    ? project.devices.slice(0, 10)
    : ["FX3"];
  return {
    ...project,
    devices,
    shootingDateStart,
    shootingDateEnd: project.shootingDateEnd || shootingDateStart,
    projectFolderName:
      project.projectFolderName ||
      makeProjectFolderName(shootingDateStart, project.name),
    volumePrefixByDevice: Object.fromEntries(
      devices.map((device) => [
        device,
        project.volumePrefixByDevice?.[device] ||
          project.volumePrefix ||
          `${device}_`,
      ]),
    ),
    devicePositions: Object.fromEntries(
      devices.flatMap((device) => {
        const positions = normalizePositions(project.devicePositions?.[device]);
        return positions.length ? [[device, positions]] : [];
      }),
    ),
    restDays: [...new Set(project.restDays || [])],
    unusedDevicesByDate: Object.fromEntries(
      Object.entries(project.unusedDevicesByDate || {}).map(
        ([date, values]) => [
          date,
          [...new Set(values)].filter(
            (key) =>
              typeof key === "string" &&
              key.length <= 160 &&
              !/[\\/]/.test(key),
          ),
        ],
      ),
    ),
    expectedDevicesByDate: Object.fromEntries(
      Object.entries(project.expectedDevicesByDate || {}).map(
        ([date, values]) => [
          date,
          [...new Set(values)].filter(
            (key) =>
              typeof key === "string" &&
              key.length <= 160 &&
              !/[\\/]/.test(key),
          ),
        ],
      ),
    ),
    dailyPlanDecisions: (project.dailyPlanDecisions || []).filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.operator === "string" &&
        typeof item.at === "number",
    ),
    requiredCopies: Math.max(1, Math.min(4, project.requiredCopies || 2)),
  };
}
