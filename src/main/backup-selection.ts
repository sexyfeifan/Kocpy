import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { BackupTask, Destination, InventoryScopeSnapshot } from "./types";
import type { StorageEvidence } from "../common/copy-evidence";
import { copyEvidenceSummary } from "../common/copy-evidence";
import type { VolumeIdentity } from "../common/volume-identity";
import { compareVolumeIdentity } from "../common/volume-identity";
import { completeInventoryPolicy, inside, scan } from "./backup/safety";
import {
  validSelectionDate,
  conservativeSelectionFamilies,
  type BackupDateInspection,
  type BackupSelectionDecision,
  type BackupSelectionFile,
  type BackupSelectionGroup,
  type BackupSelectionHistoryEvidence,
  type BackupSelectionPlan,
  type BackupSelectionPreview,
  type BackupSelectionProgress,
} from "../common/backup-selection";

export type SelectionInventory = Awaited<ReturnType<typeof scan>>;
export interface BackupSelectionDependencies {
  identifyVolume: (absolutePath: string) => Promise<VolumeIdentity>;
  /** All returned records MUST come from one fresh topology observation. */
  assessStorage?: (absolutePaths: string[]) => Promise<StorageEvidence[]>;
  readEmbeddedDate?: (absolutePath: string) => Promise<string | undefined>;
  progress?: (progress: BackupSelectionProgress) => void;
  beforeRead?: () => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
}
export interface BackupSelectionInput {
  sourcePath: string;
  projectId?: string;
  requiredCopies?: number;
  historyTasks?: BackupTask[];
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const objectDigest = (value: BackupSelectionPreview | BackupSelectionPlan) => {
  const { digest: _digest, ...rest } = value;
  return digest(rest);
};
const now = (deps: BackupSelectionDependencies) => deps.now?.() ?? Date.now();
const mediaExtensions = new Set("mov mp4 mxf mts m2ts avi r3d braw crm ari cine wav bwf mp3 aac flac aif aiff arw cr2 cr3 nef nrw dng raf orf rw2 raw jpg jpeg heic tif tiff png".split(" "));
const sidecarExtensions = new Set("xml xmp lrf thm srt smi cue cpi bnp int".split(" "));
const extension = (file: string) => path.posix.extname(file).slice(1).toLowerCase();
const dateInText = (text: string) => [...text.matchAll(/(?<!\d)((?:19|20)\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?=\d{6}(?:\D|$)|\D|$)/g)]
  .map((match) => `${match[1]}-${match[2]}-${match[3]}`).filter(validSelectionDate);
const localDate = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const embeddedDate = (text?: string) => {
  if (!text) return undefined;
  const prefix = text.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").slice(0, 10);
  return validSelectionDate(prefix) ? prefix : undefined;
};

function sameVolume(expected: VolumeIdentity, actual: VolumeIdentity) {
  if (compareVolumeIdentity(expected.uuid, expected.id, actual) !== "match") return false;
  if (expected.mountSourceDigest && expected.mountSourceDigest !== actual.mountSourceDigest) return false;
  return true;
}
function stableStat(left: Stats, right: Stats) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function safeRelative(relative: string) {
  return relative.length > 0 && relative.length <= 4096 && !relative.includes("\0") && !relative.includes("\\") &&
    !path.posix.isAbsolute(relative) && path.posix.normalize(relative) === relative &&
    !relative.split("/").some((part) => part === "." || part === ".." || !part);
}
async function actualDirectory(root: string) {
  const resolved = path.resolve(root), stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(resolved) !== resolved)
    throw new Error("筛选素材必须选择实际目录，不能使用符号链接");
  return { root: resolved, stat };
}
/** Verify every intermediate directory rather than only the final O_NOFOLLOW file. */
async function containedFile(root: string, relativePath: string) {
  if (!safeRelative(relativePath)) throw new Error("筛选文件相对路径无效");
  await actualDirectory(root);
  const parts = relativePath.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const st = await fs.lstat(parent);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`素材目录发生变化：${relativePath}`);
  }
  const absolute = path.join(root, relativePath);
  if (!inside(absolute, root) || await fs.realpath(parent) !== parent) throw new Error("素材路径越出已确认目录");
  return absolute;
}

