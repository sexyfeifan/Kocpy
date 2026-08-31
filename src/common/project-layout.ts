export type ProjectPathValues = {
  projectFolderName: string;
  projectName: string;
  projectStartDate: string;
  shootingDate: string;
  device: string;
  position?: string;
  card: string;
};
const segment = (value: string) => {
  const result = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100);
  if (!result || result === "." || result === "..")
    throw new Error("目录名称无效");
  return result;
};
const date = (value: string) => {
  const result = value.replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(result)) throw new Error("项目拍摄日期无效");
  return result;
};
/** Shared by the renderer and the filesystem writer; never maintains a second preview tree. */
export function renderProjectCardPath(
  rule: string | undefined,
  v: ProjectPathValues,
): string {
  if (!rule)
    return [
      segment(v.projectFolderName),
      date(v.shootingDate),
      segment(v.device),
      v.position && segment(v.position),
      segment(v.card),
    ]
      .filter(Boolean)
      .join("/");
  const tokens: Record<string, string> = {
    date: date(v.projectStartDate),
    project: segment(v.projectName),
    shootingDate: date(v.shootingDate),
    device: segment(v.device),
    position: v.position ? segment(v.position) : "",
    card: segment(v.card),
  };
  const unknown = [...rule.matchAll(/\{([^}]+)\}/g)]
    .map((item) => item[1])
    .filter((key) => !(key in tokens));
  if (unknown.length)
    throw new Error(`项目命名规则包含未知变量：${unknown.join("、")}`);
  const parts = rule
    .replace(/\{([^}]+)\}/g, (_, key) => tokens[key] || "")
    .split(/[\\/]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(segment);
  if (!parts.length) throw new Error("项目命名规则不能生成空路径");
  if (!rule.includes("{card}")) parts.push(segment(v.card));
  return parts.join("/");
}

export function previewProjectPath(
  rule: string | undefined,
  values: ProjectPathValues,
) {
  try {
    return renderProjectCardPath(rule, values);
  } catch (error) {
    return `规则待修正：${String(error).replace(/^Error: /, "")}`;
  }
}
