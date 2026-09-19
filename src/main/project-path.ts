import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderProjectCardPath } from "../common/project-layout";
import { normalizePositions } from "../common/interaction";
export { renderProjectCardPath } from "../common/project-layout";
import { promises as fs } from "node:fs";
import { segment } from "./backup/safety";
import { volumeIdentity } from "./system";
import type { ProjectConfig, ProjectStructureReport } from "./types";

export function compactDate(value: string): string {
  const compact = String(value || "").replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(compact)) throw new Error("项目拍摄日期无效");
  return compact;
}

export function makeProjectFolderName(
  startDate: string,
  projectName: string,
): string {
  return `${compactDate(startDate)}_${segment(projectName)}`;
}

export function makeProjectDayPath(
  projectFolderName: string,
  shootingDate: string,
  device: string,
  cameraPosition?: string,
): string {
  return path.join(
    makeProjectDatePath(projectFolderName, shootingDate),
    segment(device),
    ...(cameraPosition ? [segment(cameraPosition)] : []),
  );
}

export function makeProjectDatePath(
  projectFolderName: string,
  shootingDate: string,
): string {
  return path.join(segment(projectFolderName), compactDate(shootingDate));
}

export async function createProjectDateFolders(
  destinations: string[],
  projectFolderName: string,
  shootingDate: string,
): Promise<string[]> {
  const relative = makeProjectDatePath(projectFolderName, shootingDate);
  const created = destinations.map((destination) =>
    path.join(destination, relative),
  );
  await Promise.all(
    created.map((folder) => fs.mkdir(folder, { recursive: true })),
  );
  return created;
}

