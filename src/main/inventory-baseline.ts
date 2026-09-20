import { promises as fs } from "node:fs";
import path from "node:path";
import type { BackupTask, InventoryScopeSnapshot } from "./types";
import { inside, safeChild } from "./backup/safety";

const sha256 = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

const recordedChecksum = (task: BackupTask, value: unknown) => {
  if (typeof value !== "string") return false;
  if (task.hashAlgorithm === "sha256") return /^[a-f0-9]{64}$/i.test(value);
  if (task.hashAlgorithm === "sha1") return /^[a-f0-9]{40}$/i.test(value);
  if (task.hashAlgorithm === "md5") return /^[a-f0-9]{32}$/i.test(value);
  return (
    /^\d{1,10}$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 0xffff_ffff
  );
};

const safeRelativeDirectory = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !path.isAbsolute(value) &&
  !value.includes("\0") &&
  !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..");

const safeRelativeFilePath = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !path.isAbsolute(value) &&
  !value.includes("\0") &&
  value !== "." &&
  path.posix.normalize(value) === value &&
  !value.split("/").some((part) => !part || part === "." || part === "..");

const strictAbsolutePath = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8192 &&
  !value.includes("\0") &&
  path.isAbsolute(value) &&
  path.resolve(value) === value;

const insidePath = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
};

/**
 * Validate the immutable path identity and indexed destination matrix used by
 * every persisted task. An empty destination path remains a valid checkpoint
 * placeholder only while it is explicitly unverified; this preserves recovery
 * compatibility without allowing it to masquerade as backup evidence.
 */
export function validateFileRecordMatrix(task: BackupTask): void {
  if (!Array.isArray(task.fileRecords) || !Array.isArray(task.destinations))
    throw new Error(`${task.name} 的文件记录或目的地矩阵无效`);

  const relativePaths = new Set<string>(),
    normalizedPaths = new Set<string>();
  for (const record of task.fileRecords) {
    if (
      !record ||
      !safeRelativeFilePath(record.relativePath) ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      record.name.length > 4096 ||
      record.name !== path.posix.basename(record.relativePath) ||
      relativePaths.has(record.relativePath) ||
      normalizedPaths.has(record.relativePath.normalize("NFC")) ||
      !Array.isArray(record.destinations) ||
      record.destinations.length !== task.destinations.length
    )
      throw new Error(`${task.name} 的文件记录或目的地矩阵无效`);
    relativePaths.add(record.relativePath);
    normalizedPaths.add(record.relativePath.normalize("NFC"));

    for (let index = 0; index < record.destinations.length; index++) {
      const result = record.destinations[index],
        destination = task.destinations[index];
      if (
        !result ||
        typeof result.checksum !== "string" ||
        typeof result.verified !== "boolean" ||
        (result.unchanged !== undefined &&
          typeof result.unchanged !== "boolean") ||
        !destination
      )
        throw new Error(`${task.name} 的文件记录或目的地矩阵无效`);

      if (result.path === "") {
        if (result.verified || result.checksum !== "" || result.unchanged)
          throw new Error(`${task.name} 的文件记录或目的地矩阵无效`);
        continue;
      }
      const root = destination.resolvedPath || destination.path;
      if (
        !strictAbsolutePath(root) ||
        !strictAbsolutePath(result.path) ||
        !insidePath(result.path, root)
      )
        throw new Error(`${task.name} 的文件记录或目的地矩阵无效`);
    }
  }
}

/**
 * Confirms that a task has enough immutable inventory evidence for a complete
 * reread. Legacy tasks require at least one file; complete-v2 can also prove an
 * empty root or a directory-only payload because directories are first-class.
 */
