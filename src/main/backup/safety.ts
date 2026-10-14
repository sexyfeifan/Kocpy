import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SYSTEM_SOURCE_DIRECTORIES } from "../../common/source-scan";
import type {
  InventoryExcludedEntry,
  InventoryPolicySnapshot,
  InventoryScopeSnapshot,
} from "../types";
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
  ctimeMs: number;
  atimeMs: number;
  mode: number;
}
export interface SourceDirectory {
  relativePath: string;
  mtimeMs: number;
  ctimeMs: number;
  atimeMs: number;
  mode: number;
}

export function completeInventoryPolicy(
  includeHidden = true,
  createdAt = Date.now(),
): InventoryPolicySnapshot {
  return {
    version: "complete-v2",
    mode: includeHidden ? "complete" : "filtered",
    createdAt,
    includeHidden,
    includeAppleDouble: includeHidden,
    includeSystemMetadata: includeHidden,
    includeEmptyDirectories: true,
    symlinkPolicy: "fail",
    specialFilePolicy: "fail",
    sourceReadPolicy: "skip-system-and-permission-errors",
  };
}

const legacyExcluded = (name: string, includeHidden: boolean) =>
  [".DS_Store", ".Spotlight-V100", ".Trashes", ".fseventsd"].includes(name) ||
  name.startsWith("._") ||
  (!includeHidden && name.startsWith("."));

const readableError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const permissionCode = (error: unknown): "EPERM" | "EACCES" | undefined => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES" ? code : undefined;
};