async function readHash(root: string, relativePath: string, deps: BackupSelectionDependencies,
  expected?: Pick<BackupSelectionFile, "size" | "mtimeMs" | "ctimeMs" | "dev" | "ino">,
  progress?: (bytes: number) => void): Promise<BackupSelectionFile> {
  deps.signal?.throwIfAborted();
  await deps.beforeRead?.();
  const absolute = await containedFile(root, relativePath), before = await fs.lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`素材文件不是实际文件：${relativePath}`);
  if (expected && (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs ||
    before.ctimeMs !== expected.ctimeMs || before.dev !== expected.dev || before.ino !== expected.ino))
    throw new Error(`素材预检后发生变化，请重新扫描：${relativePath}`);
  const handle = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!stableStat(before, await handle.stat())) throw new Error(`素材读取前发生变化：${relativePath}`);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      deps.signal?.throwIfAborted();
      await deps.beforeRead?.();
      const result = await handle.read(buffer, 0, buffer.length, offset);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead;
      progress?.(result.bytesRead);
    }
    if (offset !== before.size || !stableStat(before, await handle.stat()) ||
      !stableStat(before, await fs.lstat(await containedFile(root, relativePath))))
      throw new Error(`素材读取时发生变化，请重新扫描：${relativePath}`);
    return { relativePath, size: before.size, sha256: hash.digest("hex"), mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs, dev: before.dev, ino: before.ino };
  } finally { await handle.close(); }
}

async function assertSourceIdentity(preview: BackupSelectionPreview, deps: BackupSelectionDependencies) {
  const { root, stat } = await actualDirectory(preview.sourcePath);
  if (root !== preview.sourcePath || stat.dev !== preview.sourceRootBinding.dev || stat.ino !== preview.sourceRootBinding.ino ||
    !sameVolume(preview.sourceVolumeIdentity, await deps.identifyVolume(root)))
    throw new Error("素材源磁盘或目录已改变，请重新扫描并确认备份范围");
}

