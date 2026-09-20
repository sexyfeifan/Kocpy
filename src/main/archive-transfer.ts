import { constants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { VolumeIdentity } from "../common/volume-identity";
import { publishNewArtifact } from "./completion-automation";

export type ArchiveTransferStatus =
  | "ready"
  | "running"
  | "verifying"
  | "interrupted"
  | "failed"
  | "completed";

export type ArchiveTransferReportStatus =
  | "pending"
  | "generating"
  | "completed"
  | "failed";

export interface ArchiveTransferInventoryFile {
  relativePath: string;
  size: number;
  mtimeMs: number;
  /**
   * Added to the schema-1 preflight snapshot. 0.1.36 development builds did
   * not record ctime, so a migrated read-only record intentionally keeps this
   * absent instead of inventing evidence that was never captured.
   */
  ctimeMs?: number;
  inode: number;
  sourceSha256?: string;
  targetSha256?: string;
  verifiedAt?: number;
}

export interface ArchiveTransferInventory {
  files: ArchiveTransferInventoryFile[];
  directories: string[];
  emptyDirectories: string[];
  totalFiles: number;
  totalBytes: number;
  digest: string;
  existingPdfFiles: number;
  existingManifestFiles: number;
}

export interface ArchiveTransferContext {
  projectId?: string;
  archiveName: string;
  archiveNameSource: "project" | "folder";
  shootingDate?: string;
  historicalEvidence: string[];
}

export interface ArchiveTransferPreview extends ArchiveTransferContext {
  sourcePath: string;
  destinationParent: string;
  finalPath: string;
  sourceIdentity: VolumeIdentity;
  destinationIdentity: VolumeIdentity;
  inventory: ArchiveTransferInventory;
  availableBytes: number;
  requiredBytes: number;
  warnings: string[];
  evidenceBoundary: string;
}

export interface ArchiveTransferReportSnapshot {
  schemaVersion: 1;
  reportId: string;
  transferId: string;
  archiveName: string;
  archiveNameSource: "project" | "folder";
  shootingDate: string;
  payloadFileCount: number;
  payloadBytes: number;
  payloadHumanBytes: string;
  payloadEmptyDirectories: number;
  sourcePath: string;
  finalPath: string;
  startedAt: number;
  completedAt: number;
  hashAlgorithm: "SHA-256";
  verificationConclusion: "通过";
  inventoryDigest: string;
  historicalEvidence: string[];
  evidenceBoundary: string;
}

export interface ArchiveTransferReportAttempt {
  attempt: number;
  artifactReportId: string;
  startedAt: number;
  completedAt?: number;
  status: "running" | "publishing" | "completed" | "failed";
  pdfPath?: string;
  pngPath?: string;
  pdfSha256?: string;
  pngSha256?: string;
  pdfBytes?: number;
  pngBytes?: number;
  error?: string;
}

export interface ArchiveTransferLegacyMigration {
  sourceVersion: "0.1.36";
  migratedAt: number;
  originalStatus: ArchiveTransferStatus;
  originalReportStatus: ArchiveTransferReportStatus;
  disposition: "read-only-completed" | "restart-required";
}

export interface ArchiveTransferTask extends ArchiveTransferContext {
  schemaVersion: 1;
  legacyMigration?: ArchiveTransferLegacyMigration;
  id: string;
  reportId: string;
  sourcePath: string;
  destinationParent: string;
  finalPath: string;
  markerPath: string;
  sourceIdentity: VolumeIdentity;
  destinationIdentity: VolumeIdentity;
  inventory: ArchiveTransferInventory;
  status: ArchiveTransferStatus;
  reportStatus: ArchiveTransferReportStatus;
  reportAttempts: ArchiveTransferReportAttempt[];
  reportSnapshot?: ArchiveTransferReportSnapshot;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  currentFile?: string;
  completedFiles: number;
  verifiedBytes: number;
  targetCreated: boolean;
  error?: string;
  recoveryEvents: Array<{
    at: number;
    action: string;
    relativePath?: string;
    detail?: string;
  }>;
}

export interface ArchiveTransferProgress {
  taskId: string;
  status: ArchiveTransferStatus;
  phase:
    | "scanning"
    | "copying"
    | "verifying"
    | "reporting"
    | "completed"
    | "attention";
  currentFile?: string;
  currentFileBytes: number;
  currentFileTotalBytes: number;
  overallProcessedBytes: number;
  overallTotalBytes: number;
  processedBytes: number;
  completedFiles: number;
  totalFiles: number;
  verifiedBytes: number;
  totalBytes: number;
  speedBps: number;
  averageSpeedBps: number;
  elapsedMs: number;
  etaSeconds: number;
}

interface ArchiveTransferLiveProgress {
  phase: ArchiveTransferProgress["phase"];
  phaseStartedAt: number;
  currentFile?: string;
  currentFileBytes: number;
  currentFileTotalBytes: number;
  processedBytes: number;
  phaseCompletedFiles: number;
  lastSampleAt: number;
  lastSampleBytes: number;
  lastEmittedAt: number;
  speedBps: number;
}

export type ArchiveTransferInventorySummary = Omit<
  ArchiveTransferInventory,
  "files" | "directories" | "emptyDirectories"
> & { emptyDirectoryCount: number };

export type ArchiveTransferTaskSummary = Omit<
  ArchiveTransferTask,
  "inventory" | "sourceIdentity" | "destinationIdentity" | "recoveryEvents"
> & {
  inventory: ArchiveTransferInventorySummary;
  recoveryEventCount: number;
  sourceVolumeName: string;
  destinationVolumeName: string;
};

export function summarizeArchiveTransfer(
  task: ArchiveTransferTask,
): ArchiveTransferTaskSummary {
  const { inventory, sourceIdentity, destinationIdentity, recoveryEvents, ...rest } =
    task;
  const { files: _files, directories: _directories, emptyDirectories, ...summary } =
    inventory;
  return {
    ...structuredClone(rest),
    inventory: {
      ...summary,
      emptyDirectoryCount: emptyDirectories.length,
    },
    recoveryEventCount: recoveryEvents.length,
    sourceVolumeName: sourceIdentity.name,
    destinationVolumeName: destinationIdentity.name,
  };
}

export interface ArchiveTransferStartInput {
  sourcePath: string;
  destinationParent: string;
  previewDigest: string;
  context: ArchiveTransferContext;
}

export interface ArchiveTransferRenderedReports {
  pdf: Buffer;
  png: Buffer;
}

export interface ArchiveTransferDependencies {
  identifyVolume(location: string): Promise<VolumeIdentity>;
  availableBytes(location: string): Promise<number>;
  persist(tasks: ArchiveTransferTask[]): Promise<void>;
  renderReports(
    snapshot: ArchiveTransferReportSnapshot,
    artifactReportId: string,
  ): Promise<ArchiveTransferRenderedReports>;
  onProgress?(progress: ArchiveTransferProgress): void;
  now?(): number;
  randomId?(): string;
  removeFile?(file: string): Promise<void>;
}

export interface ArchiveTransferLoadResult {
  tasks: ArchiveTransferTask[];
  migrated: boolean;
}

const SOURCE_CHANGED = "源文件夹内容已变化，已安全停止；恢复原内容后重新预检";
const MARKER_CLEANUP_FAILED = "数据和报告已完成，但临时任务所有权标记未能安全清理";

const markerPathFor = (task: Pick<ArchiveTransferTask, "id" | "destinationParent" | "finalPath">) =>
  path.join(
    task.destinationParent,
    `.${path.basename(task.finalPath)}.kocpy-transfer-${task.id}.json`,
  );

const nowIsoId = (now: number, suffix: string) => {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `KAT-${stamp}-${suffix.slice(0, 8).toUpperCase()}`;
};

export function humanArchiveBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"],
    index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))),
    amount = value / 1024 ** index;
  return `${amount.toLocaleString("en-US", {
    minimumFractionDigits: index === 0 ? 0 : 2,
    maximumFractionDigits: index === 0 ? 0 : 2,
    useGrouping: true,
  })} ${units[index]}`;
}

const portableRelative = (value: string) => value.split(path.sep).join("/");

const digestInventory = (
  files: ArchiveTransferInventoryFile[],
  directories: string[],
) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        files: files.map(({ relativePath, size, mtimeMs, ctimeMs, inode }) => ({
          relativePath,
          size,
          mtimeMs,
          ctimeMs,
          inode,
        })),
        directories,
      }),
    )
    .digest("hex");

async function inventoryDirectory(root: string): Promise<ArchiveTransferInventory> {
  const files: ArchiveTransferInventoryFile[] = [],
    directories: string[] = [],
    children = new Map<string, number>();
  const walk = async (directory: string, relativeDirectory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (relativeDirectory) {
      directories.push(portableRelative(relativeDirectory));
      children.set(portableRelative(relativeDirectory), entries.length);
    }
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name, "en"),
    )) {
      const absolute = path.join(directory, entry.name),
        relative = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name,
        portable = portableRelative(relative),
        stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink())
        throw new Error(`归档范围包含符号链接或别名，已停止：${portable}`);
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile())
        files.push({
          relativePath: portable,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          inode: stat.ino,
        });
      else throw new Error(`归档范围包含不支持的特殊文件，已停止：${portable}`);
    }
  };
  await walk(root, "");
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "en"));
  directories.sort((a, b) => a.localeCompare(b, "en"));
  const emptyDirectories = directories.filter((item) => children.get(item) === 0),
    lower = files.map((item) => item.relativePath.toLowerCase());
  return {
    files,
    directories,
    emptyDirectories,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0),
    digest: digestInventory(files, directories),
    existingPdfFiles: lower.filter((item) => item.endsWith(".pdf")).length,
    existingManifestFiles: lower.filter(
      (item) => item.endsWith(".mhl") || item.endsWith(".xml"),
    ).length,
  };
}

