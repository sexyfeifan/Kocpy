import path from "node:path";
import { promises as fs } from "node:fs";
import { segment } from "./backup/safety";
import type { ProjectConfig, ProjectStructureReport } from "./types";

export function compactDate(value: string): string {
  const compact = String(value || "").replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(compact)) throw new Error("项目拍摄日期无效");
  return compact;
}

export function makeProjectFolderName(startDate: string, projectName: string): string {
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

export function makeProjectDatePath(projectFolderName: string, shootingDate: string): string {
  return path.join(segment(projectFolderName), compactDate(shootingDate));
}

export async function createProjectDateFolders(
  destinations: string[],
  projectFolderName: string,
  shootingDate: string,
): Promise<string[]> {
  const relative = makeProjectDatePath(projectFolderName, shootingDate);
  const created = destinations.map((destination) => path.join(destination, relative));
  await Promise.all(created.map((folder) => fs.mkdir(folder, { recursive: true })));
  return created;
}

export function projectShootingDates(startDate: string, endDate = startDate): string[] {
  const parse = (value: string) => {
    const compact = compactDate(value);
    return new Date(Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8))));
  };
  const start = parse(startDate), end = parse(endDate);
  if (end < start) throw new Error("项目结束日期不能早于开始日期");
  const dates: string[] = [];
  for (let value = start.getTime(); value <= end.getTime(); value += 86_400_000) {
    if (dates.length >= 1000) throw new Error("项目日期跨度超过 1000 天，请检查拍摄日期");
    dates.push(new Date(value).toISOString().slice(0, 10));
  }
  return dates;
}

export function expectedProjectPaths(project: ProjectConfig): string[] {
  if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
  const folder = project.projectFolderName || makeProjectFolderName(project.shootingDateStart, project.name);
  const devices = [...new Set(project.devices.map(segment))];
  if (!devices.length) throw new Error("请至少选择一个设备或机位");
  return projectShootingDates(project.shootingDateStart, project.shootingDateEnd || project.shootingDateStart).flatMap((date) =>
    devices.flatMap((device) => {
      const positions = [...new Set(project.devicePositions?.[device] || [])].filter((value) => /^[A-E]$/.test(value));
      return positions.length ? positions.map((position) => makeProjectDayPath(folder, date, device, position)) : [makeProjectDayPath(folder, date, device)];
    }),
  );
}

export async function inspectProjectStructure(project: ProjectConfig): Promise<ProjectStructureReport> {
  const relatives = expectedProjectPaths(project);
  const destinations = await Promise.all((project.destinationPaths || []).map(async (destination) => {
    const missing: string[] = [], conflicts: string[] = [];
    let existingCount = 0, error: string | undefined;
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
    return { destination, expectedCount: relatives.length, existingCount, missing, conflicts, error };
  }));
  return {
    expectedCount: relatives.length * destinations.length,
    missingCount: destinations.reduce((sum, item) => sum + item.missing.length, 0),
    conflictCount: destinations.reduce((sum, item) => sum + item.conflicts.length, 0),
    destinations,
  };
}

export async function createProjectStructure(project: ProjectConfig): Promise<string[]> {
  const relatives = expectedProjectPaths(project);
  const paths = (project.destinationPaths || []).flatMap((destination) => relatives.map((relative) => path.join(destination, relative)));
  for (const folder of paths) await fs.mkdir(folder, { recursive: true });
  return paths;
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
  const separatedPrefix = cleanPrefix.endsWith("_") ? cleanPrefix : `${cleanPrefix}_`;
  return {
    label: `${separatedPrefix}${timestamp}${collision ? `_${String(collision + 1).padStart(2, "0")}` : ""}`,
    collision,
  };
}
