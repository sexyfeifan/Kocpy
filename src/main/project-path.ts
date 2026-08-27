import path from "node:path";
import { segment } from "./backup/safety";

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
): string {
  return path.join(segment(projectFolderName), compactDate(shootingDate), segment(device));
}
