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