const contained = (candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
};

async function canonicalDirectory(value: string, label: string) {
  if (!value || !path.isAbsolute(value) || value.includes("\0"))
    throw new Error(`${label}路径无效`);
  const real = await fs.realpath(value).catch(() => {
    throw new Error(`${label}不可访问，请检查连接`);
  });
  if (!(await fs.stat(real)).isDirectory()) throw new Error(`${label}必须是文件夹`);
  return real;
}

function assertDistinctRoots(source: string, destinationParent: string, finalPath: string) {
  if (
    contained(destinationParent, source) ||
    contained(source, finalPath) ||
    contained(finalPath, source)
  )
    throw new Error("源文件夹与目标位置不能相同、互相嵌套或通过别名指向同一位置");
}

function sameIdentity(expected: VolumeIdentity, actual: VolumeIdentity) {
  if (expected.uuid)
    return Boolean(actual.uuid && expected.uuid.toUpperCase() === actual.uuid.toUpperCase());
  return (
    expected.id === actual.id &&
    expected.device === actual.device &&
    expected.name === actual.name &&
    (expected.mountPoint || "") === (actual.mountPoint || "") &&
    (expected.fileSystem || "") === (actual.fileSystem || "") &&
    (!expected.mountSourceDigest ||
      expected.mountSourceDigest === actual.mountSourceDigest)
  );
}

function safeTarget(root: string, relativePath: string) {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (!contained(target, path.resolve(root)) || target === path.resolve(root))
    throw new Error(`归档相对路径越界，已停止：${relativePath}`);
  return target;
}

interface BoundArchiveDirectory {
  path: string;
  dev: number;
  ino: number;
}

async function bindArchiveDirectory(
  directory: string,
  label: string,
): Promise<BoundArchiveDirectory> {
  const before = await fs.lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error(`${label}不是安全的实际目录，已停止写入`);
  const real = await fs.realpath(directory);
  if (real !== directory)
    throw new Error(`${label}通过符号链接或别名指向其他位置，已停止写入`);
  const after = await fs.lstat(directory);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino
  )
    throw new Error(`${label}在安全检查期间发生变化，已停止写入`);
  return { path: directory, dev: after.dev, ino: after.ino };
}

async function assertBoundArchiveDirectory(
  bound: BoundArchiveDirectory,
  label: string,
) {
  const current = await bindArchiveDirectory(bound.path, label);
  if (current.dev !== bound.dev || current.ino !== bound.ino)
    throw new Error(`${label}在写入前被替换，已停止写入`);
  return current;
}

/**
 * Walk and optionally create one destination parent chain without ever using
 * recursive mkdir. Every existing component must be a stable, canonical
 * directory. This is deliberately stricter than a final whole-tree scan: a
 * recovery target may have been changed while Kocpy was not running, and no
 * byte may be written before that change is rejected.
 */
async function bindArchiveTargetParent(
  root: string,
  relativePath: string,
  createMissing: boolean,
) {
  const canonicalRoot = path.resolve(root),
    parentRelative = portableRelative(path.posix.dirname(relativePath)),
    parts = parentRelative === "." ? [] : parentRelative.split("/");
  let current = await bindArchiveDirectory(
    canonicalRoot,
    "归档目标根目录",
  );
  for (const part of parts) {
    if (!part || part === "." || part === "..")
      throw new Error(`归档目录路径无效，已停止：${relativePath}`);
    const candidate = path.join(current.path, part);
    if (!contained(candidate, canonicalRoot) || candidate === canonicalRoot)
      throw new Error(`归档目录路径越界，已停止：${relativePath}`);
    await assertBoundArchiveDirectory(current, "归档目标父目录");
    let stat = await fs.lstat(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) {
      if (!createMissing)
        throw new Error(`归档目标目录缺失，已停止：${parentRelative}`);
      await fs.mkdir(candidate, { recursive: false, mode: 0o755 });
      stat = await fs.lstat(candidate);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `归档目标父链包含符号链接、别名或非目录条目，已停止：${parentRelative}`,
      );
    await assertBoundArchiveDirectory(current, "归档目标父目录");
    current = await bindArchiveDirectory(candidate, "归档目标子目录");
  }
  return current;
}

async function bindArchiveTargetDirectory(
  root: string,
  relativeDirectory: string,
  createMissing: boolean,
) {
  // Appending a sentinel lets the shared parent walker validate/create the
  // full directory path without weakening the strict relative-path rules.
  return bindArchiveTargetParent(
    root,
    `${portableRelative(relativeDirectory)}/.kocpy-directory-sentinel`,
    createMissing,
  );
}

async function inspectArchiveTargetFile(
  root: string,
  relativePath: string,
  parent: BoundArchiveDirectory,
) {
  await assertBoundArchiveDirectory(parent, "归档文件目标父目录");
  const target = safeTarget(root, relativePath),
    stat = await fs.lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`归档目标不是安全的普通文件，已停止：${relativePath}`);
    const real = await fs.realpath(target);
    if (real !== target)
      throw new Error(
        `归档目标文件通过符号链接或别名指向其他位置，已停止：${relativePath}`,
      );
  }
  await assertBoundArchiveDirectory(parent, "归档文件目标父目录");
  return { target, stat };
}

const validAbsolutePath = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8192 &&
  path.isAbsolute(value) &&
  !value.includes("\0");

const validRelativePath = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !path.isAbsolute(value) &&
  !value.includes("\0") &&
  !value.split(/[\\/]/).includes("..");

const validSha256 = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function validateArchiveIdentity(value: unknown) {
  const identity = value as VolumeIdentity | undefined;
  return Boolean(
    identity &&
      typeof identity.id === "string" &&
      identity.id.length > 0 &&
      identity.id.length <= 1024 &&
      typeof identity.name === "string" &&
      identity.name.length <= 1024 &&
      (identity.uuid === undefined || typeof identity.uuid === "string"),
  );
}

