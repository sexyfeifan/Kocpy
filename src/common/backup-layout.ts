/** New mirrors keep the selected folder itself. Legacy tasks explicitly retain contents layout. */
export type MirrorLayout = "source-folder" | "contents";

export function sourceFolderName(sourcePath: string): string {
  const name = sourcePath.replace(/\/+$/, "").split("/").pop() || "";
  if (!name || name === "." || name === ".." || name.includes("\0"))
    throw new Error("请选择具体的素材文件夹或磁盘，不支持文件系统根目录");
  return name;
}

export function normalBackupFolder(
  sourcePath: string,
  timestamp: string,
): string {
  const name = sourceFolderName(sourcePath)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100);
  if (!name || name === "." || name === "..")
    throw new Error("素材文件夹名称无效");
  return `${name}_${timestamp}`;
}

export function previewBackupPath(
  destination: string,
  source: string,
  mirror: boolean,
): string {
  return `${destination.replace(/\/+$/, "")}/${mirror ? sourceFolderName(source) : normalBackupFolder(source, "[开始时的时间戳]")}`;
}

/** Missing/invalid capacity is unknown, not a passed preflight. */
export function capacityReadiness(
  destinations: string[],
  freeByPath: Record<string, number>,
  required: number,
) {
  const checked = destinations.filter(
    (location) =>
      Number.isFinite(freeByPath[location]) && freeByPath[location] >= required,
  ).length;
  return {
    checked,
    total: destinations.length,
    ready: destinations.length > 0 && checked === destinations.length,
  };
}
