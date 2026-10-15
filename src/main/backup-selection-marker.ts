import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BackupTask, Destination } from "./types";
import type { VolumeIdentity } from "../common/volume-identity";
import { compareVolumeIdentity } from "../common/volume-identity";
import { assertBackupSelectionStructure } from "./backup-selection";
import { inside, safeChild } from "./backup/safety";

export interface BackupSelectionMarkerDependencies {
  identifyVolume: (absolutePath: string) => Promise<VolumeIdentity>;
  beforeRead?: () => Promise<void>;
  signal?: AbortSignal;
}

const reportName = "Kocpy报告", markerPrefix = "选定范围_";
const markerKind = "kocpy-selected-backup-scope";
const noFollow = constants.O_NOFOLLOW;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sameNode = (left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">) => left.dev === right.dev && left.ino === right.ino;
const sameFile = (left: Stats, right: Stats) => sameNode(left, right) && left.size === right.size &&
  left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function directoryBinding(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory)
    throw new Error("范围声明目录不是稳定的真实目录，已停止");
  return stat;
}

function markerContents(task: BackupTask, destination: Destination) {
  const plan = task.selection;
  if (!plan) return;
  assertBackupSelectionStructure(plan);
  if (!plan.excludedFiles.length) return;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(task.id)) throw new Error("范围声明任务编号无效");
  if (task.sourcePath !== plan.sourcePath || task.projectId !== plan.projectId)
    throw new Error("范围声明与任务素材源或项目不一致");
  if (!task.destinations.some((target) => target.id === destination.id && target === destination))
    throw new Error("范围声明目的地不属于当前任务");
  const included = new Set(plan.includedPaths);
  // This declaration is intentionally identical before and after copying. It is
  // a scope warning, NOT a completion receipt, authenticity signature or proof
  // that every declared file is present. File paths refer to the frozen source;
  // concrete destination mappings remain in the task's verification manifest.
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: markerKind, taskId: task.id, selectionDigest: plan.digest,
    wholeCardCovered: false, verificationClaim: "none", pathBasis: "source-relative",
    checksumBasis: "expected-frozen-source-sha256", confirmedAt: plan.confirmedAt,
    selectedDates: plan.selectedDates,
    notice: "本目录来自用户确认的选定范围备份，不是完整源卡副本。此声明不证明复制完成或数据真实性；实际完成状态、目的地文件映射和逐文件校验结果请查看对应任务记录或校验报告。",
    originalManifestMeaning: "随素材保留的原始 MHL/SHA 清单属于历史全卡证据，不可据此将本次明确未选范围误判为复制丢失，亦不可自动改写原始清单。请在原工作站导出工作站包，并通过项目模板与交接预检并合并原任务记录。",
    includedFiles: plan.sourceFiles.filter((file) => included.has(file.relativePath)).map((file) =>
      ({ relativePath: file.relativePath, size: file.size, sha256: file.sha256 })),
    excludedFiles: plan.excludedFiles.map((file) => ({ relativePath: file.relativePath, reason: file.reason, groupId: file.groupId })),
  }, null, 2) + "\n");
}