function validateNormalizedArchiveTransferTasks(
  value: unknown,
  allowLegacyPreMigrationState = false,
): ArchiveTransferTask[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("归档转存记录格式无效");
  const ids = new Set<string>();
  for (const candidate of value) {
    const task = candidate as ArchiveTransferTask;
    const legacy = task?.legacyMigration;
    if (
      !task ||
      task.schemaVersion !== 1 ||
      (legacy !== undefined &&
        (legacy.sourceVersion !== "0.1.36" ||
          !Number.isFinite(legacy.migratedAt) ||
          !["ready", "running", "verifying", "interrupted", "failed", "completed"].includes(
            legacy.originalStatus,
          ) ||
          !["pending", "generating", "completed", "failed"].includes(
            legacy.originalReportStatus,
          ) ||
          !["read-only-completed", "restart-required"].includes(
            legacy.disposition,
          ))) ||
      typeof task.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(task.id) ||
      ids.has(task.id) ||
      !validAbsolutePath(task.sourcePath) ||
      !validAbsolutePath(task.destinationParent) ||
      !validAbsolutePath(task.finalPath) ||
      !validAbsolutePath(task.markerPath) ||
      path.resolve(task.finalPath) !==
        path.join(path.resolve(task.destinationParent), path.basename(task.sourcePath)) ||
      path.resolve(task.markerPath) !== path.resolve(markerPathFor(task)) ||
      !validateArchiveIdentity(task.sourceIdentity) ||
      !validateArchiveIdentity(task.destinationIdentity) ||
      !["ready", "running", "verifying", "interrupted", "failed", "completed"].includes(
        task.status,
      ) ||
      !["pending", "generating", "completed", "failed"].includes(
        task.reportStatus,
      ) ||
      typeof task.targetCreated !== "boolean" ||
      !Number.isFinite(task.createdAt) ||
      !Number.isSafeInteger(task.completedFiles) ||
      task.completedFiles < 0 ||
      !Number.isSafeInteger(task.verifiedBytes) ||
      task.verifiedBytes < 0 ||
      !Array.isArray(task.reportAttempts) ||
      !Array.isArray(task.recoveryEvents) ||
      !task.inventory ||
      !Array.isArray(task.inventory.files) ||
      !Array.isArray(task.inventory.directories) ||
      !Array.isArray(task.inventory.emptyDirectories)
    )
      throw new Error("归档转存记录包含无效任务");
    ids.add(task.id);
    try {
      assertDistinctRoots(
        path.resolve(task.sourcePath),
        path.resolve(task.destinationParent),
        path.resolve(task.finalPath),
      );
    } catch {
      throw new Error("归档转存记录的源与目标边界无效");
    }
    const filePaths = new Set<string>(),
      directoryPaths = new Set<string>();
    let totalBytes = 0,
      completedFiles = 0,
      verifiedBytes = 0;
    for (const file of task.inventory.files) {
      if (
        !file ||
        !validRelativePath(file.relativePath) ||
        filePaths.has(file.relativePath) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !Number.isFinite(file.mtimeMs) ||
        (legacy
          ? file.ctimeMs !== undefined
          : !Number.isFinite(file.ctimeMs)) ||
        !Number.isFinite(file.inode) ||
        file.inode < 0 ||
        (file.sourceSha256 !== undefined && !validSha256(file.sourceSha256)) ||
        (file.targetSha256 !== undefined && !validSha256(file.targetSha256)) ||
        (file.verifiedAt !== undefined &&
          (!Number.isFinite(file.verifiedAt) ||
            !validSha256(file.sourceSha256) ||
            !validSha256(file.targetSha256)))
      )
        throw new Error("归档转存文件快照无效");
      filePaths.add(file.relativePath);
      totalBytes += file.size;
      if (file.verifiedAt !== undefined) {
        completedFiles++;
        verifiedBytes += file.size;
      }
    }
    for (const directory of task.inventory.directories) {
      if (!validRelativePath(directory) || directoryPaths.has(directory))
        throw new Error("归档转存目录快照无效");
      directoryPaths.add(directory);
    }
    if (
      task.inventory.emptyDirectories.some(
        (directory) =>
          !validRelativePath(directory) ||
          !directoryPaths.has(directory) ||
          task.inventory.files.some((file) =>
            file.relativePath.startsWith(directory + "/"),
          ) ||
          task.inventory.directories.some(
            (child) => child !== directory && child.startsWith(directory + "/"),
          ),
      ) ||
      [...filePaths].some((file) => directoryPaths.has(file)) ||
      task.inventory.totalFiles !== task.inventory.files.length ||
      task.inventory.totalBytes !== totalBytes ||
      task.inventory.digest !==
        digestInventory(task.inventory.files, task.inventory.directories) ||
      task.inventory.existingPdfFiles !==
        task.inventory.files.filter((file) =>
          file.relativePath.toLowerCase().endsWith(".pdf"),
        ).length ||
      task.inventory.existingManifestFiles !==
        task.inventory.files.filter((file) =>
          /\.(?:mhl|xml)$/i.test(file.relativePath),
        ).length ||
      task.completedFiles !== completedFiles ||
      task.verifiedBytes !== verifiedBytes ||
      (task.currentFile !== undefined && !filePaths.has(task.currentFile)) ||
      (task.status === "completed" &&
        (completedFiles !== task.inventory.files.length || !task.reportSnapshot)) ||
      (task.status !== "completed" && Boolean(task.reportSnapshot)) ||
      (task.reportStatus !== "pending" && task.status !== "completed") ||
      (!allowLegacyPreMigrationState &&
        legacy?.disposition === "read-only-completed" &&
        task.status !== "completed") ||
      (!allowLegacyPreMigrationState &&
        legacy?.disposition === "restart-required" &&
        task.status !== "failed")
    )
      throw new Error("归档转存快照汇总或状态不一致");
    const reportRoot = path.join(path.resolve(task.finalPath), "Kocpy报告");
    for (const [index, attempt] of task.reportAttempts.entries()) {
      const expectedPdf = path.join(
          reportRoot,
          `Kocpy_NAS归档_${attempt.artifactReportId}.pdf`,
        ),
        expectedPng = path.join(
          reportRoot,
          `Kocpy_NAS归档_${attempt.artifactReportId}.png`,
        ),
        hasPublicationEvidence =
          attempt.pdfPath !== undefined ||
          attempt.pngPath !== undefined ||
          attempt.pdfSha256 !== undefined ||
          attempt.pngSha256 !== undefined ||
          attempt.pdfBytes !== undefined ||
          attempt.pngBytes !== undefined,
        hasCompletePublicationEvidence =
          validAbsolutePath(attempt.pdfPath) &&
          validAbsolutePath(attempt.pngPath) &&
          validSha256(attempt.pdfSha256) &&
          validSha256(attempt.pngSha256) &&
          Number.isSafeInteger(attempt.pdfBytes) &&
          attempt.pdfBytes! > 0 &&
          Number.isSafeInteger(attempt.pngBytes) &&
          attempt.pngBytes! > 0;
      if (
        !attempt ||
        attempt.attempt !== index + 1 ||
        typeof attempt.artifactReportId !== "string" ||
        !/^KAT-[A-Z0-9TZ-]+(?:-R\d+)?$/.test(attempt.artifactReportId) ||
        !Number.isFinite(attempt.startedAt) ||
        !["running", "publishing", "completed", "failed"].includes(
          attempt.status,
        ) ||
        (attempt.completedAt !== undefined && !Number.isFinite(attempt.completedAt)) ||
        (attempt.pdfPath !== undefined &&
          (!validAbsolutePath(attempt.pdfPath) ||
            path.resolve(attempt.pdfPath) !== expectedPdf)) ||
        (attempt.pngPath !== undefined &&
          (!validAbsolutePath(attempt.pngPath) ||
            path.resolve(attempt.pngPath) !== expectedPng)) ||
        (!legacy &&
          hasPublicationEvidence &&
          !hasCompletePublicationEvidence) ||
        (!legacy &&
          ["publishing", "completed"].includes(attempt.status) &&
          !hasCompletePublicationEvidence) ||
        (attempt.status === "completed" &&
          (!attempt.completedAt || !attempt.pdfPath || !attempt.pngPath))
      )
        throw new Error("归档转存报告尝试记录无效");
    }
    if (
      (!legacy &&
        task.reportStatus === "pending" &&
        task.reportAttempts.length > 0) ||
      (task.reportStatus === "generating" &&
        !["running", "publishing"].includes(
          task.reportAttempts.at(-1)?.status || "",
        )) ||
      (task.reportStatus === "completed" &&
        task.reportAttempts.at(-1)?.status !== "completed") ||
      (!legacy &&
        task.reportStatus === "failed" &&
        task.reportAttempts.at(-1)?.status !== "failed")
    )
      throw new Error("归档转存报告状态不一致");
    if (task.reportSnapshot) {
      const snapshot = task.reportSnapshot;
      if (
        snapshot.schemaVersion !== 1 ||
        snapshot.reportId !== task.reportId ||
        snapshot.transferId !== task.id ||
        snapshot.archiveName !== task.archiveName ||
        snapshot.payloadFileCount !== task.inventory.totalFiles ||
        snapshot.payloadBytes !== task.inventory.totalBytes ||
        snapshot.payloadEmptyDirectories !== task.inventory.emptyDirectories.length ||
        snapshot.sourcePath !== task.sourcePath ||
        snapshot.finalPath !== task.finalPath ||
        snapshot.hashAlgorithm !== "SHA-256" ||
        snapshot.verificationConclusion !== "通过" ||
        snapshot.inventoryDigest !== task.inventory.digest ||
        !Number.isFinite(snapshot.startedAt) ||
        !Number.isFinite(snapshot.completedAt)
      )
        throw new Error("归档转存报告快照无效");
    }
    if (
      task.recoveryEvents.length > 100000 ||
      task.recoveryEvents.some(
        (event) =>
          !event ||
          !Number.isFinite(event.at) ||
          typeof event.action !== "string" ||
          !event.action ||
          (event.relativePath !== undefined &&
            !validRelativePath(event.relativePath)),
      )
    )
      throw new Error("归档转存恢复记录无效");
    if (!allowLegacyPreMigrationState && legacy) {
      const migrationEvents = task.recoveryEvents.filter(
          (event) => event.action === "legacy-0.1.36-record-migrated-read-only",
        ),
        expectedReportStatus =
          legacy.originalReportStatus === "generating"
            ? "failed"
            : legacy.originalReportStatus;
      if (
        (legacy.originalStatus === "completed") !==
          (legacy.disposition === "read-only-completed") ||
        task.reportStatus !== expectedReportStatus ||
        migrationEvents.length !== 1 ||
        migrationEvents[0].at !== legacy.migratedAt ||
        (legacy.disposition === "restart-required" &&
          (typeof task.error !== "string" || !task.error.includes("重新预检")))
      )
        throw new Error("归档转存旧记录迁移证据无效");
    }
  }
  return structuredClone(value as ArchiveTransferTask[]);
}

export function validateArchiveTransferTasks(
  value: unknown,
): ArchiveTransferTask[] {
  return validateNormalizedArchiveTransferTasks(value);
}

/**
 * Reads both the current schema and the short-lived 0.1.36 archive-transfer
 * state. Legacy records are validated with their original inventory digest
 * before being normalized. They remain read-only because ctime was not part of
 * the original preflight evidence and therefore cannot be reconstructed safely.
 */
export function loadArchiveTransferTasks(
  value: unknown,
  migratedAt = Date.now(),
): ArchiveTransferLoadResult {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error("归档转存记录格式无效");
  const prepared = structuredClone(value) as Array<Record<string, unknown>>;
  const newlyMigratedIds = new Set<string>();
  for (const candidate of prepared) {
    if (!candidate || typeof candidate !== "object")
      throw new Error("归档转存记录包含无效任务");
    if ("schemaVersion" in candidate) continue;
    if ("legacyMigration" in candidate)
      throw new Error("归档转存旧记录迁移标记无效");
    const status = candidate.status as ArchiveTransferStatus,
      reportStatus = candidate.reportStatus as ArchiveTransferReportStatus;
    if (
      !["ready", "running", "verifying", "interrupted", "failed", "completed"].includes(
        status,
      ) ||
      !["pending", "generating", "completed", "failed"].includes(reportStatus)
    )
      throw new Error("归档转存旧记录状态无效");
    candidate.schemaVersion = 1;
    candidate.legacyMigration = {
      sourceVersion: "0.1.36",
      migratedAt,
      originalStatus: status,
      originalReportStatus: reportStatus,
      disposition:
        status === "completed" ? "read-only-completed" : "restart-required",
    } satisfies ArchiveTransferLegacyMigration;
    if (typeof candidate.id === "string") newlyMigratedIds.add(candidate.id);
  }

  // Validate the unmodified legacy status first. This prevents migration from
  // laundering a malformed running/reporting state into a harmless-looking
  // failed record.
  const validated = validateNormalizedArchiveTransferTasks(prepared, true);
  if (!newlyMigratedIds.size)
    return {
      tasks: validateNormalizedArchiveTransferTasks(validated),
      migrated: false,
    };

  for (const task of validated) {
    const migration = task.legacyMigration;
    if (!migration || !newlyMigratedIds.has(task.id)) continue;
    if (migration.disposition === "restart-required") {
      task.status = "failed";
      task.error =
        "此任务来自早期 0.1.37 候选的旧格式快照，未记录 ctime，无法安全恢复。请重新选择源与归档目标，重新预检并开始新任务；旧记录与已写入内容不会被改动。";
    }
    if (task.reportStatus === "generating") {
      task.reportStatus = "failed";
      const lastAttempt = task.reportAttempts.at(-1);
      if (
        lastAttempt &&
        ["running", "publishing"].includes(lastAttempt.status)
      ) {
        lastAttempt.status = "failed";
        lastAttempt.completedAt = migratedAt;
        lastAttempt.error = "旧版报告生成状态无法安全续接，已保留为只读记录";
      }
    }
    task.recoveryEvents.push({
      at: migratedAt,
      action: "legacy-0.1.36-record-migrated-read-only",
      detail:
        migration.disposition === "read-only-completed"
          ? "已完成记录保留为只读证据；未补写缺失的 ctime"
          : "未完成记录已安全终止；必须重新预检并创建新任务",
    });
  }
  return {
    tasks: validateNormalizedArchiveTransferTasks(validated),
    migrated: true,
  };
}

