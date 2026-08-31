export type ArchiveScope = {
  kind: "project" | "day" | "card" | "file" | "disk";
  projectId?: string;
  shootingDate?: string;
  taskId?: string;
  relativePath?: string;
  volumePath?: string;
};

export function validateArchiveScope(scope: ArchiveScope) {
  if (
    !scope ||
    !["project", "day", "card", "file", "disk"].includes(scope.kind)
  )
    throw new Error("请选择明确的复校验范围");
  if (scope.kind === "disk") {
    if (!scope.volumePath?.startsWith("/")) throw new Error("请选择归档盘目录");
  } else if (!scope.projectId) throw new Error("请选择项目");
  if (["card", "file"].includes(scope.kind) && !scope.taskId)
    throw new Error("请选择具体素材卷，未选择时不会扩大为整个项目");
  if (scope.kind === "file" && !scope.relativePath?.trim())
    throw new Error("请选择具体文件");
  if (
    scope.kind === "day" &&
    !/^\d{4}-\d{2}-\d{2}$/.test(scope.shootingDate || "")
  )
    throw new Error("请选择拍摄日期");
  if (
    scope.relativePath &&
    (scope.relativePath.startsWith("/") ||
      scope.relativePath.split(/[\\/]/).includes(".."))
  )
    throw new Error("文件必须是素材卷内的相对路径");
  return {
    kind: scope.kind,
    projectId: scope.kind === "disk" ? undefined : scope.projectId,
    shootingDate: scope.kind === "day" ? scope.shootingDate : undefined,
    taskId: ["card", "file"].includes(scope.kind) ? scope.taskId : undefined,
    relativePath: scope.kind === "file" ? scope.relativePath : undefined,
    volumePath: scope.kind === "disk" ? scope.volumePath : undefined,
  };
}

export function normalizePositions(values: string[] = []): string[] {
  const result = [
    ...new Set(
      values
        .map((value) => String(value).trim().normalize("NFC"))
        .filter(Boolean),
    ),
  ];
  if (result.length > 5) throw new Error("每个设备最多设置 5 个机位");
  if (
    result.some(
      (value) =>
        value.length > 40 ||
        /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
        value === "." ||
        value === "..",
    )
  )
    throw new Error("机位名称不能含路径分隔符或特殊路径字符，最长 40 字符");
  return result;
}

export function readableOperationError(error: unknown): string {
  return String(error)
    .replace(/^Error:\s*/, "")
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

/** A cancelled native dialog is not a successful operation. */
export function didComplete(value: unknown): boolean {
  return value !== null && value !== false;
}

export type BatchEntry = {
  sourcePath: string;
  taskId?: string;
  started?: boolean;
  claim?: { label: string };
  requestId: string;
};
export async function submitBatch<T extends { id: string }>(
  entries: BatchEntry[],
  create: (entry: BatchEntry) => Promise<T>,
  start: (id: string) => Promise<unknown>,
  changed: () => void,
) {
  for (const entry of entries) {
    if (entry.started) continue;
    if (!entry.taskId) {
      entry.taskId = (await create(entry)).id;
      changed();
    }
    await start(entry.taskId);
    entry.started = true;
    changed();
  }
}

export function validateChecklist(
  items: Array<{ id: string; required?: boolean }>,
  completed: string[],
  operator: string,
) {
  if (!operator.trim()) throw new Error("请填写实际签署人");
  const valid = new Set(items.map((item) => item.id));
  const result = [...new Set(completed)].filter((id) => valid.has(id));
  if (!items.length) throw new Error("此阶段没有检查项，请先配置检查表");
  if (items.some((item) => item.required && !result.includes(item.id)))
    throw new Error("必填检查项尚未逐项确认，不能签署完成");
  return result;
}