function physicalEvidence(evidence: StorageEvidence | undefined, volume: VolumeIdentity): evidence is StorageEvidence {
  return Boolean(evidence && evidence.kind === "local-physical" && evidence.assessmentId &&
    evidence.checkedAt > 0 && volume.uuid && evidence.volumeUuid?.toUpperCase() === volume.uuid.toUpperCase() &&
    evidence.domains.length > 0 && evidence.domains.length <= 16 && evidence.domains.every((domain) => /^disk\d+$/.test(domain)));
}
function separateFromSource(source: StorageEvidence, target: StorageEvidence) {
  return source.assessmentId === target.assessmentId && !target.domains.some((domain) => source.domains.includes(domain));
}
function countEvidence(evidence: BackupSelectionHistoryEvidence[]) {
  // Repeated backup attempts on the same volume do not inflate or invalidate its one copy.
  const unique = new Map<string, BackupSelectionHistoryEvidence>();
  for (const item of evidence) {
    const key = `${item.storageEvidence.assessmentId}:${item.volumeIdentity.uuid?.toUpperCase()}:${[...item.storageEvidence.domains].sort().join(",")}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return copyEvidenceSummary([...unique.values()].map((item) => ({ id: item.destinationId, path: item.root,
    label: "历史副本", verified: true, bytesWritten: item.size, volumeUuid: item.volumeIdentity.uuid,
    volumeId: item.volumeIdentity.id, storageEvidence: item.storageEvidence }) as Destination)).independentCopies;
}

/** Returns only online, independently stored, byte-identical historical files. */
async function historicalEvidence(input: BackupSelectionInput, preview: BackupSelectionPreview,
  deps: BackupSelectionDependencies) {
  const result = new Map<string, BackupSelectionHistoryEvidence[]>();
  if (!input.projectId || !deps.assessStorage) return result;
  const byHash = new Map<string, BackupSelectionFile[]>();
  for (const file of preview.sourceFiles) {
    const key = `${file.size}:${file.sha256}`;
    const matches = byHash.get(key) || []; matches.push(file); byHash.set(key, matches);
  }
  const candidates: Array<{ task: BackupTask; destination: Destination; root: string; relativePath: string; size: number; sha256: string; sourcePaths: string[] }> = [];
  for (const task of input.historyTasks || []) {
    if (task.projectId !== input.projectId || task.status !== "completed" || task.hashAlgorithm !== "sha256" ||
      !Array.isArray(task.fileRecords) || !Array.isArray(task.destinations)) continue;
    for (const record of task.fileRecords || []) {
      if (typeof record.srcChecksum !== "string" || !Array.isArray(record.destinations)) continue;
      const matches = byHash.get(`${record.size}:${record.srcChecksum.toLowerCase()}`);
      if (!matches) continue;
      for (let index = 0; index < task.destinations.length; index++) {
        const destination = task.destinations[index], fileResult = record.destinations[index], root = destination.resolvedPath || destination.path;
        if (!destination.verified || !destination.volumeUuid || !fileResult?.verified || typeof fileResult.checksum !== "string" ||
          fileResult.checksum.toLowerCase() !== record.srcChecksum.toLowerCase() || !path.isAbsolute(root) ||
          !path.isAbsolute(fileResult.path) || !inside(fileResult.path, root) ||
          inside(root, preview.sourcePath) || inside(preview.sourcePath, root)) continue;
        const relativePath = path.relative(root, fileResult.path);
        if (!safeRelative(relativePath)) continue;
        candidates.push({ task, destination, root, relativePath, size: record.size,
          sha256: record.srcChecksum.toLowerCase(), sourcePaths: matches.map((item) => item.relativePath) });
      }
    }
  }
  const roots = [...new Set(candidates.map((item) => item.root))];
  let topology: StorageEvidence[];
  try { topology = await deps.assessStorage([preview.sourcePath, ...roots]); }
  catch { deps.signal?.throwIfAborted(); return result; }
  const sourceStorage = topology[0];
  if (!physicalEvidence(sourceStorage, preview.sourceVolumeIdentity)) return result;
  let completedFiles = 0, completedBytes = 0;
  const totalBytes = candidates.reduce((sum, item) => sum + item.size, 0);
  const cache = new Map<string, BackupSelectionHistoryEvidence | undefined>();
  for (const item of candidates) {
    deps.signal?.throwIfAborted();
    const key = `${item.root}\0${item.relativePath}\0${item.sha256}`;
    let verified = cache.get(key);
    if (!cache.has(key)) {
      try {
        const identity = await deps.identifyVolume(item.root), storage = topology[roots.indexOf(item.root) + 1];
        if (compareVolumeIdentity(item.destination.volumeUuid, item.destination.volumeId, identity) !== "match" ||
          !physicalEvidence(storage, identity) || !separateFromSource(sourceStorage, storage)) throw new Error("历史副本身份或物理独立性不足");
        const file = await readHash(item.root, item.relativePath, deps);
        if (file.size !== item.size || file.sha256 !== item.sha256 || !sameVolume(identity, await deps.identifyVolume(item.root)))
          throw new Error("历史副本内容不匹配");
        verified = { taskId: item.task.id, destinationId: item.destination.id, relativePath: item.relativePath,
          path: path.join(item.root, item.relativePath), root: item.root, size: file.size, sha256: file.sha256,
          volumeIdentity: identity, storageEvidence: storage, checkedAt: now(deps) };
      } catch { deps.signal?.throwIfAborted(); verified = undefined; }
      cache.set(key, verified);
    }
    if (verified) for (const sourcePath of item.sourcePaths) {
      const values = result.get(sourcePath) || [];
      if (!values.some((value) => value.path === verified!.path)) values.push(verified);
      result.set(sourcePath, values);
    }
    completedFiles++; completedBytes += item.size;
    deps.progress?.({ phase: "history", currentFile: item.relativePath, completedFiles,
      totalFiles: candidates.length, completedBytes, totalBytes });
  }
  return result;
}

async function buildGroups(preview: BackupSelectionPreview, deps: BackupSelectionDependencies) {
  const byPath = new Map(preview.sourceFiles.map((file) => [file.relativePath, file]));
  const families = conservativeSelectionFamilies([...byPath.keys()], preview.sourcePath);
  const groups: BackupSelectionGroup[] = [];
  for (const familyGroup of families) {
    const family = familyGroup.relativePaths.map((relative) => byPath.get(relative)!);
    deps.signal?.throwIfAborted();
    const relativePaths = family.map((file) => file.relativePath).sort(), pathDates = new Set(relativePaths.flatMap(dateInText));
    const media = family.filter((file) => mediaExtensions.has(extension(file.relativePath))), embedded = new Set<string>();
    let unreadEmbedded = false, missingEmbedded = 0;
    for (const file of media) {
      deps.signal?.throwIfAborted();
      if (!deps.readEmbeddedDate) continue;
      try {
        const value = embeddedDate(await deps.readEmbeddedDate(await containedFile(preview.sourcePath, file.relativePath)));
        deps.signal?.throwIfAborted();
        if (value) embedded.add(value); else missingEmbedded++;
      } catch { deps.signal?.throwIfAborted(); unreadEmbedded = true; }
    }
    const modified = new Set(media.map((file) => localDate(file.mtimeMs)));
    if (media.length > 1 && embedded.size > 0 && missingEmbedded > 0) unreadEmbedded = true;
    const evidence: string[] = [];
    if (embedded.size) evidence.push(`媒体内嵌拍摄日期：${[...embedded].sort().join("、")}（设备时钟仍需核对）`);
    if (pathDates.size) evidence.push(`文件路径日期：${[...pathDates].sort().join("、")}`);
    if (modified.size) evidence.push(`文件修改日期：${[...modified].sort().join("、")}（低置信度）`);
    if (unreadEmbedded) evidence.push("部分内嵌拍摄时间不可读取，不能视为日期一致");
    let suggestedDate: string | undefined, basis: BackupSelectionGroup["basis"] = "unknown", confidence: BackupSelectionGroup["confidence"] = "unknown";
    const conflict = embedded.size > 1 || pathDates.size > 1 ||
      (embedded.size === 1 && pathDates.size === 1 && [...embedded][0] !== [...pathDates][0]);
    if (!conflict && embedded.size === 1) { suggestedDate = [...embedded][0]; basis = "embedded-media"; confidence = pathDates.size ? "high" : "review"; }
    else if (!conflict && pathDates.size === 1) { suggestedDate = [...pathDates][0]; basis = "path-date"; confidence = "review"; }
    else if (!conflict && modified.size === 1) { suggestedDate = [...modified][0]; basis = "file-modified-time"; confidence = "review"; }
    const packaged = familyGroup.packageProtected;
    const unknown = family.some((file) => !mediaExtensions.has(extension(file.relativePath)) && !sidecarExtensions.has(extension(file.relativePath)));
    const mandatoryReason = packaged ? "相机素材包无法安全拆分，整包保留" : familyGroup.protectionReason || (unknown ? "包含未知文件、共享索引或原始清单，保守保留" :
      !media.length ? "独立伴随文件缺少可靠归属，保留" : conflict || unreadEmbedded ? "日期冲突或不完整，保留关联素材组" : !suggestedDate ? "无法确定日期，保留" : undefined);
    if (mandatoryReason) evidence.push(mandatoryReason);
    if (new Set(relativePaths.map((item) => path.posix.dirname(item))).size > 1) evidence.push("跨目录同名素材及伴随文件作为一个关联组");
    groups.push({ id: digest(relativePaths), label: path.posix.basename(relativePaths[0]), relativePaths,
      files: family.length, bytes: family.reduce((sum, file) => sum + file.size, 0), suggestedDate,
      candidateDates: [...new Set([...embedded, ...pathDates, ...modified])].sort(), basis, confidence, evidence,
      mandatory: Boolean(mandatoryReason), mandatoryReason, historyState: "not-found", historyCopies: 0, historyEvidence: [] });
  }
  return groups.sort((left, right) => left.relativePaths[0].localeCompare(right.relativePaths[0]));
}

/** Lightweight advice only: this never authorizes exclusion or claims historical protection. */
export async function inspectBackupDates(input: Pick<BackupSelectionInput, "sourcePath">,
  deps: BackupSelectionDependencies): Promise<BackupDateInspection> {
  const { root, stat } = await actualDirectory(input.sourcePath);
  const inventory = await scan(root, completeInventoryPolicy(true, now(deps)), deps.signal);
  const preview: BackupSelectionPreview = { schemaVersion: 1, id: "date-inspection", sourcePath: root,
    requiredCopies: 1, generatedAt: now(deps), sourceScope: inventory.scope!,
    sourceVolumeIdentity: await deps.identifyVolume(root), sourceRootBinding: { dev: stat.dev, ino: stat.ino },
    sourceFiles: inventory.files.map((file) => ({ ...file, sha256: "", dev: 0, ino: 0 })), groups: [], digest: "" };
  const groups = await buildGroups(preview, deps);
  return { groups, dates: [...new Set(groups.map((group) => group.suggestedDate).filter((date): date is string => Boolean(date)))].sort(),
    unknownGroups: groups.filter((group) => !group.suggestedDate).length,
    sourceFiles: inventory.files.length, totalBytes: inventory.totalBytes };
}

export async function analyzeBackupSelection(input: BackupSelectionInput, deps: BackupSelectionDependencies): Promise<BackupSelectionPreview> {
  const { root, stat } = await actualDirectory(input.sourcePath), requiredCopies = input.requiredCopies ?? 1;
  if (!Number.isInteger(requiredCopies) || requiredCopies < 1 || requiredCopies > 4) throw new Error("项目独立副本要求无效");
  deps.progress?.({ phase: "scanning", completedFiles: 0, totalFiles: 0, completedBytes: 0, totalBytes: 0 });
  const identity = await deps.identifyVolume(root), inventory = await scan(root, completeInventoryPolicy(true, now(deps)), deps.signal);
  const preview: BackupSelectionPreview = { schemaVersion: 1, id: randomUUID(), sourcePath: root, projectId: input.projectId,
    requiredCopies, generatedAt: now(deps), sourceScope: inventory.scope!, sourceVolumeIdentity: structuredClone(identity),
    sourceRootBinding: { dev: stat.dev, ino: stat.ino }, sourceFiles: [], groups: [], digest: "" };
  let completedBytes = 0;
  for (const item of inventory.files) {
    const stat = await fs.lstat(item.absolutePath);
    if (item.size !== stat.size || item.mtimeMs !== stat.mtimeMs || item.ctimeMs !== stat.ctimeMs)
      throw new Error(`扫描后源素材发生变化：${item.relativePath}`);
    const file = await readHash(root, item.relativePath, deps, { ...item, dev: stat.dev, ino: stat.ino }, (bytes) => {
      completedBytes += bytes;
      deps.progress?.({ phase: "hashing", currentFile: item.relativePath, completedFiles: preview.sourceFiles.length,
        totalFiles: inventory.files.length, completedBytes, totalBytes: inventory.totalBytes });
    });
    preview.sourceFiles.push(file);
    deps.progress?.({ phase: "hashing", currentFile: item.relativePath, completedFiles: preview.sourceFiles.length,
      totalFiles: inventory.files.length, completedBytes, totalBytes: inventory.totalBytes });
  }
  preview.groups = await buildGroups(preview, deps);
  const history = await historicalEvidence(input, preview, deps);
  for (const group of preview.groups) {
    group.historyEvidence = group.relativePaths.flatMap((relative) => history.get(relative) || []);
    group.historyCopies = Math.min(...group.relativePaths.map((relative) => countEvidence(history.get(relative) || [])));
    group.historyState = group.historyCopies >= requiredCopies ? "verified" : group.historyEvidence.length ? "insufficient" :
      input.historyTasks?.some((task) => task.projectId === input.projectId) ? "unavailable" : "not-found";
  }
  await assertSourceIdentity(preview, deps);
  if ((await scan(root, preview.sourceScope.policy, deps.signal)).scope?.fingerprint !== preview.sourceScope.fingerprint)
    throw new Error("预检期间源素材范围发生变化，请重新扫描");
  preview.digest = objectDigest(preview);
  return preview;
}

async function validateSource(preview: BackupSelectionPreview, deps: BackupSelectionDependencies) {
  assertPreviewStructure(preview);
  deps.progress?.({ phase: "scanning", completedFiles: 0, totalFiles: preview.sourceFiles.length,
    completedBytes: 0, totalBytes: preview.sourceScope.includedBytes });
  await assertSourceIdentity(preview, deps);
  const inventory = await scan(preview.sourcePath, preview.sourceScope.policy, deps.signal);
  if (inventory.scope?.fingerprint !== preview.sourceScope.fingerprint || inventory.files.length !== preview.sourceFiles.length)
    throw new Error("源素材范围已改变，请重新扫描并确认");
  let completedBytes = 0, completedFiles = 0;
  for (const expected of preview.sourceFiles) {
    const actual = await readHash(preview.sourcePath, expected.relativePath, deps, expected, (bytes) => {
      completedBytes += bytes;
      deps.progress?.({ phase: "validating", currentFile: expected.relativePath, completedFiles,
        totalFiles: preview.sourceFiles.length, completedBytes, totalBytes: preview.sourceScope.includedBytes });
    });
    if (actual.sha256 !== expected.sha256) throw new Error(`源素材内容已改变，请重新扫描：${expected.relativePath}`);
    completedFiles++;
    deps.progress?.({ phase: "validating", currentFile: expected.relativePath, completedFiles,
      totalFiles: preview.sourceFiles.length, completedBytes, totalBytes: preview.sourceScope.includedBytes });
  }
  await assertSourceIdentity(preview, deps);
  if ((await scan(preview.sourcePath, preview.sourceScope.policy, deps.signal)).scope?.fingerprint !== preview.sourceScope.fingerprint)
    throw new Error("核对期间源素材范围发生变化，请重新扫描");
  return inventory;
}

async function revalidateHistory(plan: BackupSelectionPlan, deps: BackupSelectionDependencies) {
  const excluded = plan.excludedFiles.filter((item) => item.reason === "history-verified");
  if (!excluded.length) return;
  if (!deps.assessStorage) throw new Error("无法重新确认历史副本物理独立性，请重新预检或纳入备份");
  const roots = [...new Set(excluded.flatMap((file) => file.historyEvidence.map((item) => item.root)))];
  const storage = await deps.assessStorage([plan.sourcePath, ...roots]), source = storage[0];
  if (!physicalEvidence(source, plan.sourceVolumeIdentity)) throw new Error("源磁盘物理身份不可确认，请重新预检");
  const expectedFiles = new Map(plan.sourceFiles.map((file) => [file.relativePath, file]));
  const checked = new Map<string, BackupSelectionHistoryEvidence>();
  const unique = new Map(excluded.flatMap(file => file.historyEvidence).map(item => [`${item.path}\0${item.sha256}`, item]));
  const totalBytes = [...unique.values()].reduce((sum, item) => sum + item.size, 0);
  let completedBytes = 0;
  const report = (currentFile?: string) => deps.progress?.({ phase: "history", currentFile,
    completedFiles: checked.size, totalFiles: unique.size, completedBytes, totalBytes });
  report();
  for (const file of excluded) {
    const sourceFile = expectedFiles.get(file.relativePath), verified: BackupSelectionHistoryEvidence[] = [];
    for (const evidence of file.historyEvidence) {
      if (!sourceFile || evidence.sha256 !== sourceFile.sha256 || evidence.size !== sourceFile.size) throw new Error("历史副本依据与源文件不一致");
      const cacheKey = `${evidence.path}\0${evidence.sha256}`;
      let value = checked.get(cacheKey);
      if (!value) {
        const currentVolume = await deps.identifyVolume(evidence.root), topology = storage[roots.indexOf(evidence.root) + 1];
        if (!sameVolume(evidence.volumeIdentity, currentVolume) || !physicalEvidence(topology, currentVolume) || !separateFromSource(source, topology))
          throw new Error("历史副本离线或物理身份已改变，请重新预检或纳入备份");
        const current = await readHash(evidence.root, evidence.relativePath, deps, undefined, bytes => {
          completedBytes += bytes; report(evidence.relativePath);
        });
        if (current.sha256 !== evidence.sha256 || current.size !== evidence.size || !sameVolume(currentVolume, await deps.identifyVolume(evidence.root)))
          throw new Error("历史副本内容已经改变，不能跳过该素材");
        value = { ...evidence, storageEvidence: topology, checkedAt: now(deps) };
        checked.set(cacheKey, value);
        report(evidence.relativePath);
      }
      verified.push(value);
    }
    if (countEvidence(verified) < plan.requiredCopies) throw new Error("历史副本数量不足项目要求，不能跳过该素材");
  }
}

export async function finalizeBackupSelection(preview: BackupSelectionPreview, decision: BackupSelectionDecision,
  deps: BackupSelectionDependencies): Promise<BackupSelectionPlan> {
  if (!Array.isArray(decision.selectedDates) || !decision.selectedDates.every(validSelectionDate) ||
    !decision.operator?.trim() || decision.operator.trim().length > 120) throw new Error("请选择有效拍摄日期并填写确认人");
  const assignedDates = decision.assignedDates || {}, groupIds = new Set(preview.groups.map((group) => group.id));
  if (Object.entries(assignedDates).some(([id, date]) => !groupIds.has(id) || !validSelectionDate(date)))
    throw new Error("素材组的人工日期归属无效");
  await validateSource(preview, deps);
  const plan: BackupSelectionPlan = { ...structuredClone(preview), selectedDates: [...new Set(decision.selectedDates)].sort(),
    assignedDates: { ...assignedDates }, includedPaths: [], excludedFiles: [], confirmedAt: now(deps), operator: decision.operator.trim(), wholeCardCovered: false };
  const sourceFiles = new Map(plan.sourceFiles.map((file) => [file.relativePath, file]));
  for (const group of plan.groups) {
    const date = assignedDates[group.id] || group.suggestedDate;
    if (group.mandatory || !date || plan.selectedDates.includes(date)) { plan.includedPaths.push(...group.relativePaths); continue; }
    const history = Boolean(decision.skipVerifiedHistory && group.historyState === "verified" && group.historyCopies >= plan.requiredCopies);
    if (!history && !decision.allowUnprotectedExclusions)
      throw new Error("未选日期中有尚未证实历史副本的素材；请纳入备份，或明确确认这些素材本次未受保护");
    for (const relativePath of group.relativePaths) {
      const source = sourceFiles.get(relativePath)!;
      plan.excludedFiles.push({ relativePath, groupId: group.id, reason: history ? "history-verified" : "user-date",
        historyEvidence: history ? group.historyEvidence.filter((item) => item.sha256 === source.sha256 && item.size === source.size) : [] });
    }
  }
  plan.includedPaths.sort();
  if (!plan.includedPaths.length && preview.sourceFiles.length) throw new Error("本次没有选定可备份文件，请至少保留一组素材");
  plan.wholeCardCovered = !plan.excludedFiles.length && !plan.sourceScope.exclusions.some((item) => item.reason === "permission-denied");
  plan.digest = objectDigest(plan);
  assertBackupSelectionStructure(plan);
  await revalidateHistory(plan, deps);
  return plan;
}

export async function validateBackupSelectionPlan(plan: BackupSelectionPlan, deps: BackupSelectionDependencies): Promise<SelectionInventory> {
  assertBackupSelectionStructure(plan);
  const inventory = await validateSource(plan, deps);
  await revalidateHistory(plan, deps);
  return inventory;
}

function assertPreviewStructure(value: unknown): asserts value is BackupSelectionPreview {
  const fail = () => { throw new Error("备份筛选范围记录不完整或已被修改"); };
  if (!value || typeof value !== "object") return fail();
  const preview = value as BackupSelectionPreview;
  if (preview.schemaVersion !== 1 || typeof preview.id !== "string" || !preview.id ||
    typeof preview.sourcePath !== "string" || !path.isAbsolute(preview.sourcePath) || path.resolve(preview.sourcePath) !== preview.sourcePath || preview.sourcePath.includes("\0") ||
    (preview.projectId !== undefined && (typeof preview.projectId !== "string" || !preview.projectId)) ||
    !Number.isInteger(preview.requiredCopies) || preview.requiredCopies < 1 || preview.requiredCopies > 4 ||
    !Number.isFinite(preview.generatedAt) || preview.generatedAt <= 0 || !preview.sourceRootBinding ||
    !Number.isSafeInteger(preview.sourceRootBinding.dev) || !Number.isSafeInteger(preview.sourceRootBinding.ino) ||
    !preview.sourceVolumeIdentity || typeof preview.sourceVolumeIdentity.id !== "string" || !preview.sourceVolumeIdentity.id ||
    !preview.sourceScope || preview.sourceScope.sourcePath !== preview.sourcePath || preview.sourceScope.policy?.version !== "complete-v2" ||
    preview.sourceScope.policy.mode !== "complete" || !preview.sourceScope.policy.includeHidden ||
    !preview.sourceScope.policy.includeAppleDouble || !preview.sourceScope.policy.includeSystemMetadata ||
    preview.sourceScope.policy.includeEmptyDirectories !== true || preview.sourceScope.policy.symlinkPolicy !== "fail" || preview.sourceScope.policy.specialFilePolicy !== "fail" ||
    !/^[a-f0-9]{64}$/.test(preview.sourceScope.fingerprint) || !Array.isArray(preview.sourceScope.exclusions) ||
    !Array.isArray(preview.sourceScope.includedDirectoryPaths) ||
    preview.sourceScope.includedDirectoryPaths.some((relative) => !safeRelative(relative)) ||
    new Set(preview.sourceScope.includedDirectoryPaths).size !== preview.sourceScope.includedDirectoryPaths.length ||
    preview.sourceScope.includedDirectories !== preview.sourceScope.includedDirectoryPaths.length ||
    !Array.isArray(preview.sourceFiles) || !Array.isArray(preview.groups) || !/^[a-f0-9]{64}$/.test(preview.digest) ||
    preview.digest !== objectDigest(preview)) return fail();
  for (const item of preview.sourceScope.exclusions) {
    if (!item || typeof item.relativePath !== "string" || !safeRelative(item.relativePath) ||
      !["file", "directory"].includes(item.kind) || !["system-directory", "permission-denied"].includes(item.reason) ||
      !Number.isFinite(item.bytes) || item.bytes < 0 || !Number.isFinite(item.modifiedAt)) return fail();
  }
  const files = new Map<string, BackupSelectionFile>();
  const normalized = new Set<string>();
  for (const file of preview.sourceFiles) {
    if (!file || typeof file.relativePath !== "string" || !safeRelative(file.relativePath) || files.has(file.relativePath) ||
      normalized.has(file.relativePath.normalize("NFC")) || !Number.isSafeInteger(file.size) || file.size < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isFinite(file.mtimeMs) || !Number.isFinite(file.ctimeMs) ||
      !Number.isSafeInteger(file.dev) || !Number.isSafeInteger(file.ino)) return fail();
    files.set(file.relativePath, file); normalized.add(file.relativePath.normalize("NFC"));
  }
  if (files.size !== preview.sourceScope.includedFiles || [...files.values()].reduce((sum, file) => sum + file.size, 0) !== preview.sourceScope.includedBytes) return fail();
  const families = new Map(conservativeSelectionFamilies([...files.keys()], preview.sourcePath).map((family) => [digest(family.relativePaths), family]));
  const groupIds = new Set<string>();
  if (preview.groups.length !== families.size) return fail();
  for (const group of preview.groups) {
    if (!group || typeof group.id !== "string" || groupIds.has(group.id) || !Array.isArray(group.relativePaths) ||
      group.relativePaths.some((relative) => typeof relative !== "string" || !files.has(relative)) ||
      group.id !== digest(group.relativePaths) || !families.has(group.id) || typeof group.mandatory !== "boolean" ||
      (group.suggestedDate !== undefined && !validSelectionDate(group.suggestedDate)) ||
      !Array.isArray(group.candidateDates) || !group.candidateDates.every(validSelectionDate) ||
      !["high", "review", "unknown"].includes(group.confidence) ||
      !["embedded-media", "path-date", "file-modified-time", "user-confirmed", "unknown"].includes(group.basis) ||
      !Array.isArray(group.evidence) || !group.evidence.every((entry) => typeof entry === "string") ||
      !Array.isArray(group.historyEvidence) || !Number.isInteger(group.historyCopies) || group.historyCopies < 0 || group.historyCopies > 4 ||
      !["verified", "insufficient", "unavailable", "not-found"].includes(group.historyState) ||
      group.files !== group.relativePaths.length || group.bytes !== group.relativePaths.reduce((sum, relative) => sum + files.get(relative)!.size, 0)) return fail();
    const hasMedia = group.relativePaths.some((relative) => mediaExtensions.has(extension(relative)));
    const hasUnknown = group.relativePaths.some((relative) => !mediaExtensions.has(extension(relative)) && !sidecarExtensions.has(extension(relative)));
    if (!group.mandatory && (families.get(group.id)!.packageProtected || families.get(group.id)!.protectionReason || hasUnknown || !hasMedia || !group.suggestedDate || group.confidence === "unknown")) return fail();
    groupIds.add(group.id);
  }
}

/** Pure validation for persistence/import. It never reads or writes the original source. */
export function assertBackupSelectionStructure(value: unknown): asserts value is BackupSelectionPlan {
  assertPreviewStructure(value);
  const plan = value as BackupSelectionPlan;
  if (!Array.isArray(plan.includedPaths) || !Array.isArray(plan.excludedFiles) ||
    !Array.isArray(plan.selectedDates) || !plan.selectedDates.every(validSelectionDate) ||
    !plan.assignedDates || typeof plan.assignedDates !== "object" || Array.isArray(plan.assignedDates) ||
    Object.entries(plan.assignedDates).some(([id, date]) => !plan.groups.some((group) => group.id === id) || !validSelectionDate(date)) ||
    typeof plan.operator !== "string" || !plan.operator.trim() || plan.operator.length > 120 ||
    !Number.isFinite(plan.confirmedAt) || plan.confirmedAt < plan.generatedAt || typeof plan.wholeCardCovered !== "boolean")
    throw new Error("备份筛选确认记录无效");
  const all = new Set(plan.sourceFiles.map((file) => file.relativePath));
  const included = new Set(plan.includedPaths), excluded = new Set(plan.excludedFiles.map((file) => file.relativePath));
  if (plan.digest !== objectDigest(plan) || included.size !== plan.includedPaths.length || excluded.size !== plan.excludedFiles.length ||
    all.size !== plan.sourceFiles.length || included.size + excluded.size !== all.size ||
    [...included].some((file) => !all.has(file) || excluded.has(file)) || [...excluded].some((file) => !all.has(file)) ||
    plan.groups.some((group) => (group.mandatory && group.relativePaths.some((file) => !included.has(file))) ||
      (group.relativePaths.some((file) => included.has(file)) && group.relativePaths.some((file) => excluded.has(file)))))
    throw new Error("备份筛选范围与源文件记录不一致");
  const files = new Map(plan.sourceFiles.map((file) => [file.relativePath, file]));
  const groups = new Map(plan.groups.map((group) => [group.id, group]));
  const pathGroups = new Map(plan.groups.flatMap((group) => group.relativePaths.map((relative) => [relative, group.id] as const)));
  for (const item of plan.excludedFiles) {
    const group = groups.get(item.groupId), source = files.get(item.relativePath);
    if (!source || !group || pathGroups.get(item.relativePath) !== group.id || group.mandatory ||
      plan.selectedDates.includes(plan.assignedDates[group.id] || group.suggestedDate || "") ||
      !["user-date", "history-verified"].includes(item.reason) || !Array.isArray(item.historyEvidence))
      throw new Error("备份筛选排除记录无效");
    for (const evidence of item.historyEvidence) {
      if (!evidence || typeof evidence.root !== "string" || !path.isAbsolute(evidence.root) ||
        typeof evidence.relativePath !== "string" || !safeRelative(evidence.relativePath) ||
        evidence.path !== path.join(evidence.root, evidence.relativePath) ||
        inside(evidence.root, plan.sourcePath) || inside(plan.sourcePath, evidence.root) ||
        evidence.sha256 !== source.sha256 || evidence.size !== source.size ||
        !evidence.volumeIdentity || !physicalEvidence(evidence.storageEvidence, evidence.volumeIdentity) ||
        !Number.isFinite(evidence.checkedAt) || evidence.checkedAt <= 0)
        throw new Error("历史副本文件依据无效");
    }
    if ((item.reason === "history-verified" && countEvidence(item.historyEvidence) < plan.requiredCopies) ||
      (item.reason === "user-date" && item.historyEvidence.length)) throw new Error("历史副本数量依据不足");
  }
  if (plan.wholeCardCovered !== (!plan.excludedFiles.length && !plan.sourceScope.exclusions.some((item) => item.reason === "permission-denied")))
    throw new Error("整卡范围标记与筛选结果不一致");
}

export function backupSelectionScope(plan: BackupSelectionPlan): InventoryScopeSnapshot {
  assertBackupSelectionStructure(plan);
  const included = new Set(plan.includedPaths);
  return { ...structuredClone(plan.sourceScope), includedFiles: included.size,
    includedBytes: plan.sourceFiles.reduce((sum, file) => sum + (included.has(file.relativePath) ? file.size : 0), 0),
    fingerprint: digest({ original: plan.sourceScope.fingerprint, selection: plan.digest, included: plan.includedPaths }) };
}

/** The original scope remains on plan.sourceScope. Directory-only structure is retained. */
export function applyBackupSelectionInventory(inventory: SelectionInventory, plan: BackupSelectionPlan): SelectionInventory {
  assertBackupSelectionStructure(plan);
  if (inventory.scope?.sourcePath !== plan.sourcePath || inventory.scope?.fingerprint !== plan.sourceScope.fingerprint)
    throw new Error("当前扫描与已确认的完整素材范围不一致");
  const included = new Set(plan.includedPaths), files = inventory.files.filter((file) => included.has(file.relativePath));
  if (files.length !== included.size) throw new Error("选定文件已经缺失，请重新扫描");
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  return { ...inventory, files, totalBytes, scope: backupSelectionScope(plan) };
}