async function fileSha256(
  file: string,
  onProgress?: (processedBytes: number) => void,
) {
  const hash = createHash("sha256");
  let processedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      processedBytes += chunk.length;
      onProgress?.(processedBytes);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function archiveReportPaths(
  task: Pick<ArchiveTransferTask, "finalPath">,
  artifactReportId: string,
) {
  const reportRoot = path.join(task.finalPath, "Kocpy报告");
  return {
    reportRoot,
    pdfPath: path.join(
      reportRoot,
      `Kocpy_NAS归档_${artifactReportId}.pdf`,
    ),
    pngPath: path.join(
      reportRoot,
      `Kocpy_NAS归档_${artifactReportId}.png`,
    ),
  };
}

async function readArchiveReportEvidence(file: string) {
  const pathBefore = await fs.lstat(file);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
    throw new Error(`报告产物不是安全的普通文件：${file}`);
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== pathBefore.dev ||
      stat.ino !== pathBefore.ino
    )
      throw new Error(`报告产物路径在打开前发生变化：${file}`);
    const hash = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat(),
      pathAfter = await fs.lstat(file);
    if (
      after.size !== stat.size ||
      after.ino !== stat.ino ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== stat.dev ||
      pathAfter.ino !== stat.ino
    )
      throw new Error(`报告产物在回读期间发生变化：${file}`);
    return { bytes: stat.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readArchiveMarker(file: string) {
  const pathBefore = await fs.lstat(file);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
    throw new Error("恢复标记不是安全的普通文件，Kocpy 不会继续写入");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > 128 * 1024 ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino
    )
      throw new Error("恢复标记内容或路径无效，Kocpy 不会继续写入");
    const content = await handle.readFile("utf8"),
      after = await handle.stat(),
      pathAfter = await fs.lstat(file);
    if (
      after.size !== before.size ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    )
      throw new Error("恢复标记在读取期间发生变化，Kocpy 不会继续写入");
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      throw new Error("恢复标记内容无效，Kocpy 不会继续写入");
    }
  } finally {
    await handle.close();
  }
}