async function publishScope(task: BackupTask, destination: Destination, deps: BackupSelectionMarkerDependencies) {
  const contents = markerContents(task, destination);
  if (!contents) return;
  const root = destination.resolvedPath;
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0"))
    throw new Error("范围声明缺少已预检的目的地目录");
  if (inside(root, task.sourcePath) || inside(task.sourcePath, root))
    throw new Error("范围声明不能写入素材源或其父目录");
  const rootBinding = await directoryBinding(root);
  if (sameNode(rootBinding, task.selection!.sourceRootBinding))
    throw new Error("范围声明目的地与素材源共用同一目录身份，已停止");
  const checkRoot = async () => {
    deps.signal?.throwIfAborted(); await deps.beforeRead?.(); deps.signal?.throwIfAborted();
    if (!sameNode(rootBinding, await directoryBinding(root))) throw new Error("范围声明目的地目录已改变");
    const identity = await deps.identifyVolume(root);
    const match = compareVolumeIdentity(destination.volumeUuid, destination.volumeId, identity);
    if (match !== "match" && match !== "legacy-match") throw new Error("范围声明目的地磁盘身份无法确认或已改变，已停止");
    if (!sameNode(rootBinding, await directoryBinding(root))) throw new Error("范围声明目的地目录已改变");
  };
  await checkRoot();
  const reportDirectory = await safeChild(root, reportName);
  try { await fs.mkdir(reportDirectory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await checkRoot();
  const reportBinding = await directoryBinding(reportDirectory);
  const check = async () => {
    await checkRoot();
    if (!sameNode(reportBinding, await directoryBinding(reportDirectory))) throw new Error("范围声明报告目录已改变");
  };
  const outputPath = await safeChild(root, `${reportName}/${markerPrefix}${task.id}.json`);
  const expectedSha256 = hash(contents);
  const readExisting = async () => {
    await check();
    let handle;
    try { handle = await fs.open(outputPath, constants.O_RDONLY | noFollow); }
    catch (error) { if (missing(error)) return false; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== contents.length) throw new Error("已有范围声明不一致，拒绝覆盖");
      const current = await handle.readFile(), after = await handle.stat();
      await check();
      const atPath = await fs.lstat(outputPath);
      if (!sameFile(before, after) || !sameFile(after, atPath) || atPath.isSymbolicLink() || hash(current) !== expectedSha256)
        throw new Error("已有范围声明已变化或内容不一致，拒绝覆盖");
      return true;
    } finally { await handle.close(); }
  };
  if (await readExisting()) return { path: outputPath, sha256: expectedSha256, reused: true };
  const temporary = await safeChild(root, `${reportName}/.${markerPrefix}${task.id}.${randomUUID()}.partial`);
  let temporaryBinding: Stats | undefined;
  try {
    await check();
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
    try {
      temporaryBinding = await handle.stat(); await handle.writeFile(contents); await handle.sync();
    } finally { await handle.close(); }
    await check();
    const staged = await fs.lstat(temporary);
    if (!sameNode(temporaryBinding, staged) || !staged.isFile() || staged.isSymbolicLink()) throw new Error("范围声明暂存文件已改变");
    try { await fs.link(temporary, outputPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (await readExisting()) return { path: outputPath, sha256: expectedSha256, reused: true };
        throw error;
      }
      if (!["EPERM", "EACCES", "EXDEV", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      // exFAT/SMB may not support hardlinks. Exclusive NOFOLLOW creation never
      // replaces a path or follows a substituted staging symlink. Publish the
      // already frozen in-memory bytes; a torn fallback remains a blocking
      // invalid marker rather than being silently removed or treated as full.
      await check();
      const published = await fs.open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o644);
      try { await published.writeFile(contents); await published.sync(); } finally { await published.close(); }
    }
    await check();
    const directory = await fs.open(reportDirectory, constants.O_RDONLY | constants.O_DIRECTORY | noFollow);
    try {
      if (!sameNode(reportBinding, await directory.stat())) throw new Error("范围声明报告目录已改变");
      try { await directory.sync(); } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EBADF"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
      }
    } finally { await directory.close(); }
    if (!await readExisting()) throw new Error("范围声明发布后无法回读，不能完成备份");
    return { path: outputPath, sha256: expectedSha256, reused: false };
  } finally {
    // Clean only our own staging inode, never a user replacement or swapped dir.
    try {
      if (temporaryBinding && sameNode(rootBinding, await directoryBinding(root)) && sameNode(reportBinding, await directoryBinding(reportDirectory))) {
        const staged = await fs.lstat(temporary);
        if (sameNode(temporaryBinding, staged) && !staged.isSymbolicLink()) await fs.unlink(temporary);
      }
    } catch { /* Preserve ambiguous leftovers; detection below remains conservative. */ }
  }
}

/** Mandatory before copying any selected-scope content, including failed/cancelled attempts. */
export async function writeBackupSelectionIntent(task: BackupTask, destination: Destination, deps: BackupSelectionMarkerDependencies) {
  return publishScope(task, destination, deps);
}

/** Completion gate: the immutable warning must survive, independently of PDF preferences. */
export async function writeBackupSelectionMarker(task: BackupTask, destination: Destination, deps: BackupSelectionMarkerDependencies) {
  if (!markerContents(task, destination)) return;
  const plan = task.selection!, index = task.destinations.findIndex((item) => item.id === destination.id);
  const selected = new Set(plan.includedPaths), byPath = new Map(plan.sourceFiles.map((file) => [file.relativePath, file]));
  if (!destination.verified || task.fileRecords.length !== selected.size ||
      new Set(task.fileRecords.map((file) => file.relativePath)).size !== selected.size)
    throw new Error("选定范围尚未逐文件完成校验，不能完成备份");
  for (const file of task.fileRecords) {
    const expected = byPath.get(file.relativePath), copy = file.destinations[index];
    if (!selected.has(file.relativePath) || !expected || expected.size !== file.size || !file.srcChecksum ||
        !copy?.verified || copy.checksum !== file.srcChecksum || !destination.resolvedPath ||
        !path.isAbsolute(copy.path) || path.resolve(copy.path) !== copy.path ||
        !inside(copy.path, destination.resolvedPath) || copy.path === destination.resolvedPath ||
        (task.hashAlgorithm === "sha256" && file.srcChecksum !== expected.sha256))
      throw new Error("选定范围逐文件证据不完整或与当前目的地不一致，不能完成备份");
  }
  return publishScope(task, destination, deps);
}

export interface DetectedBackupSelectionMarker {
  path: string;
  status: "selected-scope" | "unreadable-or-invalid";
  taskId?: string;
  selectionDigest?: string;
  /** Reserved daily-delivery evidence exists; its validity is not assumed. */
  derivedScopeKind?: "daily-delivery";
}

/** Presence is enough to block full-card adoption; this is never an authenticity check. */
export async function detectBackupSelectionMarker(root: string, options: { relativeDirectories?: string[]; signal?: AbortSignal } = {}): Promise<{ detected: boolean; markers: DetectedBackupSelectionMarker[] }> {
  const cancelled = () => options.signal?.throwIfAborted();
  cancelled();
  if (!path.isAbsolute(root) || path.resolve(root) !== root || root.includes("\0")) throw new Error("请选择绝对素材目录");
  const bindDirectory = async (directory: string) => {
    cancelled(); const binding = await directoryBinding(directory); cancelled(); return binding;
  };
  const rootBinding = await bindDirectory(root);
  const bounded = options.relativeDirectories !== undefined;
  const relativeDirectories = options.relativeDirectories || [];
  if (!Array.isArray(relativeDirectories) || relativeDirectories.some((relative) => typeof relative !== "string" ||
      !relative || relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative || relative.split("/").some((part) => part === "." || part === ".." || !part)))
    throw new Error("范围声明检查的目录清单路径无效或越界");
  // During transfers the scanner already made explicit system/permission
  // exclusions. Inspect only its successful directory inventory, never reopen
  // excluded folders or silently reinterpret permission exclusions as coverage.
  const markers: DetectedBackupSelectionMarker[] = [], recordedPaths = new Set<string>(), pending = [root];
  const recordMarker = (marker: DetectedBackupSelectionMarker) => {
    if (!recordedPaths.has(marker.path)) { markers.push(marker); recordedPaths.add(marker.path); }
  };
  const dailyNames = [".kocpy-daily-delivery.json", ".kocpy-daily-delivery.journal.ndjson"];
  const isScopeName = (name: string) => name.startsWith(markerPrefix) && name.endsWith(".json") ||
    name.startsWith(`.${markerPrefix}`) && name.endsWith(".partial");
  const readDirectory = async (directory: string) => {
    cancelled(); const entries = await fs.readdir(directory, { withFileTypes: true }); cancelled(); return entries;
  };
  const optionalStat = async (target: string) => {
    cancelled();
    try { const stat = await fs.lstat(target); cancelled(); return stat; }
    catch (error) { cancelled(); if (missing(error)) return; throw error; }
  };
  // A user can choose MEDIA (or any deeper directory) inside a derived backup.
  // That cannot turn the subset into a complete source. Inspect only the exact
  // reserved names at each ancestor, never enumerate sibling material trees or
  // read ancestor declaration contents. Even an invalid declaration blocks
  // full-card interpretation; its mere name is not authenticated provenance.
  let ancestor = path.dirname(root);
  if (ancestor !== root) for (;;) {
    cancelled();
    const binding = await bindDirectory(ancestor);
    for (const name of dailyNames) {
      cancelled(); const target = path.join(ancestor, name);
      if (await optionalStat(target)) recordMarker({ path: target, status: "unreadable-or-invalid", derivedScopeKind: "daily-delivery" });
    }
    const reports = path.join(ancestor, reportName), reportStat = await optionalStat(reports);
    if (reportStat) {
      if (!reportStat.isDirectory() || reportStat.isSymbolicLink()) {
        recordMarker({ path: reports, status: "unreadable-or-invalid" });
      } else {
        const reportBinding = await bindDirectory(reports);
        if (!sameNode(reportStat, reportBinding)) throw new Error("祖先范围声明目录在检查期间发生变化");
        for (const entry of await readDirectory(reports)) {
          cancelled();
          if (isScopeName(entry.name)) recordMarker({ path: path.join(reports, entry.name), status: "unreadable-or-invalid" });
        }
        if (!sameNode(reportBinding, await bindDirectory(reports))) throw new Error("祖先范围声明目录在检查期间发生变化");
      }
    }
    if (!sameNode(binding, await bindDirectory(ancestor))) throw new Error("祖先目录在范围声明检查期间发生变化");
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const relative of new Set(relativeDirectories)) {
    cancelled(); const child = await safeChild(root, relative); cancelled(); pending.push(child);
  }
  while (pending.length) {
    cancelled();
    const directory = pending.pop()!, binding = await bindDirectory(directory);
    const entries = await readDirectory(directory);
    for (const entry of entries) {
      cancelled();
      const target = path.join(directory, entry.name);
      if (dailyNames.includes(entry.name)) {
        // A daily delivery is another subset of an immutable full-card source.
        // Do not parse away the warning when its journal/marker is damaged,
        // unreadable, a symlink or from a newer version.
        recordMarker({ path: target, status: "unreadable-or-invalid", derivedScopeKind: "daily-delivery" });
        continue;
      }
      if (path.basename(directory) === reportName && isScopeName(entry.name)) {
        const record: DetectedBackupSelectionMarker = { path: target, status: "unreadable-or-invalid" };
        recordMarker(record);
        // Parse only small declarations for user-friendly identity. Large,
        // malformed, symlinked or interrupted declarations still block adoption.
        let handle;
        try {
          cancelled();
          handle = await fs.open(target, constants.O_RDONLY | noFollow);
          cancelled();
          const before = await handle.stat();
          cancelled();
          if (!before.isFile() || before.size > 1024 * 1024) continue;
          const text = await handle.readFile("utf8"); cancelled();
          const data = JSON.parse(text);
          const after = await handle.stat(); cancelled();
          const atPath = await fs.lstat(target); cancelled();
          if (!sameFile(before, after) || !sameFile(after, atPath) || atPath.isSymbolicLink()) continue;
          if (data.schemaVersion === 1 && data.kind === markerKind && data.wholeCardCovered === false &&
              data.verificationClaim === "none" && typeof data.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(data.taskId) &&
              typeof data.selectionDigest === "string" && /^[a-f0-9]{64}$/.test(data.selectionDigest)) {
            record.status = "selected-scope"; record.taskId = data.taskId; record.selectionDigest = data.selectionDigest;
          }
        } catch {
          cancelled();
          /* A damaged or inaccessible marker must not disappear from the result. */
        }
        finally { await handle?.close(); }
      } else if (entry.isDirectory() && !bounded) pending.push(target);
      else if (entry.isSymbolicLink() && entry.name === reportName) {
        recordMarker({ path: target, status: "unreadable-or-invalid" });
      }
    }
    if (!sameNode(binding, await bindDirectory(directory))) throw new Error("素材目录在范围声明检查期间发生变化");
  }
  if (!sameNode(rootBinding, await bindDirectory(root))) throw new Error("素材目录在范围声明检查期间发生变化");
  cancelled();
  return { detected: markers.length > 0, markers };
}