export function projectShootingDates(
  startDate: string,
  endDate = startDate,
): string[] {
  const parse = (value: string) => {
    const compact = compactDate(value);
    return new Date(
      Date.UTC(
        Number(compact.slice(0, 4)),
        Number(compact.slice(4, 6)) - 1,
        Number(compact.slice(6, 8)),
      ),
    );
  };
  const start = parse(startDate),
    end = parse(endDate);
  if (end < start) throw new Error("项目结束日期不能早于开始日期");
  const dates: string[] = [];
  for (
    let value = start.getTime();
    value <= end.getTime();
    value += 86_400_000
  ) {
    if (dates.length >= 1000)
      throw new Error("项目日期跨度超过 1000 天，请检查拍摄日期");
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

export function expectedProjectPaths(project: ProjectConfig): string[] {
  if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
  const folder =
    project.projectFolderName ||
    makeProjectFolderName(project.shootingDateStart, project.name);
  const devices = [...new Set(project.devices.map(segment))];
  if (!devices.length) throw new Error("请至少选择一个设备或机位");
  return projectShootingDates(
    project.shootingDateStart,
    project.shootingDateEnd || project.shootingDateStart,
  ).flatMap((date) =>
    devices.flatMap((device) => {
      const positions = normalizePositions(project.devicePositions?.[device]);
      return (positions.length ? positions : [undefined])
        .map((position) => {
          if (!project.namingRule)
            return makeProjectDayPath(folder, date, device, position);
          // Only pre-create the prefix before the card component; never invent a card.
          const full = renderProjectCardPath(project.namingRule, {
            projectFolderName: folder,
            projectName: project.name,
            projectStartDate: project.shootingDateStart!,
            shootingDate: date,
            device,
            position,
            card: "__KOCPY_CARD__",
          });
          const prefix = full
            .split("/")
            .slice(
              0,
              full
                .split("/")
                .findIndex((part) => part.includes("__KOCPY_CARD__")),
            )
            .join("/");
          return prefix;
        })
        .filter(Boolean);
    }),
  );
}

/** Resolve the exact framework leaf paths represented by a day decision. */
export function projectFrameworkPaths(
  project: ProjectConfig,
  shootingDate: string,
  scheduleKey?: string,
): string[] {
  if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
  const folder =
    project.projectFolderName ||
    makeProjectFolderName(project.shootingDateStart, project.name);
  const [requestedDevice, requestedPosition] = scheduleKey?.split("::") || [];
  const devices = requestedDevice ? [requestedDevice] : project.devices;
  return [
    ...new Set(
      devices.flatMap((device) => {
        const configured = normalizePositions(project.devicePositions?.[device]);
        const positions = requestedPosition
          ? [requestedPosition === "unassigned" ? undefined : requestedPosition]
          : scheduleKey && configured.length
            ? configured
            : configured.length
              ? configured
              : [undefined];
        return positions.map((position) => {
          if (!project.namingRule)
            return makeProjectDayPath(folder, shootingDate, device, position);
          const full = renderProjectCardPath(project.namingRule, {
            projectFolderName: folder,
            projectName: project.name,
            projectStartDate: project.shootingDateStart!,
            shootingDate,
            device,
            position,
            card: "__KOCPY_CARD__",
          });
          const parts = full.split("/"),
            cardIndex = parts.findIndex((part) =>
              part.includes("__KOCPY_CARD__"),
            );
          return parts.slice(0, cardIndex).join("/");
        });
      }),
    ),
  ].filter(Boolean);
}

export function projectUsesPrecreatedDirectories(project: ProjectConfig) {
  // The missing field is the legacy behaviour and must stay compatible.
  return project.directoryCreationMode !== "lazy";
}

function suppressedProjectPaths(
  project: ProjectConfig,
  destination: string,
): Set<string> {
  const root = path.resolve(destination);
  return new Set(
    (project.managedProjectDirectories || [])
      .filter(
        (record) =>
          Boolean(record.removedAt) &&
          path.resolve(record.destinationRoot) === root,
      )
      .map((record) => record.relativePath),
  );
}

function expectedPathsForDestination(
  project: ProjectConfig,
  destination: string,
): string[] {
  const suppressed = suppressedProjectPaths(project, destination);
  return expectedProjectPaths(project).filter(
    (relative) => !suppressed.has(relative),
  );
}

export async function inspectProjectStructure(
  project: ProjectConfig,
): Promise<ProjectStructureReport> {
  if (!projectUsesPrecreatedDirectories(project))
    return {
      expectedCount: 0,
      missingCount: 0,
      conflictCount: 0,
      destinations: (project.destinationPaths || []).map((destination) => ({
        destination,
        expectedCount: 0,
        existingCount: 0,
        missing: [],
        conflicts: [],
      })),
    };
  const destinations = await Promise.all(
    (project.destinationPaths || []).map(async (destination) => {
      const relatives = expectedPathsForDestination(project, destination);
      const missing: string[] = [],
        conflicts: string[] = [];
      let existingCount = 0,
        error: string | undefined;
      try {
        const root = await fs.stat(destination);
        if (!root.isDirectory()) throw new Error("备份根路径不是文件夹");
        for (const relative of relatives) {
          const fullPath = path.join(destination, relative);
          try {
            const stat = await fs.lstat(fullPath);
            if (stat.isDirectory()) existingCount++;
            else conflicts.push(fullPath);
          } catch (cause: any) {
            if (cause?.code === "ENOENT") missing.push(fullPath);
            else throw cause;
          }
        }
      } catch (cause: any) {
        error = cause?.message || String(cause);
      }
      return {
        destination,
        expectedCount: relatives.length,
        existingCount,
        missing,
        conflicts,
        error,
      };
    }),
  );
  return {
    expectedCount: destinations.reduce(
      (sum, item) => sum + item.expectedCount,
      0,
    ),
    missingCount: destinations.reduce(
      (sum, item) => sum + item.missing.length,
      0,
    ),
    conflictCount: destinations.reduce(
      (sum, item) => sum + item.conflicts.length,
      0,
    ),
    destinations,
  };
}

export async function createProjectStructure(
  project: ProjectConfig,
  reason: "explicit-precreate" | "repair" = "explicit-precreate",
  workstationId?: string,
): Promise<string[]> {
  if (!projectUsesPrecreatedDirectories(project)) return [];
  const plans = await Promise.all(
    (project.destinationPaths || []).map(async (destination) => {
      const stat = await fs.stat(destination);
      if (!stat.isDirectory()) throw new Error("备份根路径不是文件夹");
      const destinationRealPath = await fs.realpath(destination),
        identity = await volumeIdentity(destination),
        missing: Array<{ relative: string; fullPath: string }> = [];
      for (const relative of expectedPathsForDestination(project, destination)) {
        const fullPath = path.join(destination, relative);
        try {
          const existing = await fs.lstat(fullPath);
          if (!existing.isDirectory() || existing.isSymbolicLink())
            throw new Error(`项目目录路径冲突：${fullPath}`);
        } catch (cause: any) {
          if (cause?.code === "ENOENT") missing.push({ relative, fullPath });
          else throw cause;
        }
      }
      return { destination, destinationRealPath, identity, missing };
    }),
  );
  const created: string[] = [];
  project.managedProjectDirectories ||= [];
  for (const plan of plans) {
    for (const item of plan.missing) {
      await fs.mkdir(path.dirname(item.fullPath), { recursive: true });
      let createdByKocpy = false;
      try {
        // The leaf is deliberately non-recursive: EEXIST means another actor
        // won the race, so Kocpy must not claim deletion authority for it.
        await fs.mkdir(item.fullPath);
        createdByKocpy = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await fs.lstat(item.fullPath);
        if (!existing.isDirectory() || existing.isSymbolicLink())
          throw new Error(`项目目录路径冲突：${item.fullPath}`);
      }
      const realPath = await fs.realpath(item.fullPath),
        expectedRealPath = path.join(
          plan.destinationRealPath,
          ...item.relative.split("/"),
        );
      if (realPath !== expectedRealPath)
        throw new Error(`项目目录真实路径与预期不一致：${item.fullPath}`);
      if (!createdByKocpy) continue;
      created.push(item.fullPath);
      if (
        !project.managedProjectDirectories.some(
          (record) =>
            !record.removedAt &&
            path.resolve(record.destinationRoot) ===
              path.resolve(plan.destination) &&
            record.relativePath === item.relative,
        )
      )
        project.managedProjectDirectories.push({
          id: randomUUID(),
          workstationId,
          destinationRoot: plan.destination,
          destinationRealPath: plan.destinationRealPath,
          relativePath: item.relative,
          volumeId: plan.identity.id,
          volumeUuid: plan.identity.uuid,
          createdAt: Date.now(),
          reason,
        });
    }
  }
  return created;
}

/** Preflight every saved destination before creating any missing directory. */
export async function repairProjectStructure(
  project: ProjectConfig,
  workstationId?: string,
): Promise<ProjectStructureReport> {
  const before = await inspectProjectStructure(project),
    unavailable = before.destinations.filter((item) => item.error);
  if (before.conflictCount)
    throw new Error(
      `已保存项目目录存在 ${before.conflictCount} 项路径冲突，Kocpy 未创建任何目录`,
    );
  if (unavailable.length)
    throw new Error(
      `有 ${unavailable.length} 个已保存目的地无法访问，Kocpy 未创建任何目录`,
    );
  if (before.missingCount)
    await createProjectStructure(project, "repair", workstationId);
  const after = await inspectProjectStructure(project);
  if (after.missingCount || after.conflictCount)
    throw new Error("补齐后重新检查仍不完整，请检查磁盘权限和目录状态");
  return after;
}

export function formatVolumeTimestamp(value = new Date()): string {
  const part = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}${part(value.getHours())}${part(value.getMinutes())}`;
}

export function claimTimestampedVolume(
  prefix: string,
  timestamp: string,
  previousTimestamp?: string,
  previousCollision = 0,
): { label: string; collision: number } {
  const collision = previousTimestamp === timestamp ? previousCollision + 1 : 0;
  const cleanPrefix = segment(prefix);
  const separatedPrefix = cleanPrefix.endsWith("_")
    ? cleanPrefix
    : `${cleanPrefix}_`;
  return {
    label: `${separatedPrefix}${timestamp}${collision ? `_${String(collision + 1).padStart(2, "0")}` : ""}`,
    collision,
  };
}
