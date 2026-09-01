import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { HashAlgorithm } from "./types";
import { hashFile } from "./backup/BackupEngine";

export type ArchiveRepairFault =
  | "after-copy"
  | "after-preserve"
  | "after-publish";

async function durableSync(file: string) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
  } finally {
    await directory.close();
  }
}

export async function repairArchiveFile(input: {
  sourcePath: string;
  targetPath: string;
  expectedChecksum: string;
  hashAlgorithm: HashAlgorithm;
  onPreserved?: (path: string) => Promise<void> | void;
  onPublished?: (checksum: string) => Promise<void> | void;
  /** Test-only deterministic failure point; production callers omit it. */
  failAt?: ArchiveRepairFault;
}) {
  const sourceChecksum = await hashFile(input.sourcePath, input.hashAlgorithm);
  if (sourceChecksum !== input.expectedChecksum)
    throw new Error("健康副本哈希与权威基线不同，停止修复");

  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  const partial = `${input.targetPath}.kocpy-repair-${randomUUID()}.partial`;
  let preservedPath: string | undefined;
  try {
    await fs.copyFile(input.sourcePath, partial, fsConstants.COPYFILE_EXCL);
    const metadata = await fs.stat(input.sourcePath);
    await fs.chmod(partial, metadata.mode);
    await fs.utimes(partial, metadata.atime, metadata.mtime);
    await durableSync(partial);
    if (input.failAt === "after-copy") throw new Error("注入故障：复制后");
    if ((await hashFile(partial, input.hashAlgorithm)) !== input.expectedChecksum)
      throw new Error("修复临时副本完整回读校验失败");

    const targetExists = await fs.access(input.targetPath).then(
      () => true,
      () => false,
    );
    if (targetExists) {
      preservedPath = `${input.targetPath}.kocpy-damaged-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await fs.rename(input.targetPath, preservedPath);
      await durableSync(preservedPath);
      await input.onPreserved?.(preservedPath);
    }
    if (input.failAt === "after-preserve")
      throw new Error("注入故障：保留损坏原件后");

    await fs.rename(partial, input.targetPath);
    await durableSync(input.targetPath);
    if (input.failAt === "after-publish")
      throw new Error("注入故障：发布后");
    const publishedChecksum = await hashFile(
      input.targetPath,
      input.hashAlgorithm,
    );
    if (publishedChecksum !== input.expectedChecksum)
      throw new Error("修复文件发布后完整回读校验失败");
    await input.onPublished?.(publishedChecksum);
    return { sourceChecksum, publishedChecksum, preservedPath };
  } finally {
    await fs.unlink(partial).catch(() => undefined);
  }
}
