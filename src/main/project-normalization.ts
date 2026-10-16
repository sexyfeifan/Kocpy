import { normalizePositions } from "../common/interaction";
import { makeProjectFolderName } from "./project-path";
import { segment } from "./backup/safety";
import { createHash } from "node:crypto";
import type { ProjectConfig } from "./types";

/**
 * Legacy workspaces allowed non-calendar date strings. Keep those values
 * visible for explicit repair and derive only the missing display/root name
 * with the pre-0.1.50 digit stripping rule. Truly malformed values receive a
 * stable, visibly risky fallback; neither path changes the stored date.
 */
function legacyProjectFolderName(
  project: ProjectConfig,
  shootingDateStart: string,
): string {
  try {
    return makeProjectFolderName(shootingDateStart, project.name);
  } catch {
    const digits = String(shootingDateStart || "").replace(/[^0-9]/g, ""),
      safeName = (() => {
        try {
          return segment(project.name || "未命名项目");
        } catch {
          return "未命名项目";
        }
      })();
    if (/^\d{8}$/.test(digits)) return `${digits}_${safeName}`;
    const fingerprint = createHash("sha256")
      .update(`${project.id || "legacy"}\0${shootingDateStart}`)
      .digest("hex")
      .slice(0, 8);
    return `日期待修复_${safeName}_${fingerprint}`;
  }
}

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
      legacyProjectFolderName(project, shootingDateStart),
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
    // Missing means this project predates lazy directory creation. Preserve
    // the behaviour users already relied on instead of silently changing it.
    directoryCreationMode: project.directoryCreationMode || "precreate",
    managedProjectDirectories: (project.managedProjectDirectories || []).filter(
      (record) =>
        record &&
        typeof record.id === "string" &&
        typeof record.destinationRoot === "string" &&
        typeof record.destinationRealPath === "string" &&
        typeof record.relativePath === "string" &&
        typeof record.volumeId === "string" &&
        typeof record.createdAt === "number",
    ),
    directoryCleanupAudits: (project.directoryCleanupAudits || []).filter(
      (audit) =>
        audit &&
        typeof audit.id === "string" &&
        typeof audit.operator === "string" &&
        typeof audit.completedAt === "number" &&
        Array.isArray(audit.targets),
    ),
    requiredCopies: Math.max(1, Math.min(4, project.requiredCopies || 2)),
  };
}
