import { promises as fs } from "node:fs";
import path from "node:path";
export const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + path.sep);
export function segment(value: string): string {
  const result = value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100);
  if (!result || result === "." || result === "..")
    throw new Error("名称不能为空或为相对路径");
  return result;
}
export async function canonical(input: string): Promise<string> {
  if (!path.isAbsolute(input) || input.includes("\0"))
    throw new Error("请选择绝对路径");
  try {
    return await fs.realpath(input);
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    const parent = path.dirname(input);
    if (parent === input) throw e;
    return path.join(await canonical(parent), path.basename(input));
  }
}
export async function validatePaths(source: string, destinations: string[]) {
  if (destinations.length < 1 || destinations.length > 4)
    throw new Error("请选择 1–4 个备份目的地");
  const src = await canonical(source);
  if (!(await fs.stat(src)).isDirectory())
    throw new Error("素材源必须是文件夹");
  const dests = await Promise.all(destinations.map(canonical));
  for (const [i, dest] of dests.entries()) {
    if (inside(dest, src) || inside(src, dest))
      throw new Error("素材源与目的地不能相同或互相包含");
    for (const prior of dests.slice(0, i))
      if (inside(dest, prior) || inside(prior, dest))
        throw new Error("目的地不能重复或互相包含");
  }
  return { src, dests };
}
export async function safeChild(
  root: string,
  relative: string,
): Promise<string> {
  const file = path.resolve(root, relative);
  if (!inside(file, root)) throw new Error("文件路径越出目的地");
  const resolved = await canonical(file);
  if (!inside(resolved, root))
    throw new Error("目的地包含指向外部的符号链接，已停止写入");
  return file;
}
export interface SourceFile {
  name: string;
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}
export async function scan(
  source: string,
  includeHidden = true,
  signal?: AbortSignal,
) {
  const files: SourceFile[] = [];
  const directories: string[] = [];
  let skipped = 0;
  async function walk(dir: string) {
    signal?.throwIfAborted();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (
        [".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd"].includes(
          entry.name,
        ) ||
        entry.name.startsWith("._") ||
        (!includeHidden && entry.name.startsWith("."))
      ) {
        skipped++;
        continue;
      }
      const abs = path.join(dir, entry.name),
        rel = path.relative(source, abs);
      if (entry.isSymbolicLink())
        throw new Error(`不跟随素材中的符号链接，请移除或选择实际目录：${rel}`);
      if (entry.isDirectory()) {
        directories.push(rel);
        await walk(abs);
      } else if (entry.isFile()) {
        const st = await fs.stat(abs);
        files.push({
          name: entry.name,
          relativePath: rel,
          absolutePath: abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } else throw new Error(`不支持的特殊文件：${rel}`);
    }
  }
  await walk(source);
  return {
    files,
    directories,
    skipped,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
}