export async function scan(
  source: string,
  policyOrIncludeHidden: InventoryPolicySnapshot | boolean = true,
  signal?: AbortSignal,
) {
  const files: SourceFile[] = [];
  const directories: string[] = [];
  const directoryMetadata: SourceDirectory[] = [];
  const exclusions: InventoryExcludedEntry[] = [];
  const policy =
    typeof policyOrIncludeHidden === "boolean"
      ? undefined
      : structuredClone(policyOrIncludeHidden);
  const includeHidden =
    typeof policyOrIncludeHidden === "boolean"
      ? policyOrIncludeHidden
      : policyOrIncludeHidden.includeHidden;
  const sourceStat = await fs.lstat(source).catch((error) => {
    throw new Error(`无法读取素材源：${readableError(error)}`);
  });
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    throw new Error("素材源必须是实际目录");
  const toleratePermissions =
    policy?.sourceReadPolicy === "skip-system-and-permission-errors";
  let skipped = 0;
  function exclude(
    relativePath: string,
    kind: InventoryExcludedEntry["kind"],
    reason: InventoryExcludedEntry["reason"],
    stat?: Stats,
    code?: "EPERM" | "EACCES",
  ) {
    const item: InventoryExcludedEntry = {
      relativePath,
      kind,
      bytes: kind === "file" && stat ? stat.size : 0,
      modifiedAt: stat?.mtimeMs || 0,
      reason,
      ...(kind === "directory" || !stat ? { bytesUnknown: true } : {}),
      ...(code ? { permissionCode: code } : {}),
    };
    exclusions.push(item);
    skipped++;
    return item;
  }
  async function walk(
    dir: string,
    inheritedExclusion?: InventoryExcludedEntry["reason"],
    excludedDirectory?: InventoryExcludedEntry,
    directoryStat?: Stats,
  ) {
    signal?.throwIfAborted();
    let entries: import("node:fs").Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
        (left, right) => left.name.localeCompare(right.name),
      );
    } catch (error) {
      signal?.throwIfAborted();
      const relativePath = path.relative(source, dir) || ".";
      const code = permissionCode(error);
      if (toleratePermissions && dir !== source && code) {
        if (excludedDirectory) {
          excludedDirectory.reason = "permission-denied";
          excludedDirectory.bytesUnknown = true;
          excludedDirectory.permissionCode = code;
        } else {
          exclude(
            relativePath,
            "directory",
            "permission-denied",
            directoryStat,
            code,
          );
        }
        return false;
      }
      throw new Error(
        `无法读取素材目录：${relativePath}：${readableError(error)}`,
      );
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!policy && legacyExcluded(entry.name, includeHidden)) {
        skipped++;
        continue;
      }
      const abs = path.join(dir, entry.name),
        rel = path.relative(source, abs);
      if (toleratePermissions) {
        // Do not turn symlinks or special entries into permission exemptions.
        if (entry.isSymbolicLink())
          throw new Error(`不跟随素材中的符号链接，请移除或选择实际目录：${rel}`);
        if (!entry.isDirectory() && !entry.isFile())
          throw new Error(`不支持的特殊文件：${rel}`);
        if (entry.isDirectory() && SYSTEM_SOURCE_DIRECTORIES.has(entry.name)) {
          exclude(rel, "directory", "system-directory");
          continue;
        }
      }
      let st: Stats;
      try {
        st = await fs.lstat(abs);
      } catch (error) {
        signal?.throwIfAborted();
        const code = permissionCode(error);
        if (toleratePermissions && code) {
          exclude(
            rel,
            entry.isDirectory() ? "directory" : "file",
            "permission-denied",
            undefined,
            code,
          );
          continue;
        }
        throw new Error(`无法读取素材条目：${rel}：${readableError(error)}`);
      }
      if (st.isSymbolicLink())
        throw new Error(`不跟随素材中的符号链接，请移除或选择实际目录：${rel}`);
      if (!st.isDirectory() && !st.isFile())
        throw new Error(`不支持的特殊文件：${rel}`);
      const exclusion =
        inheritedExclusion ||
        (policy?.mode === "filtered" && entry.name.startsWith(".")
          ? "hidden-by-user-filter"
          : undefined);
      if (exclusion) {
        const item: InventoryExcludedEntry = {
          relativePath: rel,
          kind: st.isDirectory() ? "directory" : "file",
          bytes: st.isFile() ? st.size : 0,
          modifiedAt: st.mtimeMs,
          reason: exclusion,
        };
        exclusions.push(item);
        skipped++;
        if (st.isDirectory()) await walk(abs, exclusion, item, st);
        continue;
      }
      if (st.isDirectory()) {
        directories.push(rel);
        directoryMetadata.push({
          relativePath: rel,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          atimeMs: st.atimeMs,
          mode: st.mode,
        });
        if (!(await walk(abs, undefined, undefined, st))) {
          directories.pop();
          directoryMetadata.pop();
        }
      } else if (st.isFile()) {
        files.push({
          name: entry.name,
          relativePath: rel,
          absolutePath: abs,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ctimeMs: st.ctimeMs,
          atimeMs: st.atimeMs,
          mode: st.mode,
        });
      }
    }
    return true;
  }
  await walk(source);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        root: [sourceStat.mtimeMs, sourceStat.ctimeMs, sourceStat.mode],
        files: files.map((file) => [
          file.relativePath,
          file.size,
          file.mtimeMs,
          file.ctimeMs,
        ]),
        directories: directoryMetadata.map((directory) => [
          directory.relativePath,
          directory.mtimeMs,
          directory.ctimeMs,
          directory.mode,
        ]),
        exclusions: exclusions.map((item) => [
          item.relativePath,
          item.kind,
          item.bytes,
          item.modifiedAt,
          item.reason,
          ...(toleratePermissions
            ? [item.bytesUnknown || false, item.permissionCode || null]
            : []),
        ]),
      }),
    )
    .digest("hex");
  const scope: InventoryScopeSnapshot | undefined = policy
    ? {
        policy,
        capturedAt: Date.now(),
        sourcePath: source,
        fingerprint,
        includedFiles: files.length,
        includedBytes: totalBytes,
        includedDirectories: directories.length,
        includedDirectoryPaths: [...directories],
        excludedFiles: exclusions.filter((item) => item.kind === "file").length,
        excludedDirectories: exclusions.filter(
          (item) => item.kind === "directory",
        ).length,
        excludedBytes: exclusions.reduce((sum, item) => sum + item.bytes, 0),
        exclusions,
      }
    : undefined;
  return {
    files,
    directories,
    directoryMetadata,
    skipped,
    skippedBytes: exclusions.reduce((sum, item) => sum + item.bytes, 0),
    exclusions,
    scope,
    totalBytes,
  };
}
