import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { VolumeIdentity } from "../common/volume-identity";

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
  status: "running" | "completed" | "failed";
  pdfPath?: string;
  pngPath?: string;
  error?: string;
}

export interface ArchiveTransferTask extends ArchiveTransferContext {
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
  currentFile?: string;
  completedFiles: number;
  totalFiles: number;
  verifiedBytes: number;
  totalBytes: number;
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

export interface ArchiveTransferReportOutput {
  pdfPath: string;
  pngPath: string;
}

export interface ArchiveTransferDependencies {
  identifyVolume(location: string): Promise<VolumeIdentity>;
  availableBytes(location: string): Promise<number>;
  persist(tasks: ArchiveTransferTask[]): Promise<void>;
  renderReports(
    snapshot: ArchiveTransferReportSnapshot,
    artifactReportId: string,
  ): Promise<ArchiveTransferReportOutput>;
  onProgress?(progress: ArchiveTransferProgress): void;
  now?(): number;
  randomId?(): string;
}

const SOURCE_CHANGED = "源文件夹内容已变化，已安全停止；恢复原内容后重新预检";

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
        files: files.map(({ relativePath, size, mtimeMs, inode }) => ({
          relativePath,
          size,
          mtimeMs,
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

async function fileSha256(file: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function exclusiveCopyWithHash(
  source: string,
  destination: string,
  expected: ArchiveTransferInventoryFile,
) {
  const sourceHandle = await fs.open(source, "r");
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  let completed = false;
  try {
    destinationHandle = await fs.open(destination, "wx", 0o644);
    const before = await sourceHandle.stat();
    if (
      !before.isFile() ||
      before.size !== expected.size ||
      before.mtimeMs !== expected.mtimeMs ||
      before.ino !== expected.inode
    )
      throw new Error(SOURCE_CHANGED);
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
    }
    const after = await sourceHandle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    )
      throw new Error(SOURCE_CHANGED);
    await destinationHandle.sync();
    completed = true;
    return hash.digest("hex");
  } finally {
    await sourceHandle.close().catch(() => undefined);
    await destinationHandle?.close().catch(() => undefined);
    if (!completed) await fs.unlink(destination).catch(() => undefined);
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class ArchiveTransferManager {
  private tasks: ArchiveTransferTask[] = [];
  private running = new Set<string>();
  private checkpointFiles = new Map<string, number>();

  constructor(private readonly dependencies: ArchiveTransferDependencies) {}

  async initialize(tasks: ArchiveTransferTask[]) {
    this.tasks = structuredClone(tasks || []);
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
        task.reportStatus = "failed";
        const lastAttempt = task.reportAttempts.at(-1);
        if (lastAttempt) {
          lastAttempt.status = "failed";
          lastAttempt.error = "上次报告生成被中断，可单独重试";
        }
        task.error = "数据已校验，上次报告生成被中断，可单独重试";
        changed = true;
      }
    }
    if (changed) await this.persist();
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
      parent = await canonicalDirectory(destinationParent, "NAS 目标父目录"),
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
        `NAS 可用空间不足：需要至少 ${humanArchiveBytes(requiredBytes)}，当前 ${humanArchiveBytes(availableBytes)}`,
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
        "本次结论只证明预检快照内的相对路径、文件内容、精确字节数与空目录在实际 NAS 目标一致；不验证磁盘占用、ACL、扩展属性、权限及创建/修改时间戳，不证明历史拍摄没有遗漏，也不改变既有清单的异常结论。",
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
    this.tasks.push(task);
    await this.persist();
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
    if (task.status !== "completed" || !task.reportSnapshot)
      throw new Error("只有数据校验已通过的归档转存才能重试报告");
    if (task.reportStatus === "completed") throw new Error("该归档报告已经生成完成");
    await this.generateReports(task);
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
      await this.assertRecoveryIdentity(task);
      const current = await inventoryDirectory(task.sourcePath);
      if (current.digest !== task.inventory.digest) throw new Error(SOURCE_CHANGED);
      const remaining = task.inventory.files
        .filter((item) => !item.verifiedAt)
        .reduce((sum, item) => sum + item.size, 0);
      if ((await this.dependencies.availableBytes(task.destinationParent)) < remaining)
        throw new Error("NAS 可用空间不足，已停止；释放空间后可恢复同一任务");
      task.status = "running";
      task.startedAt ||= this.now();
      task.error = undefined;
      if (recovering)
        task.recoveryEvents.push({ at: this.now(), action: "resume-authorized" });
      await this.persist();
      this.checkpointFiles.set(task.id, task.completedFiles);

      for (const directory of task.inventory.directories)
        await fs.mkdir(safeTarget(task.finalPath, directory), { recursive: true });

      for (const file of task.inventory.files) {
        await this.assertLiveIdentities(task);
        const source = safeTarget(task.sourcePath, file.relativePath),
          target = safeTarget(task.finalPath, file.relativePath);
        task.currentFile = file.relativePath;
        this.progress(task);
        if (file.verifiedAt) {
          const [sourceHash, targetHash] = await Promise.all([
            fileSha256(source),
            fileSha256(target),
          ]).catch(() => {
            throw new Error(`已完成文件无法重新读取，已停止：${file.relativePath}`);
          });
          if (sourceHash !== file.sourceSha256 || targetHash !== file.targetSha256)
            throw new Error(`恢复核对发现已完成文件变化，已停止：${file.relativePath}`);
          continue;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        const existing = await fs.lstat(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (existing) {
          if (!recovering)
            throw new Error(`目标出现未由本任务登记的同名文件，已停止：${file.relativePath}`);
          if (!existing.isFile())
            throw new Error(`目标同名项目不是普通文件，已停止：${file.relativePath}`);
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
            await this.checkpoint(task);
            continue;
          }
          await fs.unlink(target);
          task.recoveryEvents.push({
            at: this.now(),
            action: "removed-owned-incomplete-file",
            relativePath: file.relativePath,
          });
        }
        const sourceHash = await exclusiveCopyWithHash(source, target, file),
          targetHash = await fileSha256(target);
        if (sourceHash !== targetHash)
          throw new Error(`SHA-256 回读不一致，已停止：${file.relativePath}`);
        file.sourceSha256 = sourceHash;
        file.targetSha256 = targetHash;
        file.verifiedAt = this.now();
        this.recalculate(task);
        await this.checkpoint(task);
        this.progress(task);
      }

      task.status = "verifying";
      task.currentFile = undefined;
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
      await fs.unlink(task.markerPath).catch(() => undefined);
      this.progress(task);
      await this.generateReports(task);
      return structuredClone(task);
    } finally {
      this.running.delete(task.id);
      this.checkpointFiles.delete(task.id);
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
    for (const file of task.inventory.files) {
      await this.assertLiveIdentities(task);
      const source = safeTarget(task.sourcePath, file.relativePath),
        target = safeTarget(task.finalPath, file.relativePath),
        [sourceHash, targetHash] = await Promise.all([
          fileSha256(source),
          fileSha256(target),
        ]);
      if (
        !file.sourceSha256 ||
        sourceHash !== file.sourceSha256 ||
        targetHash !== file.targetSha256 ||
        sourceHash !== targetHash
      )
        throw new Error(`最终独立回读不一致，已停止：${file.relativePath}`);
    }
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
      canonicalDirectory(task.destinationParent, "原 NAS 目标"),
    ]);
    if (sourceReal !== task.sourcePath || parentReal !== task.destinationParent)
      throw new Error("路径已通过别名或重挂载发生变化，已安全停止");
    assertDistinctRoots(sourceReal, parentReal, task.finalPath);
    await this.assertLiveIdentities(task);
    const marker = JSON.parse(await fs.readFile(task.markerPath, "utf8").catch(() => {
      throw new Error("恢复标记不存在，无法证明目标属于原中断任务；Kocpy 不会覆盖");
    }));
    if (
      marker.taskId !== task.id ||
      marker.finalPath !== task.finalPath ||
      marker.inventoryDigest !== task.inventory.digest
    )
      throw new Error("恢复标记与任务范围不一致，Kocpy 不会继续写入");
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
      canonicalDirectory(task.destinationParent, "NAS 目标父目录"),
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
      throw new Error("NAS 卷身份与预检记录不一致，可能是同名重挂载，已安全停止");
  }

  private async assertReportDestination(task: ArchiveTransferTask) {
    const parentReal = await canonicalDirectory(
      task.destinationParent,
      "原 NAS 目标",
    );
    if (parentReal !== task.destinationParent)
      throw new Error("NAS 目标通过别名或重挂载发生变化，报告未写入");
    const current = await this.dependencies
      .identifyVolume(task.destinationParent)
      .catch((error) => {
        throw new Error(`NAS 已离线，报告未写入：${errorMessage(error)}`);
      });
    if (!sameIdentity(task.destinationIdentity, current))
      throw new Error("NAS 卷身份与转存记录不一致，报告未写入");
    const targetReal = await fs.realpath(task.finalPath).catch(() => {
      throw new Error("已校验的 NAS 目标当前不可访问，报告未写入");
    });
    if (targetReal !== task.finalPath)
      throw new Error("已校验的 NAS 目标现在指向其他位置，报告未写入");
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
      const output = await this.dependencies.renderReports(snapshot, artifactReportId);
      Object.assign(attempt, {
        ...output,
        status: "completed" as const,
        completedAt: this.now(),
      });
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
    this.progress(task);
  }

  private recalculate(task: ArchiveTransferTask) {
    const completed = task.inventory.files.filter((file) => file.verifiedAt);
    task.completedFiles = completed.length;
    task.verifiedBytes = completed.reduce((sum, file) => sum + file.size, 0);
  }

  private progress(task: ArchiveTransferTask) {
    this.dependencies.onProgress?.({
      taskId: task.id,
      status: task.status,
      currentFile: task.currentFile,
      completedFiles: task.completedFiles,
      totalFiles: task.inventory.totalFiles,
      verifiedBytes: task.verifiedBytes,
      totalBytes: task.inventory.totalBytes,
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
    await this.dependencies.persist(structuredClone(this.tasks));
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