export function recordedInventoryBaseline(
  task: BackupTask,
): InventoryScopeSnapshot | undefined {
  validateFileRecordMatrix(task);
  if (
    !Number.isSafeInteger(task.totalFiles) ||
    task.totalFiles < 0 ||
    !Number.isSafeInteger(task.totalBytes) ||
    task.totalBytes < 0 ||
    task.fileRecords.length !== task.totalFiles ||
    task.fileRecords.some(
      (record) =>
        !recordedChecksum(task, record.srcChecksum) ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0,
    ) ||
    task.fileRecords.reduce((sum, record) => sum + record.size, 0) !==
      task.totalBytes
  )
    throw new Error(
      `${task.name} 尚无完整文件哈希基线，不能建立长期复校验证据`,
    );

  const policy = task.inventoryPolicy,
    scope = task.inventoryScope;
  if (!policy && !scope) {
    if (task.totalFiles > 0) return undefined;
    throw new Error(
      `${task.name} 尚无完整文件哈希基线，不能建立长期复校验证据`,
    );
  }
  const directoryPaths = new Set(scope?.includedDirectoryPaths || []),
    requiredParents = [
      ...task.fileRecords.map((record) => record.relativePath),
      ...(scope?.includedDirectoryPaths || []),
    ].flatMap((relativePath) => {
      const parts = relativePath.split(/[\\/]/),
        parents: string[] = [];
      for (let index = 1; index < parts.length; index++)
        parents.push(parts.slice(0, index).join(path.sep));
      return parents;
    });
  if (
    policy?.version !== "complete-v2" ||
    scope?.policy?.version !== "complete-v2" ||
    JSON.stringify(scope.policy) !== JSON.stringify(policy) ||
    !sha256(scope.fingerprint) ||
    scope.includedFiles !== task.totalFiles ||
    scope.includedBytes !== task.totalBytes ||
    !Number.isSafeInteger(scope.includedDirectories) ||
    scope.includedDirectories < 0 ||
    !Array.isArray(scope.includedDirectoryPaths) ||
    scope.includedDirectories !== scope.includedDirectoryPaths.length ||
    new Set(scope.includedDirectoryPaths).size !==
      scope.includedDirectoryPaths.length ||
    scope.includedDirectoryPaths.some(
      (relativePath) => !safeRelativeDirectory(relativePath),
    ) ||
    requiredParents.some((relativePath) => !directoryPaths.has(relativePath))
  )
    throw new Error(
      `${task.name} 的完整文件范围快照无效，不能建立长期复校验证据`,
    );
  return scope;
}

export interface RecordedDirectoryIssue {
  relativePath: string;
  message: string;
}

/** Read-only verification of the directory portion of a frozen inventory. */
export async function inspectRecordedDirectoryScope(
  task: BackupTask,
  root: string,
): Promise<{ checked: number; issues: RecordedDirectoryIssue[] }> {
  const scope = recordedInventoryBaseline(task),
    issues: RecordedDirectoryIssue[] = [];
  if (!scope) return { checked: 0, issues };

  const inspect = async (target: string, relativePath: string) => {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("不是实际目录");
    } catch (error) {
      issues.push({
        relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await inspect(root, ".");
  if (issues.length) return { checked: 1, issues };
  const canonicalRoot = await fs.realpath(root);
  for (const relativePath of scope.includedDirectoryPaths) {
    try {
      await inspect(
        await safeChild(canonicalRoot, relativePath),
        relativePath,
      );
    } catch (error) {
      issues.push({
        relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    checked: scope.includedDirectoryPaths.length + 1,
    issues,
  };
}

export async function assertRecordedDirectoryScope(
  task: BackupTask,
  root: string,
) {
  const result = await inspectRecordedDirectoryScope(task, root);
  if (result.issues.length) {
    const issue = result.issues[0];
    throw new Error(
      `${issue.relativePath}: 目录结构校验失败：${issue.message}`,
    );
  }
  return result;
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Recreate only missing directories authorized by the frozen inventory.
 * Existing files, links and non-directory entries are never replaced.
 * Re-running after interruption is intentionally idempotent.
 */
export async function repairRecordedDirectoryScope(
  task: BackupTask,
  healthyRoot: string,
  targetRoot: string,
) {
  const scope = recordedInventoryBaseline(task);
  if (!scope) return { created: [] as string[] };
  await assertRecordedDirectoryScope(task, healthyRoot);

  const rootStat = await fs.lstat(targetRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("归档修复目标不是实际目录");
  const canonicalRoot = await fs.realpath(targetRoot),
    created: string[] = [];
  for (const relativePath of scope.includedDirectoryPaths) {
    let current = canonicalRoot;
    const parts = relativePath.split(/[\\/]/);
    for (let index = 0; index < parts.length; index++) {
      const candidate = path.join(current, parts[index]);
      if (!inside(candidate, canonicalRoot))
        throw new Error(`${relativePath}: 目录路径越出归档目标`);
      const stat = await fs.lstat(candidate).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error(
            `${relativePath}: 现有条目不是实际目录，Kocpy 未覆盖`,
          );
      } else {
        await fs.mkdir(candidate, { recursive: false, mode: 0o755 });
        await syncDirectory(current);
        const createdRelative = parts.slice(0, index + 1).join(path.sep);
        if (!created.includes(createdRelative)) created.push(createdRelative);
      }
      const resolved = await fs.realpath(candidate);
      if (!inside(resolved, canonicalRoot))
        throw new Error(`${relativePath}: 目录通过别名指向归档目标之外`);
      current = resolved;
    }
  }
  await assertRecordedDirectoryScope(task, canonicalRoot);
  return { created };
}