async function exclusiveCopyWithHash(
  source: string,
  destination: string,
  expected: ArchiveTransferInventoryFile,
  destinationParent: BoundArchiveDirectory,
  onProgress?: (processedBytes: number) => void,
) {
  await assertBoundArchiveDirectory(
    destinationParent,
    "归档文件目标父目录",
  );
  const sourceHandle = await fs.open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let destinationIdentity: { dev: number; ino: number } | undefined;
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let completed = false;
  try {
    const before = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.size !== expected.size ||
      before.mtimeMs !== expected.mtimeMs ||
      before.ctimeMs !== expected.ctimeMs ||
      before.ino !== expected.inode
    )
      throw new Error(SOURCE_CHANGED);
    await assertBoundArchiveDirectory(
      destinationParent,
      "归档文件目标父目录",
    );
    destinationHandle = await fs.open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o644,
    );
    const destinationStat = await destinationHandle.stat();
    if (!destinationStat.isFile())
      throw new Error("归档目标不是安全的普通文件，已停止写入");
    destinationIdentity = {
      dev: destinationStat.dev,
      ino: destinationStat.ino,
    };
    // The path walk and file creation are separate syscalls. Bind the parent
    // before opening and re-check it before the first payload byte.
    await assertBoundArchiveDirectory(
      destinationParent,
      "归档文件目标父目录",
    );
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error(SOURCE_CHANGED);
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (!result.bytesWritten) throw new Error("目标写入中断，已安全停止");
        written += result.bytesWritten;
      }
      offset += bytesRead;
      onProgress?.(offset);
    }
    const after = await sourceHandle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.ino !== before.ino
    )
      throw new Error(SOURCE_CHANGED);
    await destinationHandle.sync();
    await assertBoundArchiveDirectory(
      destinationParent,
      "归档文件目标父目录",
    );
    const published = await fs.lstat(destination);
    if (
      !published.isFile() ||
      published.isSymbolicLink() ||
      published.dev !== destinationIdentity.dev ||
      published.ino !== destinationIdentity.ino
    )
      throw new Error("归档目标文件路径在写入期间发生变化，已停止");
    completed = true;
    return hash.digest("hex");
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
    if (!completed && destinationIdentity) {
      // Do not unlink through a parent chain that no longer matches the one
      // bound before creation. Preserving a partial is safer than deleting a
      // path that may now name another location.
      const parentStillBound = await assertBoundArchiveDirectory(
        destinationParent,
        "归档文件目标父目录",
      ).then(
        () => true,
        () => false,
      );
      if (parentStillBound) {
        const current = await fs.lstat(destination).catch(() => undefined);
        if (
          current?.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === destinationIdentity.dev &&
          current.ino === destinationIdentity.ino
        )
          await fs.unlink(destination).catch(() => undefined);
      }
    }
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class ArchiveTransferManager {
  private tasks: ArchiveTransferTask[] = [];
  private running = new Set<string>();
  private checkpointFiles = new Map<string, number>();
  private liveProgress = new Map<string, ArchiveTransferLiveProgress>();
  private stateCommitTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: ArchiveTransferDependencies) {}

  async initialize(tasks: ArchiveTransferTask[]) {
    this.tasks = validateArchiveTransferTasks(tasks || []);
    let changed = false;
    for (const task of this.tasks) {
      if (["ready", "running", "verifying"].includes(task.status)) {
        task.status = "interrupted";
        task.error = "上次归档转存在完成前中断；请核对原源文件夹和目标卷身份后恢复";
        task.recoveryEvents.push({
          at: this.now(),
          action: "startup-interruption-detected",
          detail: task.error,
        });
        changed = true;
      }
      if (task.reportStatus === "generating") {
        const lastAttempt = task.reportAttempts.at(-1);
        if (lastAttempt?.status === "publishing") {
          await this.reconcilePublishingReport(task, lastAttempt);
        } else {
          task.reportStatus = "failed";
          if (lastAttempt) {
            lastAttempt.status = "failed";
            lastAttempt.completedAt = this.now();
            lastAttempt.error = "上次报告生成在发布检查点前中断，可单独重试";
          }
          task.error = "数据已校验，上次报告生成被中断，可单独重试";
        }
        if (lastAttempt?.status === "failed" && !lastAttempt.completedAt) {
          lastAttempt.completedAt = this.now();
          lastAttempt.status = "failed";
        }
        changed = true;
      }
    }
    if (changed) await this.persist();
    for (const task of this.tasks)
      if (
        !task.legacyMigration &&
        task.status === "completed" &&
        task.reportStatus === "completed"
      )
        await this.finalizeCompletedMarker(task);
    return this.list();
  }

  list() {
    return structuredClone(this.tasks).sort((a, b) => b.createdAt - a.createdAt);
  }

  summaries() {
    return this.tasks
      .map(summarizeArchiveTransfer)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string) {
    return this.tasks.find((task) => task.id === id);
  }

  async preview(
    sourcePath: string,
    destinationParent: string,
    context?: Partial<ArchiveTransferContext>,
  ): Promise<ArchiveTransferPreview> {
    const source = await canonicalDirectory(sourcePath, "源文件夹"),
      parent = await canonicalDirectory(destinationParent, "归档目标父目录"),
      folderName = path.basename(source);
    if (!folderName || source === path.parse(source).root)
      throw new Error("请选择项目文件夹，不要直接选择磁盘根目录");
    const finalPath = path.join(parent, folderName);
    assertDistinctRoots(source, parent, finalPath);
    const targetStat = await fs.lstat(finalPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (targetStat)
      throw new Error(`目标已存在，Kocpy 不会覆盖：${finalPath}`);
    const [sourceIdentity, destinationIdentity, inventory, availableBytes] =
      await Promise.all([
        this.dependencies.identifyVolume(source),
        this.dependencies.identifyVolume(parent),
        inventoryDirectory(source),
        this.dependencies.availableBytes(parent),
      ]);
    const requiredBytes =
      inventory.totalBytes + Math.max(64 * 1024 * 1024, Math.ceil(inventory.totalBytes * 0.01));
    if (availableBytes < requiredBytes)
      throw new Error(
        `归档目标可用空间不足：需要至少 ${humanArchiveBytes(requiredBytes)}，当前 ${humanArchiveBytes(availableBytes)}`,
      );
    const archiveName = context?.archiveName?.trim() || folderName,
      nameSource = context?.archiveName?.trim() ? context.archiveNameSource || "project" : "folder";
    return {
      sourcePath: source,
      destinationParent: parent,
      finalPath,
      sourceIdentity,
      destinationIdentity,
      inventory,
      availableBytes,
      requiredBytes,
      archiveName,
      archiveNameSource: nameSource,
      projectId: context?.projectId,
      shootingDate: context?.shootingDate?.trim() || undefined,
      historicalEvidence: [...new Set(context?.historicalEvidence || [])],
      warnings: [
        ...(inventory.existingManifestFiles
          ? [`范围内 ${inventory.existingManifestFiles} 个既有 MHL/XML 将原样作为素材复制，不重新解释其历史结论。`]
          : []),
        ...(inventory.existingPdfFiles
          ? [`范围内 ${inventory.existingPdfFiles} 个既有 PDF 将原样作为素材复制。`]
          : []),
      ],
      evidenceBoundary:
        "本次结论只证明预检快照内的相对路径、文件内容、精确字节数与空目录在实际归档目标一致；Kocpy 只确认目标是当前可访问的已挂载目录，不确认它一定是 NAS，也不验证服务器内部磁盘拓扑；不验证磁盘占用、ACL、扩展属性、权限及创建/修改时间戳，不证明历史拍摄没有遗漏，也不改变既有清单的异常结论。",
    };
  }

  async start(input: ArchiveTransferStartInput) {
    const preview = await this.preview(
      input.sourcePath,
      input.destinationParent,
      input.context,
    );
    if (preview.inventory.digest !== input.previewDigest)
      throw new Error(SOURCE_CHANGED);
    const at = this.now(),
      id = this.id(),
      task: ArchiveTransferTask = {
        schemaVersion: 1,
        id,
        reportId: nowIsoId(at, id),
        sourcePath: preview.sourcePath,
        destinationParent: preview.destinationParent,
        finalPath: preview.finalPath,
        markerPath: "",
        sourceIdentity: preview.sourceIdentity,
        destinationIdentity: preview.destinationIdentity,
        inventory: preview.inventory,
        archiveName: preview.archiveName,
        archiveNameSource: preview.archiveNameSource,
        projectId: preview.projectId,
        shootingDate: preview.shootingDate,
        historicalEvidence: preview.historicalEvidence,
        status: "ready",
        reportStatus: "pending",
        reportAttempts: [],
        createdAt: at,
        completedFiles: 0,
        verifiedBytes: 0,
        targetCreated: false,
        recoveryEvents: [{ at, action: "task-created" }],
    };
    task.markerPath = markerPathFor(task);
    await this.withStateCommit(async () => {
      for (const existing of this.tasks) {
        if (path.resolve(existing.finalPath) !== task.finalPath) continue;
        let claimsTarget =
          ["ready", "running", "verifying", "interrupted"].includes(
            existing.status,
          ) ||
          (existing.status === "failed" && existing.targetCreated);
        if (existing.status === "completed" && !existing.legacyMigration) {
          const marker = await fs.lstat(existing.markerPath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          });
          // Current-schema tasks retain their marker until report publication
          // is complete. A markerless early-candidate record is pure history:
          // it cannot retry reports, but it also must not reserve an empty path
          // forever.
          claimsTarget = Boolean(marker);
        }
        if (claimsTarget)
          throw new Error("同一归档目标已经有登记任务，Kocpy 不会重复写入");
      }
      const nextTasks = [...this.tasks, task];
      // The durable candidate must succeed before it becomes the in-memory
      // authority. Registration shares the same short commit lock as later
      // checkpoints, so concurrent starts cannot replace the complete task
      // table with a stale snapshot.
      await this.dependencies.persist(structuredClone(nextTasks));
      this.tasks = nextTasks;
    });
    try {
      await this.createOwnedTarget(task);
      return await this.execute(task);
    } catch (error) {
      await this.interrupt(task, error);
      throw error;
    }
  }

  async resume(id: string) {
    const task = this.requireTask(id);
    if (task.legacyMigration)
      throw new Error(
        "升级前旧格式归档任务缺少 ctime 预检证据，不能安全恢复。请保留旧记录，并重新选择源与归档目标、重新预检后开始新任务。",
      );
    if (!["interrupted", "failed"].includes(task.status))
      throw new Error("该归档转存不处于可恢复状态");
    if (!task.targetCreated) await this.recoverUncommittedTarget(task);
    await this.assertRecoveryIdentity(task);
    try {
      return await this.execute(task, true);
    } catch (error) {
      await this.interrupt(task, error);
      throw error;
    }
  }

  async retryReports(id: string) {
    const task = this.requireTask(id);
    if (task.legacyMigration)
      throw new Error(
        "升级前旧格式归档记录仅作为只读证据保留，不能继续写入或重试报告；请重新预检并开始新任务。",
      );
    if (task.status !== "completed" || !task.reportSnapshot)
      throw new Error("只有数据校验已通过的归档转存才能重试报告");
    if (task.reportStatus === "generating")
      throw new Error("归档报告正在生成或恢复，请等待当前操作完成");
    if (task.reportStatus === "completed") {
      await this.finalizeCompletedMarker(task);
      throw new Error("该归档报告已经生成完成");
    }
    await this.assertCompletedTargetOwnership(task);
    this.startProgressPhase(task, "reporting");
    await this.generateReports(task);
    const reportCompleted = task.reportAttempts.at(-1)?.status === "completed";
    this.startProgressPhase(
      task,
      reportCompleted ? "completed" : "attention",
    );
    if (reportCompleted)
      await this.finalizeCompletedMarker(task);
    return structuredClone(task);
  }

  private async createOwnedTarget(task: ArchiveTransferTask) {
    await this.assertPlannedIdentity(task);
    const marker = JSON.stringify({
      schemaVersion: 1,
      taskId: task.id,
      sourcePath: task.sourcePath,
      finalPath: task.finalPath,
      inventoryDigest: task.inventory.digest,
      destinationIdentity: task.destinationIdentity,
    });
    await fs.writeFile(task.markerPath, marker, { flag: "wx", mode: 0o600 });
    try {
      await fs.mkdir(task.finalPath);
    } catch (error) {
      await fs.unlink(task.markerPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(`目标已存在，Kocpy 不会覆盖：${task.finalPath}`);
      throw error;
    }
    task.targetCreated = true;
    task.recoveryEvents.push({ at: this.now(), action: "exclusive-target-created" });
    await this.persist();
  }

  private async execute(task: ArchiveTransferTask, recovering = false) {
    if (this.running.has(task.id)) throw new Error("该归档转存正在运行");
    this.running.add(task.id);
    try {
      task.status = "running";
      task.startedAt ||= this.now();
      task.error = undefined;
      if (recovering)
        task.recoveryEvents.push({ at: this.now(), action: "resume-authorized" });
      await this.persist();
      this.startProgressPhase(task, "scanning");
      await this.assertRecoveryIdentity(task);
      const current = await inventoryDirectory(task.sourcePath);
      if (current.digest !== task.inventory.digest) throw new Error(SOURCE_CHANGED);
      const remaining = task.inventory.files
        .filter((item) => !item.verifiedAt)
        .reduce((sum, item) => sum + item.size, 0);
      if ((await this.dependencies.availableBytes(task.destinationParent)) < remaining)
        throw new Error("归档目标可用空间不足，已停止；释放空间后可恢复同一任务");
      this.checkpointFiles.set(task.id, task.completedFiles);

      for (const directory of task.inventory.directories)
        await bindArchiveTargetDirectory(task.finalPath, directory, true);

      this.startProgressPhase(task, "copying");
      for (const file of task.inventory.files) {
        await this.assertLiveIdentities(task);
        const source = safeTarget(task.sourcePath, file.relativePath),
          targetParent = await bindArchiveTargetParent(
            task.finalPath,
            file.relativePath,
            true,
          ),
          inspectedTarget = await inspectArchiveTargetFile(
            task.finalPath,
            file.relativePath,
            targetParent,
          ),
          target = inspectedTarget.target;
        task.currentFile = file.relativePath;
        this.updateProgress(
          task,
          task.verifiedBytes,
          0,
          file.size,
          true,
          task.completedFiles,
        );
        if (file.verifiedAt) {
          const [sourceHash, targetHash] = await Promise.all([
            fileSha256(source),
            fileSha256(target),
          ]).catch(() => {
            throw new Error(`已完成文件无法重新读取，已停止：${file.relativePath}`);
          });
          if (sourceHash !== file.sourceSha256 || targetHash !== file.targetSha256)
            throw new Error(`恢复核对发现已完成文件变化，已停止：${file.relativePath}`);
          this.updateProgress(
            task,
            task.verifiedBytes,
            file.size,
            file.size,
            true,
            task.completedFiles,
          );
          continue;
        }
        const existing = inspectedTarget.stat;
        if (existing) {
          if (!recovering)
            throw new Error(`目标出现未由本任务登记的同名文件，已停止：${file.relativePath}`);
          const [sourceHash, targetHash] = await Promise.all([
            fileSha256(source),
            fileSha256(target),
          ]);
          if (existing.size === file.size && sourceHash === targetHash) {
            file.sourceSha256 = sourceHash;
            file.targetSha256 = targetHash;
            file.verifiedAt = this.now();
            task.recoveryEvents.push({
              at: this.now(),
              action: "adopted-complete-interrupted-file",
              relativePath: file.relativePath,
            });
            this.recalculate(task);
            this.updateProgress(
              task,
              task.verifiedBytes,
              file.size,
              file.size,
              true,
              task.completedFiles,
            );
            await this.checkpoint(task);
            continue;
          }
          throw new Error(
            `目标出现无法证明归属或内容不完整的同名文件，Kocpy 未删除：${file.relativePath}。请人工核对并移走该文件后再恢复`,
          );
        }
        const sourceHash = await exclusiveCopyWithHash(
            source,
            target,
            file,
            targetParent,
            (processedBytes) =>
              this.updateProgress(
                task,
                task.verifiedBytes + processedBytes,
                processedBytes,
              ),
          ),
          targetHash = await fileSha256(target);
        if (sourceHash !== targetHash)
          throw new Error(`SHA-256 回读不一致，已停止：${file.relativePath}`);
        file.sourceSha256 = sourceHash;
        file.targetSha256 = targetHash;
        file.verifiedAt = this.now();
        this.recalculate(task);
        this.updateProgress(
          task,
          task.verifiedBytes,
          file.size,
          file.size,
          true,
          task.completedFiles,
        );
        await this.checkpoint(task);
      }

      task.status = "verifying";
      task.currentFile = undefined;
      this.startProgressPhase(task, "verifying");
      await this.persist();
      this.checkpointFiles.set(task.id, task.completedFiles);
      this.progress(task);
      await this.verifyWholePayload(task);
      const completedAt = this.now();
      task.completedAt = completedAt;
      task.status = "completed";
      task.error = undefined;
      task.reportSnapshot = {
        schemaVersion: 1,
        reportId: task.reportId,
        transferId: task.id,
        archiveName: task.archiveName,
        archiveNameSource: task.archiveNameSource,
        shootingDate: task.shootingDate || "未记录",
        payloadFileCount: task.inventory.totalFiles,
        payloadBytes: task.inventory.totalBytes,
        payloadHumanBytes: humanArchiveBytes(task.inventory.totalBytes),
        payloadEmptyDirectories: task.inventory.emptyDirectories.length,
        sourcePath: task.sourcePath,
        finalPath: task.finalPath,
        startedAt: task.startedAt!,
        completedAt,
        hashAlgorithm: "SHA-256",
        verificationConclusion: "通过",
        inventoryDigest: task.inventory.digest,
        historicalEvidence: task.historicalEvidence,
        evidenceBoundary:
          "本次结论只证明报告所列源快照与实际最终目标的相对路径、文件内容、精确字节数和空目录一致；不验证磁盘占用、ACL、扩展属性、权限及创建/修改时间戳。既有 PDF、MHL/XML 均作为原始 payload 原样复制，其历史异常没有被改写、接受或洗白。",
      };
      task.recoveryEvents.push({
        at: completedAt,
        action: "payload-independently-verified",
        detail: `${task.inventory.totalFiles} files / ${task.inventory.totalBytes} bytes`,
      });
      await this.persist();
      this.startProgressPhase(task, "reporting");
      await this.generateReports(task);
      this.startProgressPhase(
        task,
        task.reportStatus === "completed" ? "completed" : "attention",
      );
      if (task.reportStatus === "completed")
        await this.finalizeCompletedMarker(task);
      return structuredClone(task);
    } finally {
      this.running.delete(task.id);
      this.checkpointFiles.delete(task.id);
      this.liveProgress.delete(task.id);
    }
  }

  private async verifyWholePayload(task: ArchiveTransferTask) {
    const sourceInventory = await inventoryDirectory(task.sourcePath);
    if (sourceInventory.digest !== task.inventory.digest) throw new Error(SOURCE_CHANGED);
    const expectedFiles = new Set(task.inventory.files.map((file) => file.relativePath)),
      expectedDirectories = new Set(task.inventory.directories),
      assertStructure = (actual: ArchiveTransferInventory) => {
        const actualFiles = new Set(actual.files.map((file) => file.relativePath)),
          actualDirectories = new Set(actual.directories),
          extraFiles = actual.files.filter(
            (item) => !expectedFiles.has(item.relativePath),
          ),
          missingFiles = task.inventory.files.filter(
            (item) => !actualFiles.has(item.relativePath),
          ),
          extraDirectories = actual.directories.filter(
            (item) => !expectedDirectories.has(item),
          ),
          missingDirectories = task.inventory.directories.filter(
            (item) => !actualDirectories.has(item),
          );
        if (
          extraFiles.length ||
          missingFiles.length ||
          extraDirectories.length ||
          missingDirectories.length
        )
          throw new Error("目标路径、文件数或目录结构与源快照不一致，已停止");
        if (
          actual.totalFiles !== task.inventory.totalFiles ||
          actual.totalBytes !== task.inventory.totalBytes
        )
          throw new Error("目标文件数或精确字节数与源快照不一致，已停止");
      };
    assertStructure(await inventoryDirectory(task.finalPath));
    let phaseBytes = 0,
      phaseFiles = 0;
    for (const file of task.inventory.files) {
      await this.assertLiveIdentities(task);
      task.currentFile = file.relativePath;
      this.updateProgress(task, phaseBytes, 0, file.size, true, phaseFiles);
      const source = safeTarget(task.sourcePath, file.relativePath),
        targetParent = await bindArchiveTargetParent(
          task.finalPath,
          file.relativePath,
          false,
        ),
        target = (
          await inspectArchiveTargetFile(
            task.finalPath,
            file.relativePath,
            targetParent,
          )
        ).target,
        [sourceHash, targetHash] = await Promise.all([
          fileSha256(source),
          fileSha256(target, (processedBytes) =>
            this.updateProgress(
              task,
              phaseBytes + processedBytes,
              processedBytes,
              file.size,
            ),
          ),
        ]);
      if (
        !file.sourceSha256 ||
        sourceHash !== file.sourceSha256 ||
        targetHash !== file.targetSha256 ||
        sourceHash !== targetHash
      )
        throw new Error(`最终独立回读不一致，已停止：${file.relativePath}`);
      phaseBytes += file.size;
      phaseFiles++;
      this.updateProgress(
        task,
        phaseBytes,
        file.size,
        file.size,
        true,
        phaseFiles,
      );
    }
    task.currentFile = undefined;
    const [finalSourceInventory, finalTargetInventory] = await Promise.all([
      inventoryDirectory(task.sourcePath),
      inventoryDirectory(task.finalPath),
    ]);
    if (finalSourceInventory.digest !== task.inventory.digest)
      throw new Error(SOURCE_CHANGED);
    assertStructure(finalTargetInventory);
  }

  private async assertRecoveryIdentity(task: ArchiveTransferTask) {
    await this.assertBaseIdentityAndMarker(task);
    const targetReal = await fs.realpath(task.finalPath).catch(() => {
      throw new Error("原任务目标目录已离线或被移动，已安全停止");
    });
    if (targetReal !== task.finalPath)
      throw new Error("原任务目标目录现在通过别名指向其他位置，已安全停止");
  }

  private async assertBaseIdentityAndMarker(task: ArchiveTransferTask) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(task.id) ||
      task.markerPath !== markerPathFor(task) ||
      task.finalPath !==
        path.join(task.destinationParent, path.basename(task.sourcePath))
    )
      throw new Error("归档任务路径或恢复标记无效，Kocpy 不会继续写入");
    const [sourceReal, parentReal] = await Promise.all([
      canonicalDirectory(task.sourcePath, "原源文件夹"),
      canonicalDirectory(task.destinationParent, "原归档目标"),
    ]);
    if (sourceReal !== task.sourcePath || parentReal !== task.destinationParent)
      throw new Error("路径已通过别名或重挂载发生变化，已安全停止");
    assertDistinctRoots(sourceReal, parentReal, task.finalPath);
    await this.assertLiveIdentities(task);
    await this.assertOwnedMarker(task).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("恢复标记不存在，无法证明目标属于原中断任务；Kocpy 不会覆盖");
      throw error;
    });
  }

  private async assertOwnedMarker(task: ArchiveTransferTask) {
    const marker = await readArchiveMarker(task.markerPath);
    if (
      marker.schemaVersion !== 1 ||
      marker.taskId !== task.id ||
      marker.sourcePath !== task.sourcePath ||
      marker.finalPath !== task.finalPath ||
      marker.inventoryDigest !== task.inventory.digest ||
      !validateArchiveIdentity(marker.destinationIdentity) ||
      !sameIdentity(
        task.destinationIdentity,
        marker.destinationIdentity as VolumeIdentity,
      )
    )
      throw new Error("恢复标记与任务范围不一致，Kocpy 不会继续写入");
    return marker;
  }

  private async assertCompletedTargetOwnership(task: ArchiveTransferTask) {
    const [parentReal, targetReal] = await Promise.all([
      canonicalDirectory(task.destinationParent, "原归档目标"),
      canonicalDirectory(task.finalPath, "已校验归档目录"),
    ]);
    if (parentReal !== task.destinationParent || targetReal !== task.finalPath)
      throw new Error("归档目录已移动或通过别名指向其他位置，不能写入旧报告");
    assertDistinctRoots(task.sourcePath, parentReal, targetReal);
    const current = await this.dependencies.identifyVolume(parentReal).catch((error) => {
      throw new Error(`归档目标已离线，不能重试报告：${errorMessage(error)}`);
    });
    if (!sameIdentity(task.destinationIdentity, current))
      throw new Error("归档目标卷身份与原任务不一致，不能重试报告");
    await this.assertOwnedMarker(task).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error(
          "原任务所有权标记不存在，无法证明当前目录仍属于该任务；为避免写错位置，Kocpy 不会重试报告",
        );
      throw error;
    });
  }

  private async releaseOwnedMarker(task: ArchiveTransferTask) {
    if (task.status !== "completed" || task.reportStatus !== "completed")
      throw new Error("归档数据和报告尚未全部完成，不能释放任务所有权标记");
    await this.assertMarkerParentIdentity(task);
    await this.assertOwnedMarker(task);
    await (this.dependencies.removeFile || fs.unlink)(task.markerPath);
  }

  private async assertMarkerParentIdentity(task: ArchiveTransferTask) {
    const parentReal = await canonicalDirectory(
      task.destinationParent,
      "原归档目标",
    );
    if (parentReal !== task.destinationParent)
      throw new Error("归档目标通过别名或重挂载发生变化，不能清理任务标记");
    const current = await this.dependencies.identifyVolume(parentReal).catch((error) => {
      throw new Error(`归档目标已离线，不能清理任务标记：${errorMessage(error)}`);
    });
    if (!sameIdentity(task.destinationIdentity, current))
      throw new Error("归档目标卷身份与原任务不一致，不能清理任务标记");
  }

  private async finalizeCompletedMarker(task: ArchiveTransferTask) {
    let marker: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      // Only interpret ENOENT as "already released" after proving that the
      // original parent is online, canonical and still the recorded volume.
      await this.assertMarkerParentIdentity(task);
      marker = await fs.lstat(task.markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.deferCompletedMarkerCleanup(task, error);
        return;
      }
    }
    if (!marker) {
      if (task.error?.startsWith(MARKER_CLEANUP_FAILED)) {
        task.error = undefined;
        task.recoveryEvents.push({
          at: this.now(),
          action: "completed-target-marker-cleanup-confirmed",
        });
        await this.persist();
      }
      return;
    }
    try {
      await this.releaseOwnedMarker(task);
      if (task.error?.startsWith(MARKER_CLEANUP_FAILED)) {
        task.error = undefined;
        task.recoveryEvents.push({
          at: this.now(),
          action: "completed-target-marker-cleanup-recovered",
        });
        await this.persist();
      }
    } catch (error) {
      await this.deferCompletedMarkerCleanup(task, error);
    }
  }

  private async deferCompletedMarkerCleanup(
    task: ArchiveTransferTask,
    error: unknown,
  ) {
    const message = `${MARKER_CLEANUP_FAILED}：${errorMessage(error)}。Kocpy 会在下次启动时重试；数据与报告的校验结论不受影响。`;
    if (task.error === message) return;
    task.error = message;
    task.recoveryEvents.push({
      at: this.now(),
      action: "completed-target-marker-cleanup-deferred",
      detail: errorMessage(error),
    });
    await this.persist();
  }

  private async assertPlannedIdentity(task: ArchiveTransferTask) {
    if (
      task.markerPath !== markerPathFor(task) ||
      task.finalPath !==
        path.join(task.destinationParent, path.basename(task.sourcePath))
    )
      throw new Error("归档任务目标范围无效，已停止");
    const [sourceReal, parentReal] = await Promise.all([
      canonicalDirectory(task.sourcePath, "源文件夹"),
      canonicalDirectory(task.destinationParent, "归档目标父目录"),
    ]);
    if (sourceReal !== task.sourcePath || parentReal !== task.destinationParent)
      throw new Error("预检后路径通过别名或重挂载发生变化，已安全停止");
    assertDistinctRoots(sourceReal, parentReal, task.finalPath);
    await this.assertLiveIdentities(task);
    const existing = await fs.lstat(task.finalPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing)
      throw new Error(`目标已存在，Kocpy 不会覆盖：${task.finalPath}`);
  }

  private async recoverUncommittedTarget(task: ArchiveTransferTask) {
    const marker = await fs.lstat(task.markerPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!marker) {
      // Registration is already durable, but no external path was claimed.
      // Re-run the same identity and exclusivity checks used by a fresh start;
      // this keeps the original task ID while refusing any newly occupied path.
      await this.createOwnedTarget(task);
      task.recoveryEvents.push({
        at: this.now(),
        action: "recovered-before-target-creation",
      });
      await this.persist();
      return;
    }
    await this.assertBaseIdentityAndMarker(task);
    const existing = await fs.lstat(task.finalPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) await fs.mkdir(task.finalPath);
    else {
      if (!existing.isDirectory())
        throw new Error("原任务目标位置被其他项目占用，Kocpy 不会覆盖");
      if ((await fs.readdir(task.finalPath)).length)
        throw new Error(
          "目标在任务提交前出现未登记内容，无法证明归属，Kocpy 不会覆盖",
        );
    }
    task.targetCreated = true;
    task.recoveryEvents.push({
      at: this.now(),
      action: "recovered-exclusive-target-creation",
    });
    await this.persist();
  }

  private async assertLiveIdentities(task: ArchiveTransferTask) {
    const [source, destination] = await Promise.all([
      this.dependencies.identifyVolume(task.sourcePath),
      this.dependencies.identifyVolume(task.destinationParent),
    ]).catch((error) => {
      throw new Error(`卷已离线或身份不可读取，已安全停止：${errorMessage(error)}`);
    });
    if (!sameIdentity(task.sourceIdentity, source))
      throw new Error("源卷身份与预检记录不一致，已安全停止");
    if (!sameIdentity(task.destinationIdentity, destination))
      throw new Error("归档目标卷身份与预检记录不一致，可能是同名重挂载，已安全停止");
  }

  private async assertReportDestination(task: ArchiveTransferTask) {
    const parentReal = await canonicalDirectory(
      task.destinationParent,
      "原归档目标",
    );
    if (parentReal !== task.destinationParent)
      throw new Error("归档目标通过别名或重挂载发生变化，报告未写入");
    const current = await this.dependencies
      .identifyVolume(task.destinationParent)
      .catch((error) => {
        throw new Error(`归档目标已离线，报告未写入：${errorMessage(error)}`);
      });
    if (!sameIdentity(task.destinationIdentity, current))
      throw new Error("归档目标卷身份与转存记录不一致，报告未写入");
    const targetReal = await fs.realpath(task.finalPath).catch(() => {
      throw new Error("已校验的归档目标当前不可访问，报告未写入");
    });
    if (targetReal !== task.finalPath)
      throw new Error("已校验的归档目标现在指向其他位置，报告未写入");
  }

  private async prepareReportDirectory(
    task: ArchiveTransferTask,
    artifactReportId: string,
  ) {
    await this.assertReportDestination(task);
    const paths = archiveReportPaths(task, artifactReportId),
      existing = await fs.lstat(paths.reportRoot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error("Kocpy报告 位置不是安全的普通目录，报告未写入");
    if (!existing)
      await fs.mkdir(paths.reportRoot, { recursive: false, mode: 0o755 });
    await this.assertReportDirectory(task);
    return paths;
  }

  private async assertReportDirectory(task: ArchiveTransferTask) {
    await this.assertReportDestination(task);
    const reportRoot = archiveReportPaths(task, task.reportId).reportRoot,
      before = await fs.lstat(reportRoot).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error("Kocpy报告 目录不存在，报告未写入或接纳");
        throw error;
      });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("Kocpy报告 位置不是安全的普通目录，报告未写入或接纳");
    if ((await fs.realpath(reportRoot)) !== reportRoot)
      throw new Error("Kocpy报告 目录通过别名指向其他位置，报告未写入或接纳");
    const after = await fs.lstat(reportRoot);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new Error("Kocpy报告 目录在安全检查期间发生变化");
    await this.assertReportDestination(task);
    return { dev: after.dev, ino: after.ino };
  }

  private async verifyReportAttempt(
    task: ArchiveTransferTask,
    attempt: ArchiveTransferReportAttempt,
  ) {
    if (
      !attempt.pdfPath ||
      !attempt.pngPath ||
      !validSha256(attempt.pdfSha256) ||
      !validSha256(attempt.pngSha256) ||
      !Number.isSafeInteger(attempt.pdfBytes) ||
      attempt.pdfBytes! <= 0 ||
      !Number.isSafeInteger(attempt.pngBytes) ||
      attempt.pngBytes! <= 0
    )
      throw new Error("报告发布检查点缺少完整的路径或摘要证据");
    const expected = archiveReportPaths(task, attempt.artifactReportId);
    if (
      path.resolve(attempt.pdfPath) !== expected.pdfPath ||
      path.resolve(attempt.pngPath) !== expected.pngPath
    )
      throw new Error("报告发布检查点的目标路径无效");
    const directoryBefore = await this.assertReportDirectory(task);
    const [pdf, png] = await Promise.all([
      readArchiveReportEvidence(attempt.pdfPath),
      readArchiveReportEvidence(attempt.pngPath),
    ]);
    if (
      pdf.bytes !== attempt.pdfBytes ||
      png.bytes !== attempt.pngBytes ||
      pdf.sha256 !== attempt.pdfSha256 ||
      png.sha256 !== attempt.pngSha256
    )
      throw new Error("报告落盘回读与发布检查点不一致，未记录为完成");
    const directoryAfter = await this.assertReportDirectory(task);
    if (
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino
    )
      throw new Error("Kocpy报告 目录在回读期间发生变化");
  }

  private async reconcilePublishingReport(
    task: ArchiveTransferTask,
    attempt: ArchiveTransferReportAttempt,
  ) {
    try {
      await this.assertCompletedTargetOwnership(task);
      await this.verifyReportAttempt(task, attempt);
      attempt.status = "completed";
      attempt.completedAt = this.now();
      attempt.error = undefined;
      task.reportStatus = "completed";
      task.error = undefined;
      task.recoveryEvents.push({
        at: this.now(),
        action: "report-publishing-checkpoint-recovered",
        detail: attempt.artifactReportId,
      });
    } catch (error) {
      attempt.status = "failed";
      attempt.completedAt = this.now();
      attempt.error = `上次报告发布检查点未通过回读：${errorMessage(error)}`;
      task.reportStatus = "failed";
      task.error = `数据已校验，${attempt.error}。Kocpy 未覆盖任何现有文件，可显式重试并生成新的报告编号。`;
    }
  }

  private async generateReports(task: ArchiveTransferTask) {
    const snapshot = task.reportSnapshot!;
    task.reportStatus = "generating";
    const attemptNumber = task.reportAttempts.length + 1,
      artifactReportId =
        attemptNumber === 1 ? task.reportId : `${task.reportId}-R${attemptNumber}`,
      attempt: ArchiveTransferReportAttempt = {
        attempt: attemptNumber,
        artifactReportId,
        startedAt: this.now(),
        status: "running",
      };
    task.reportAttempts.push(attempt);
    await this.persist();
    try {
      await this.assertReportDestination(task);
      const rendered = await this.dependencies.renderReports(
          snapshot,
          artifactReportId,
        ),
        paths = archiveReportPaths(task, artifactReportId);
      if (
        !Buffer.isBuffer(rendered.pdf) ||
        !rendered.pdf.byteLength ||
        !Buffer.isBuffer(rendered.png) ||
        !rendered.png.byteLength
      )
        throw new Error("报告生成器没有返回完整的 PDF/PNG 字节");
      Object.assign(attempt, {
        pdfPath: paths.pdfPath,
        pngPath: paths.pngPath,
        pdfSha256: createHash("sha256").update(rendered.pdf).digest("hex"),
        pngSha256: createHash("sha256").update(rendered.png).digest("hex"),
        pdfBytes: rendered.pdf.byteLength,
        pngBytes: rendered.png.byteLength,
        status: "publishing" as const,
      });
      // Freeze exact targets and digests before the first external write. If
      // the process stops after publication, initialize() can adopt this same
      // attempt instead of producing an unreferenced R1 plus duplicate R2.
      await this.persist();
      const prepared = await this.prepareReportDirectory(task, artifactReportId);
      await publishNewArtifact(prepared.pdfPath, rendered.pdf);
      await publishNewArtifact(prepared.pngPath, rendered.png);
      await this.verifyReportAttempt(task, attempt);
      attempt.status = "completed";
      attempt.completedAt = this.now();
      task.reportStatus = "completed";
      task.error = undefined;
      task.recoveryEvents.push({
        at: this.now(),
        action: "reports-published",
        detail: artifactReportId,
      });
    } catch (error) {
      attempt.status = "failed";
      attempt.completedAt = this.now();
      attempt.error = errorMessage(error);
      task.reportStatus = "failed";
      task.error = `数据已校验，报告保存失败，可重试：${attempt.error}`;
    }
    // Deliberately outside the generation catch: if this exact final commit
    // fails, the preceding durable `publishing` checkpoint is recoverable.
    await this.persist();
  }

  private async interrupt(task: ArchiveTransferTask, error: unknown) {
    if (task.status === "completed") return;
    task.status = task.targetCreated ? "interrupted" : "failed";
    task.error = errorMessage(error);
    task.recoveryEvents.push({
      at: this.now(),
      action: "transfer-stopped",
      relativePath: task.currentFile,
      detail: task.error,
    });
    await this.persist();
    const live = this.liveProgress.get(task.id);
    if (live) live.phase = "attention";
    this.progress(task, true);
  }

  private recalculate(task: ArchiveTransferTask) {
    const completed = task.inventory.files.filter((file) => file.verifiedAt);
    task.completedFiles = completed.length;
    task.verifiedBytes = completed.reduce((sum, file) => sum + file.size, 0);
  }

  private startProgressPhase(
    task: ArchiveTransferTask,
    phase: ArchiveTransferProgress["phase"],
    currentFile?: string,
    currentFileTotalBytes = 0,
  ) {
    const now = this.now();
    const processedBytes =
      phase === "copying"
        ? task.verifiedBytes
        : phase === "completed"
          ? task.inventory.totalBytes
          : 0;
    this.liveProgress.set(task.id, {
      phase,
      phaseStartedAt: now,
      currentFile,
      currentFileBytes: 0,
      currentFileTotalBytes,
      processedBytes,
      phaseCompletedFiles:
        phase === "copying"
          ? task.completedFiles
          : ["reporting", "completed"].includes(phase)
            ? task.inventory.totalFiles
            : 0,
      lastSampleAt: now,
      lastSampleBytes: processedBytes,
      lastEmittedAt: 0,
      speedBps: 0,
    });
    this.progress(task, true);
  }

  private updateProgress(
    task: ArchiveTransferTask,
    processedBytes: number,
    currentFileBytes: number,
    currentFileTotalBytes = this.liveProgress.get(task.id)?.currentFileTotalBytes || 0,
    force = false,
    completedFiles = this.liveProgress.get(task.id)?.phaseCompletedFiles || 0,
  ) {
    const live = this.liveProgress.get(task.id);
    if (!live) return;
    const now = this.now(),
      elapsed = Math.max(0, now - live.lastSampleAt),
      delta = Math.max(0, processedBytes - live.lastSampleBytes);
    if (elapsed > 0 && delta > 0) {
      const instant = (delta * 1000) / elapsed;
      live.speedBps = live.speedBps ? live.speedBps * 0.7 + instant * 0.3 : instant;
      live.lastSampleAt = now;
      live.lastSampleBytes = processedBytes;
    }
    live.currentFile = task.currentFile;
    live.currentFileBytes = Math.max(0, Math.min(currentFileBytes, currentFileTotalBytes));
    live.currentFileTotalBytes = currentFileTotalBytes;
    live.processedBytes = Math.max(0, Math.min(processedBytes, task.inventory.totalBytes));
    live.phaseCompletedFiles = Math.max(
      0,
      Math.min(completedFiles, task.inventory.totalFiles),
    );
    this.progress(task, force);
  }

  private progress(task: ArchiveTransferTask, force = false) {
    const live = this.liveProgress.get(task.id),
      now = this.now();
    if (live && !force && now - live.lastEmittedAt < 250) return;
    if (live) live.lastEmittedAt = now;
    const elapsedMs = live ? Math.max(0, now - live.phaseStartedAt) : 0,
      measuresDataRate =
        live?.phase === "copying" || live?.phase === "verifying",
      averageSpeedBps =
        live && measuresDataRate && elapsedMs > 0
          ? (live.processedBytes * 1000) / elapsedMs
          : 0,
      speedBps = measuresDataRate ? live?.speedBps || averageSpeedBps : 0,
      remaining = measuresDataRate
        ? Math.max(
            0,
            task.inventory.totalBytes - (live?.processedBytes || 0),
          )
        : 0;
    const overallTotalBytes = task.inventory.totalBytes * 2,
      overallProcessedBytes = live
        ? live.phase === "copying"
          ? live.processedBytes
          : live.phase === "verifying"
            ? task.inventory.totalBytes + live.processedBytes
            : ["reporting", "completed"].includes(live.phase) ||
                task.status === "completed"
              ? overallTotalBytes
              : task.status === "verifying"
                ? task.inventory.totalBytes + live.processedBytes
                : live.processedBytes
        : task.status === "completed"
          ? overallTotalBytes
          : task.verifiedBytes;
    this.dependencies.onProgress?.({
      taskId: task.id,
      status: task.status,
      phase:
        live?.phase ||
        (task.status === "verifying"
          ? "verifying"
          : task.status === "completed"
            ? task.reportStatus === "completed"
              ? "completed"
              : "attention"
            : ["interrupted", "failed"].includes(task.status)
              ? "attention"
              : "copying"),
      currentFile: live?.currentFile || task.currentFile,
      currentFileBytes: live?.currentFileBytes || 0,
      currentFileTotalBytes: live?.currentFileTotalBytes || 0,
      overallProcessedBytes,
      overallTotalBytes,
      processedBytes: live?.processedBytes || task.verifiedBytes,
      completedFiles: live?.phaseCompletedFiles ?? task.completedFiles,
      totalFiles: task.inventory.totalFiles,
      verifiedBytes: task.verifiedBytes,
      totalBytes: task.inventory.totalBytes,
      speedBps,
      averageSpeedBps,
      elapsedMs,
      etaSeconds: speedBps > 0 ? Math.ceil(remaining / speedBps) : 0,
    });
  }

  private async checkpoint(task: ArchiveTransferTask) {
    const last = this.checkpointFiles.get(task.id) || 0;
    if (task.completedFiles - last < 64) return;
    await this.persist();
    this.checkpointFiles.set(task.id, task.completedFiles);
  }

  private requireTask(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error("归档转存任务不存在");
    return task;
  }

  private async persist() {
    await this.withStateCommit(async () => {
      await this.dependencies.persist(structuredClone(this.tasks));
    });
  }

  private async withStateCommit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.stateCommitTail;
    let release!: () => void;
    this.stateCommitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  private id() {
    return this.dependencies.randomId?.() ?? randomUUID();
  }
}

export const archiveTransferInternals = {
  inventoryDirectory,
  digestInventory,
  sameIdentity,
  safeTarget,
};
