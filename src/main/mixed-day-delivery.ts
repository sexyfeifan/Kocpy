import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  BackupTask,
  CardDateAllocationDecision,
  CardDateAllocationGroup,
  CardDateAllocationPlan,
  DailyDeliveryRun,
  FileRecord,
  HashAlgorithm,
} from "./types";
import { assertVolumeIdentity } from "../common/volume-identity";
import type { VolumeIdentity } from "../common/volume-identity";
import {
  canonical,
  inside,
  safeChild,
  segment,
  validatePaths,
} from "./backup/safety";
import { hashFile } from "./backup/BackupEngine";
import { XxHash32 } from "./backup/XxHash32";
import { driveInfo, volumeIdentity } from "./system";

const mediaForEmbeddedDate =
  /\.(mov|mp4|mxf|mkv|avi|m4v|mts|m2ts|jpg|jpeg|heic|tif|tiff|dng|arw|cr2|cr3|nef|wav|bwf|mp3|aac)$/i;

const xml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function validDate(value: string) {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]),
    date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function datesInText(value: string) {
  const values = new Set<string>();
  for (const match of value.matchAll(
    /(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?!\d)/g,
  )) {
    const candidate = `${match[1]}-${match[2]}-${match[3]}`;
    if (validDate(candidate)) values.add(candidate);
  }
  return [...values];
}

function dateFromTimestamp(value: string | undefined) {
  if (!value) return undefined;
  // Preserve the recorded calendar date instead of shifting it across midnight
  // according to the current workstation timezone. It remains a suggestion.
  const direct = value.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (!direct) return undefined;
  const candidate = `${direct[1]}-${direct[2]}-${direct[3]}`;
  return validDate(candidate) ? candidate : undefined;
}

function localDate(value: number) {
  const date = new Date(value),
    part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function clipFamily(relativePath: string) {
  const parsed = path.parse(relativePath.normalize("NFC"));
  const stem = parsed.name
    .replace(/\s*\(\d+\)$/i, "")
    .replace(/(?:[_\-.](?:proxy|prox|preview|thumb|thumbnail))$/i, "")
    .toLocaleLowerCase("en-US");
  // Be conservative: matching clip names in different camera directories are
  // not assumed to be related. A user can still assign both groups together.
  return `${parsed.dir.normalize("NFC").toLocaleLowerCase("en-US")}\0${stem || parsed.name.toLocaleLowerCase("en-US")}`;
}

function evidenceDigest(task: BackupTask) {
  const facts = task.fileRecords
    .map((record) => ({
      relativePath: record.relativePath.normalize("NFC"),
      size: record.size,
      checksum: record.srcChecksum,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

export function cardDateAllocationDigest(plan: CardDateAllocationPlan) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sourceTaskId: plan.sourceTaskId,
        sourceEvidenceDigest: plan.sourceEvidenceDigest,
        groups: plan.groups
          .map((group) => ({
            id: group.id,
            relativePaths: group.relativePaths,
            assignedDate: group.assignedDate || "",
            confirmedAt: group.confirmedAt || 0,
            confirmedBy: group.confirmedBy || "",
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      }),
    )
    .digest("hex");
}

function groupId(relativePaths: string[]) {
  return createHash("sha256")
    .update([...relativePaths].sort().join("\0"))
    .digest("hex")
    .slice(0, 24);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
) {
  const result = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        result[index] = await mapper(values[index]);
      }
    }),
  );
  return result;
}

async function verifiedSourceDestination(task: BackupTask, sourceRoot: string) {
  const root = await canonical(sourceRoot),
    candidates = await Promise.all(
      task.destinations.map(async (destination, index) => ({
        destination,
        index,
        resolved: destination.resolvedPath
          ? await canonical(destination.resolvedPath).catch(() => undefined)
          : undefined,
      })),
    ),
    match = candidates.find(
      (candidate) =>
        candidate.resolved === root &&
        candidate.destination.verified &&
        candidate.destination.resolvedPath,
    );
  if (!match)
    throw new Error("日期分析来源不再是任务中在线且校验通过的完整副本");
  const identity = await volumeIdentity(root);
  assertVolumeIdentity(
    match.destination.volumeUuid,
    match.destination.volumeId,
    identity,
    "完整素材卷副本",
  );
  return { root, destinationIndex: match.index };
}

async function verifiedRecordPath(
  task: BackupTask,
  root: string,
  destinationIndex: number,
  record: FileRecord,
) {
  const copy = record.destinations[destinationIndex];
  if (!copy?.verified)
    throw new Error(`完整副本未通过该文件校验：${record.relativePath}`);
  const absolute = await canonical(copy.path);
  if (!inside(absolute, root))
    throw new Error(`完整副本文件路径越出素材卷目录：${record.relativePath}`);
  const stat = await fs.stat(absolute);
  if (!stat.isFile() || stat.size !== record.size)
    throw new Error(`素材卷副本与记录不一致：${record.relativePath}`);
  const checksum = await hashFile(absolute, task.hashAlgorithm);
  if (checksum !== record.srcChecksum || checksum !== copy.checksum)
    throw new Error(`完整副本内容已偏离原始校验记录：${record.relativePath}`);
  return { absolute, stat };
}

/**
 * Build suggestions from a verified card record. Suggestions are never treated
 * as authoritative shooting dates until an operator explicitly confirms them.
 */
export async function buildCardDateAllocation(
  task: BackupTask,
  sourceRoot: string,
  options: {
    now?: number;
    readEmbeddedDate?: (absolutePath: string) => Promise<string | undefined>;
  } = {},
): Promise<CardDateAllocationPlan> {
  if (!task.fileRecords.length) throw new Error("该素材卷没有可分配的文件记录");
  const { root, destinationIndex } = await verifiedSourceDestination(
    task,
    sourceRoot,
  );
  if (!(await fs.stat(root)).isDirectory())
    throw new Error("素材卷副本目录不可用");
  const families = new Map<string, FileRecord[]>();
  for (const record of task.fileRecords) {
    const key = clipFamily(record.relativePath);
    families.set(key, [...(families.get(key) || []), record]);
  }
  const previous =
    task.dateAllocation?.sourceEvidenceDigest === evidenceDigest(task)
      ? new Map(task.dateAllocation.groups.map((group) => [group.id, group]))
      : new Map<string, CardDateAllocationGroup>();
  const groups = await mapWithConcurrency(
    [...families.values()].sort((left, right) =>
      left[0].relativePath.localeCompare(right[0].relativePath),
    ),
    4,
    async (records): Promise<CardDateAllocationGroup> => {
      const relativePaths = records
          .map((record) => record.relativePath)
          .sort((left, right) => left.localeCompare(right)),
        id = groupId(relativePaths),
        pathDates = new Set(relativePaths.flatMap(datesInText)),
        evidence: string[] = [],
        verified = new Map<string, ReturnType<typeof verifiedRecordPath>>(),
        readVerified = (record: FileRecord) => {
          let value = verified.get(record.relativePath);
          if (!value) {
            value = verifiedRecordPath(task, root, destinationIndex, record);
            verified.set(record.relativePath, value);
          }
          return value;
        };
      let embeddedDate: string | undefined;
      const media = records.find((record) =>
        mediaForEmbeddedDate.test(record.relativePath),
      );
      if (media && options.readEmbeddedDate) {
        const { absolute } = await readVerified(media);
        embeddedDate = dateFromTimestamp(
          await options.readEmbeddedDate(absolute).catch(() => undefined),
        );
        if (embeddedDate)
          evidence.push(`媒体内嵌日期建议：${embeddedDate}（仍需人工确认）`);
      }
      const modifiedDates = new Set<string>();
      for (const record of records) {
        const { stat } = await readVerified(record);
        modifiedDates.add(localDate(stat.mtimeMs));
      }
      if (pathDates.size === 1)
        evidence.push(`路径中出现日期：${[...pathDates][0]}`);
      if (pathDates.size > 1)
        evidence.push(`同组路径含多个日期：${[...pathDates].join("、")}`);
      if (modifiedDates.size === 1)
        evidence.push(`文件修改日期：${[...modifiedDates][0]}（低置信度）`);
      const pathDate = pathDates.size === 1 ? [...pathDates][0] : undefined,
        modifiedDate =
          modifiedDates.size === 1 ? [...modifiedDates][0] : undefined;
      let suggestedDate: string | undefined,
        suggestionBasis: CardDateAllocationGroup["suggestionBasis"] = "unknown",
        suggestionConfidence: CardDateAllocationGroup["suggestionConfidence"] =
          "unknown";
      if (embeddedDate && pathDate && embeddedDate === pathDate) {
        suggestedDate = embeddedDate;
        suggestionBasis = "embedded-media";
        suggestionConfidence = "high";
      } else if (embeddedDate && pathDate && embeddedDate !== pathDate) {
        evidence.push("内嵌日期与路径日期冲突，必须人工判定");
      } else if (embeddedDate) {
        suggestedDate = embeddedDate;
        suggestionBasis = "embedded-media";
        suggestionConfidence = "review";
      } else if (pathDate) {
        suggestedDate = pathDate;
        suggestionBasis = "path-date";
        suggestionConfidence = "review";
      } else if (modifiedDate) {
        suggestedDate = modifiedDate;
        suggestionBasis = "file-modified-time";
        suggestionConfidence = "review";
      }
      const prior = previous.get(id);
      return {
        id,
        label: path.basename(
          records[0].relativePath,
          path.extname(records[0].relativePath),
        ),
        relativePaths,
        files: records.length,
        bytes: records.reduce((sum, record) => sum + record.size, 0),
        suggestedDate,
        suggestionBasis,
        suggestionConfidence,
        evidence,
        assignedDate: prior?.assignedDate,
        confirmedAt: prior?.confirmedAt,
        confirmedBy: prior?.confirmedBy,
      };
    },
  );
  const now = options.now || Date.now();
  return {
    schemaVersion: 1,
    sourceTaskId: task.id,
    sourceEvidenceDigest: evidenceDigest(task),
    generatedAt: task.dateAllocation?.generatedAt || now,
    updatedAt: now,
    groups,
  };
}

export function applyCardDateAllocationDecisions(
  task: BackupTask,
  plan: CardDateAllocationPlan,
  decisions: CardDateAllocationDecision[],
  operator: string,
  now = Date.now(),
) {
  const actualOperator = operator.trim();
  if (!actualOperator) throw new Error("请填写实际确认人");
  if (
    plan.sourceTaskId !== task.id ||
    plan.sourceEvidenceDigest !== evidenceDigest(task)
  )
    throw new Error("素材卷文件记录已经变化，请重新分析日期归属");
  const byId = new Map(decisions.map((item) => [item.groupId, item]));
  if (byId.size !== decisions.length)
    throw new Error("日期归属决定存在重复项目");
  for (const decision of decisions) {
    if (!plan.groups.some((group) => group.id === decision.groupId))
      throw new Error("日期归属决定包含未知素材组");
    if (decision.shootingDate && !validDate(decision.shootingDate))
      throw new Error("拍摄日期无效");
  }
  const next: CardDateAllocationPlan = {
    ...plan,
    updatedAt: now,
    groups: plan.groups.map((group) => {
      const decision = byId.get(group.id);
      if (!decision) return group;
      return {
        ...group,
        assignedDate: decision.shootingDate || undefined,
        confirmedAt: now,
        confirmedBy: actualOperator,
      };
    }),
  };
  task.dateAllocation = next;
  return next;
}

function selectedRecords(
  task: BackupTask,
  plan: CardDateAllocationPlan,
  shootingDate: string,
) {
  if (!validDate(shootingDate)) throw new Error("请选择有效拍摄日期");
  if (
    plan.sourceTaskId !== task.id ||
    plan.sourceEvidenceDigest !== evidenceDigest(task)
  )
    throw new Error("日期归属依据已变化，请重新分析并确认");
  const paths = new Set(
    plan.groups
      .filter((group) => group.assignedDate === shootingDate)
      .flatMap((group) => group.relativePaths),
  );
  const records = task.fileRecords.filter((record) =>
    paths.has(record.relativePath),
  );
  if (!records.length) throw new Error("该拍摄日没有已确认归属的文件");
  if (records.length !== paths.size)
    throw new Error("日期归属包含已不存在的文件记录");
  return records;
}

function deliveryFolderName(task: BackupTask, shootingDate: string) {
  return segment(`${shootingDate.replace(/-/g, "")}_${task.name}_当日交付`);
}

export async function prepareDailyDeliveryRun(
  task: BackupTask,
  plan: CardDateAllocationPlan,
  input: {
    shootingDate: string;
    sourceDestinationId: string;
    destinationParent: string;
    operator: string;
    projectName?: string;
    now?: number;
  },
): Promise<DailyDeliveryRun> {
  const operator = input.operator.trim();
  if (!operator) throw new Error("请填写实际操作人");
  const sourceDestination = task.destinations.find(
    (destination) => destination.id === input.sourceDestinationId,
  );
  if (!sourceDestination?.verified || !sourceDestination.resolvedPath)
    throw new Error("请选择在线且校验通过的完整素材卷副本");
  const records = selectedRecords(task, plan, input.shootingDate);
  const { src, dests } = await validatePaths(sourceDestination.resolvedPath, [
      input.destinationParent,
    ]),
    destinationParent = dests[0],
    finalPath = path.join(
      destinationParent,
      deliveryFolderName(task, input.shootingDate),
    );
  const sourceIdentity = await volumeIdentity(src),
    destinationIdentity = await volumeIdentity(destinationParent),
    destinationParentBinding = await bindDeliveryDirectory(
      destinationParent,
      "交付目的地父目录",
    );
  assertVolumeIdentity(
    sourceDestination.volumeUuid,
    sourceDestination.volumeId,
    sourceIdentity,
    "完整素材卷副本",
  );
  const free = (await driveInfo(destinationParent)).free,
    totalBytes = records.reduce((sum, record) => sum + record.size, 0);
  if (free < totalBytes + Math.min(1024 ** 3, Math.ceil(totalBytes * 0.02)))
    throw new Error("交付目的地空间不足，已停止创建任务");
  return {
    id: randomUUID(),
    sourceTaskId: task.id,
    projectId: task.projectId,
    projectNameSnapshot: input.projectName,
    shootingDate: input.shootingDate,
    operator,
    createdAt: input.now || Date.now(),
    status: "pending",
    sourceDestinationId: sourceDestination.id,
    sourceRoot: src,
    sourceVolumeId: sourceIdentity.id,
    sourceVolumeUuid: sourceIdentity.uuid,
    sourceVolumeIdentity: sourceIdentity,
    destinationParent,
    finalPath,
    destinationVolumeId: destinationIdentity.id,
    destinationVolumeUuid: destinationIdentity.uuid,
    destinationVolumeIdentity: destinationIdentity,
    directoryBindings: {
      destinationParent: {
        dev: destinationParentBinding.dev,
        ino: destinationParentBinding.ino,
      },
      parents: {},
    },
    hashAlgorithm: "sha256",
    allocationDigest: cardDateAllocationDigest(plan),
    totalFiles: records.length,
    totalBytes,
    completedFiles: 0,
    completedBytes: 0,
    files: [],
  };
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r").catch((error) => {
    if (["EISDIR", "EINVAL", "ENOTSUP"].includes(error.code || ""))
      return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error) => {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code || ""))
        throw error;
    });
  } finally {
    await handle.close();
  }
}

interface BoundDeliveryFile {
  dev: number;
  ino: number;
  size: number;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface BoundDeliveryDirectory {
  path: string;
  dev: number;
  ino: number;
}

const deliveryFileBinding = (stat: Stats): BoundDeliveryFile => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  nlink: stat.nlink,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});

function sameDeliveryFileIdentity(
  left: BoundDeliveryFile,
  right: BoundDeliveryFile,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  );
}

function sameStableDeliveryFileBinding(
  left: BoundDeliveryFile,
  right: BoundDeliveryFile,
) {
  return (
    sameDeliveryFileIdentity(left, right) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.nlink === right.nlink
  );
}

function sameVolumeIdentity(expected: VolumeIdentity, actual: VolumeIdentity) {
  if (expected.uuid)
    return Boolean(
      actual.uuid && expected.uuid.toUpperCase() === actual.uuid.toUpperCase(),
    );
  return (
    expected.id === actual.id &&
    expected.device === actual.device &&
    expected.name === actual.name &&
    (expected.mountPoint || "") === (actual.mountPoint || "") &&
    (expected.fileSystem || "") === (actual.fileSystem || "") &&
    Boolean(
      expected.mountSourceDigest &&
        expected.mountSourceDigest === actual.mountSourceDigest,
    )
  );
}

function assertDailyDeliveryVolumeIdentity(
  expected: VolumeIdentity | undefined,
  expectedUuid: string | undefined,
  expectedId: string | undefined,
  actual: VolumeIdentity,
  label: string,
) {
  assertVolumeIdentity(expectedUuid, expectedId, actual, label);
  if (!expected)
    throw new Error(
      `${label}缺少完整磁盘身份快照，旧候选任务不能安全恢复；请保留现有内容并新建交付任务`,
    );
  if (!sameVolumeIdentity(expected, actual))
    throw new Error(
      `${label}完整磁盘身份与任务记录不一致，已安全停止；请检查原磁盘或网络挂载来源`,
    );
}

async function bindDeliveryDirectory(
  directory: string,
  label: string,
): Promise<BoundDeliveryDirectory> {
  const before = await fs.lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${label}不存在或已被替换，已停止写入`);
    throw error;
  });
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error(`${label}不是安全的真实目录，已停止写入`);
  if ((await fs.realpath(directory).catch(() => "")) !== directory)
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

async function assertBoundDeliveryDirectory(
  bound: BoundDeliveryDirectory,
  label: string,
) {
  const current = await bindDeliveryDirectory(bound.path, label);
  if (current.dev !== bound.dev || current.ino !== bound.ino)
    throw new Error(`${label}在操作期间被替换，已停止写入`);
  return current;
}

function sameDeliveryDirectoryBinding(
  left: { dev: number; ino: number } | undefined,
  right: { dev: number; ino: number } | undefined,
) {
  return Boolean(
    left && right && left.dev === right.dev && left.ino === right.ino,
  );
}

const recordedDeliveryDirectory = (bound: BoundDeliveryDirectory) => ({
  dev: bound.dev,
  ino: bound.ino,
});

function assertRecordedDeliveryDirectory(
  bound: BoundDeliveryDirectory,
  recorded: { dev: number; ino: number } | undefined,
  label: string,
) {
  if (!recorded)
    throw new Error(
      `${label}缺少持久化目录身份，旧候选任务不能安全恢复；请保留现有内容并新建交付任务`,
    );
  if (!sameDeliveryDirectoryBinding(bound, recorded))
    throw new Error(`${label}已被同名目录替换，已停止恢复或写入`);
}

async function assertDeliveryDirectoryVolume(
  run: DailyDeliveryRun,
  directory: BoundDeliveryDirectory,
  label: string,
) {
  const destinationParent = run.directoryBindings?.destinationParent;
  if (!destinationParent || directory.dev !== destinationParent.dev)
    throw new Error(`${label}进入了不同文件系统或嵌套挂载，已停止写入`);
}

async function assertDeliveryRootChain(
  run: DailyDeliveryRun,
  destinationParent: BoundDeliveryDirectory,
  finalPath: BoundDeliveryDirectory,
  mediaRoot?: BoundDeliveryDirectory,
) {
  await assertBoundDeliveryDirectory(destinationParent, "交付目的地父目录");
  await assertBoundDeliveryDirectory(finalPath, "当日交付最终目录");
  assertRecordedDeliveryDirectory(
    destinationParent,
    run.directoryBindings?.destinationParent,
    "交付目的地父目录",
  );
  assertRecordedDeliveryDirectory(
    finalPath,
    run.directoryBindings?.finalPath,
    "当日交付最终目录",
  );
  await assertDeliveryDirectoryVolume(run, destinationParent, "交付目的地");
  await assertDeliveryDirectoryVolume(run, finalPath, "当日交付最终目录");
  if (mediaRoot) {
    await assertBoundDeliveryDirectory(mediaRoot, "当日交付 Media 目录");
    assertRecordedDeliveryDirectory(
      mediaRoot,
      run.directoryBindings?.mediaRoot,
      "当日交付 Media 目录",
    );
    await assertDeliveryDirectoryVolume(run, mediaRoot, "当日交付 Media 目录");
  }
}

async function bindDeliveryTargetParent(
  run: DailyDeliveryRun,
  mediaRoot: BoundDeliveryDirectory,
  relativePath: string,
  createMissing: boolean,
  persistNewDirectory: (
    relativePath: string,
    binding: { dev: number; ino: number },
  ) => Promise<void>,
  allowRecoveryAdoption = false,
) {
  const parentRelative = path.posix.dirname(relativePath),
    parts = parentRelative === "." ? [] : parentRelative.split("/");
  let current = mediaRoot,
    currentRelative = "";
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.includes(path.sep))
      throw new Error(`当日交付目录路径无效：${relativePath}`);
    await assertBoundDeliveryDirectory(current, "当日交付文件父目录");
    const candidate = path.join(current.path, part);
    currentRelative = currentRelative
      ? `${currentRelative}/${part}`
      : part;
    let stat = await fs.lstat(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const recordedParents = run.directoryBindings?.parents,
      recorded =
        recordedParents &&
        Object.prototype.hasOwnProperty.call(recordedParents, currentRelative)
          ? recordedParents[currentRelative]
          : undefined;
    if (!stat) {
      if (!createMissing)
        throw new Error(`当日交付文件父目录缺失：${currentRelative}`);
      if (recorded)
        throw new Error(`已记录的当日交付父目录缺失：${currentRelative}`);
      await fs.mkdir(candidate, { recursive: false, mode: 0o755 });
      stat = await fs.lstat(candidate);
    } else if (!recorded) {
      if (!allowRecoveryAdoption)
        throw new Error(
          `当日交付父目录已存在但没有持久化身份，已安全停止：${currentRelative}`,
        );
      if ((await fs.readdir(candidate)).length)
        throw new Error(
          `当日交付父目录存在未登记内容，不能作为中断恢复目录：${currentRelative}`,
        );
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `当日交付父链包含符号链接、别名或非目录条目：${currentRelative}`,
      );
    await assertBoundDeliveryDirectory(current, "当日交付文件父目录");
    const next = await bindDeliveryDirectory(candidate, "当日交付文件子目录");
    await assertDeliveryDirectoryVolume(run, next, "当日交付文件子目录");
    if (recorded) {
      assertRecordedDeliveryDirectory(
        next,
        recorded,
        `当日交付父目录 ${currentRelative}`,
      );
    } else {
      run.directoryBindings!.parents ||= Object.create(null) as Record<
        string,
        { dev: number; ino: number }
      >;
      const recordedBinding = recordedDeliveryDirectory(next);
      Object.defineProperty(run.directoryBindings!.parents, currentRelative, {
        value: recordedBinding,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      await persistNewDirectory(currentRelative, recordedBinding);
      await assertBoundDeliveryDirectory(next, "新建的当日交付文件子目录");
    }
    current = next;
  }
  return current;
}

async function readBoundDeliveryFile(
  file: string,
  label: string,
  onChunk?: (chunk: Buffer) => void,
  parent?: BoundDeliveryDirectory,
  maxBytes?: number,
) {
  if (parent) await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
  const pathBefore = await fs.lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!pathBefore) return undefined;
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink())
    throw new Error(`${label}不是安全的普通文件，已停止恢复或发布`);

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
  } catch {
    throw new Error(`${label}不可安全打开，已停止恢复或发布`);
  }
  try {
    const before = await handle.stat(),
      beforeBinding = deliveryFileBinding(before);
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino
    )
      throw new Error(`${label}在打开前被替换，已停止恢复或发布`);
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        beforeBinding.size > maxBytes)
    )
      throw new Error(`${label}超过安全读取上限，已停止恢复或发布`);

    if (onChunk) {
      const buffer = Buffer.allocUnsafe(
        Math.min(4 * 1024 * 1024, maxBytes || 4 * 1024 * 1024),
      );
      let position = 0;
      while (position < beforeBinding.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, beforeBinding.size - position),
          position,
        );
        if (!bytesRead) break;
        onChunk(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    }

    const after = await handle.stat(),
      pathAfter = await fs.lstat(file),
      afterBinding = deliveryFileBinding(after),
      pathAfterBinding = deliveryFileBinding(pathAfter);
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameStableDeliveryFileBinding(beforeBinding, afterBinding) ||
      !sameStableDeliveryFileBinding(afterBinding, pathAfterBinding)
    )
      throw new Error(`${label}在读取期间发生变化，已停止恢复或发布`);
    if (parent)
      await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
    return afterBinding;
  } finally {
    await handle.close();
  }
}

async function hashBoundDeliveryFile(
  file: string,
  label: string,
  parent?: BoundDeliveryDirectory,
) {
  const digest = createHash("sha256"),
    binding = await readBoundDeliveryFile(
      file,
      label,
      (chunk) => digest.update(chunk),
      parent,
    );
  return binding
    ? { binding, sha256: digest.digest("hex") }
    : undefined;
}

async function readBoundDeliveryBuffer(
  file: string,
  label: string,
  parent?: BoundDeliveryDirectory,
  maxBytes?: number,
) {
  const chunks: Buffer[] = [],
    binding = await readBoundDeliveryFile(
      file,
      label,
      (chunk) => chunks.push(Buffer.from(chunk)),
      parent,
      maxBytes,
    );
  if (!binding) return undefined;
  if (binding.nlink !== 1)
    throw new Error(`${label}存在额外硬链接，已停止读取`);
  return { binding, bytes: Buffer.concat(chunks) };
}

function assertIndependentDeliveryFile(
  binding: BoundDeliveryFile,
  source: BoundDeliveryFile,
  label: string,
) {
  if (binding.nlink !== 1)
    throw new Error(`${label}存在额外硬链接，不能作为独立交付文件`);
  if (binding.dev === source.dev && binding.ino === source.ino)
    throw new Error(`${label}与完整素材卷源文件共用同一 inode，不能作为独立交付文件`);
}

async function syncBoundDeliveryFile(
  file: string,
  expected: BoundDeliveryFile,
  label: string,
  parent?: BoundDeliveryDirectory,
) {
  if (parent) await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      file,
      constants.O_RDWR | (constants.O_NOFOLLOW || 0),
    );
  } catch {
    throw new Error(`${label}不可安全同步，已停止发布`);
  }
  try {
    const before = deliveryFileBinding(await handle.stat());
    if (!sameStableDeliveryFileBinding(before, expected))
      throw new Error(`${label}在同步前发生变化，已停止发布`);
    await handle.sync();
    const after = deliveryFileBinding(await handle.stat()),
      pathAfter = await fs.lstat(file);
    if (
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameStableDeliveryFileBinding(after, expected) ||
      !sameStableDeliveryFileBinding(deliveryFileBinding(pathAfter), expected)
    )
      throw new Error(`${label}在同步期间发生变化，已停止发布`);
    if (parent)
      await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
  } finally {
    await handle.close();
  }
}

async function unlinkBoundDeliveryFile(
  file: string,
  expected: BoundDeliveryFile,
  label: string,
  parent?: BoundDeliveryDirectory,
) {
  const current = await readBoundDeliveryFile(file, label, undefined, parent);
  if (!current || !sameStableDeliveryFileBinding(current, expected))
    throw new Error(`${label}在清理前发生变化，Kocpy 未删除`);
  if (parent) await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
  await fs.unlink(file);
  if (parent) await assertBoundDeliveryDirectory(parent, `${label}所在目录`);
  await syncDirectory(parent?.path || path.dirname(file));
}

async function copyBoundDeliveryFileExclusive(
  staging: string,
  finalPath: string,
  expectedStaging: BoundDeliveryFile,
  parent: BoundDeliveryDirectory,
) {
  await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");
  const sourceHandle = await fs.open(
    staging,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  let destinationHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const sourceBefore = deliveryFileBinding(await sourceHandle.stat());
    if (!sameStableDeliveryFileBinding(sourceBefore, expectedStaging))
      throw new Error("当日交付临时文件在复制发布前发生变化");
    destinationHandle = await fs.open(
      finalPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o644,
    );
    const destinationBefore = await destinationHandle.stat();
    if (!destinationBefore.isFile() || destinationBefore.nlink !== 1)
      throw new Error("当日交付发布目标不是独立普通文件");
    await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    while (offset < sourceBefore.size) {
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, sourceBefore.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error("当日交付临时文件在复制发布期间缩短");
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        if (!result.bytesWritten) throw new Error("当日交付发布写入中断");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    const sourceAfter = deliveryFileBinding(await sourceHandle.stat());
    if (!sameStableDeliveryFileBinding(sourceBefore, sourceAfter))
      throw new Error("当日交付临时文件在复制发布期间发生变化");
    await destinationHandle.sync();
    await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");
    return deliveryFileBinding(await destinationHandle.stat());
  } finally {
    await sourceHandle.close();
    await destinationHandle?.close();
  }
}

async function publishDeliveryExclusive(
  staging: string,
  finalPath: string,
  expectedStaging: BoundDeliveryFile,
  source: BoundDeliveryFile,
  parent: BoundDeliveryDirectory,
  afterPublished?: () => Promise<void> | void,
) {
  const stagingBefore = await readBoundDeliveryFile(
    staging,
    "当日交付临时文件",
    undefined,
    parent,
  );
  if (
    !stagingBefore ||
    !sameStableDeliveryFileBinding(stagingBefore, expectedStaging)
  )
    throw new Error("当日交付临时文件在发布前发生变化，已停止发布");
  assertIndependentDeliveryFile(
    stagingBefore,
    source,
    "当日交付临时文件",
  );

  let linked = false;
  let copiedBinding: BoundDeliveryFile | undefined;
  await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");
  try {
    await fs.link(staging, finalPath);
    linked = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    if (
      ![
        "EXDEV",
        "EPERM",
        "EACCES",
        "EINVAL",
        "ENOTSUP",
        "EOPNOTSUPP",
      ].includes(code || "")
    )
      throw error;
    copiedBinding = await copyBoundDeliveryFileExclusive(
      staging,
      finalPath,
      expectedStaging,
      parent,
    );
  }
  await afterPublished?.();
  await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");

  const stagingAfter = await readBoundDeliveryFile(
      staging,
      "当日交付临时文件",
      undefined,
      parent,
    ),
    published = await readBoundDeliveryFile(
      finalPath,
      "当日交付发布文件",
      undefined,
      parent,
    );
  if (!stagingAfter || !published)
    throw new Error("当日交付文件在发布期间发生变化，已停止接纳");
  if (linked) {
    if (
      !sameDeliveryFileIdentity(stagingAfter, expectedStaging) ||
      !sameStableDeliveryFileBinding(stagingAfter, published) ||
      stagingAfter.nlink !== 2 ||
      published.nlink !== 2
    )
      throw new Error("当日交付硬链接发布身份异常，已停止接纳");
  } else {
    if (
      !sameStableDeliveryFileBinding(stagingAfter, expectedStaging) ||
      !copiedBinding ||
      !sameStableDeliveryFileBinding(published, copiedBinding)
    )
      throw new Error("当日交付复制发布身份异常，已停止接纳");
    assertIndependentDeliveryFile(
      stagingAfter,
      source,
      "当日交付临时文件",
    );
    assertIndependentDeliveryFile(
      published,
      source,
      "当日交付发布文件",
    );
  }
  await syncBoundDeliveryFile(finalPath, published, "当日交付发布文件", parent);
  await unlinkBoundDeliveryFile(
    staging,
    stagingAfter,
    "当日交付临时文件",
    parent,
  );

  const finalEvidence = await readBoundDeliveryFile(
    finalPath,
    "当日交付发布文件",
    undefined,
    parent,
  );
  if (
    !finalEvidence ||
    !sameDeliveryFileIdentity(finalEvidence, published)
  )
    throw new Error("当日交付发布文件在清理临时文件后发生变化");
  assertIndependentDeliveryFile(
    finalEvidence,
    source,
    "当日交付发布文件",
  );
  await assertBoundDeliveryDirectory(parent, "当日交付文件目标父目录");
  await syncDirectory(parent.path);
  return finalEvidence;
}

async function preserveGeneratedArtifact(
  file: string,
  run: DailyDeliveryRun,
  reason: "incomplete" | "invalid",
  parent: BoundDeliveryDirectory,
  finalDirectory: BoundDeliveryDirectory,
  persistRecoveryDirectory: (
    binding: { dev: number; ino: number },
  ) => Promise<void>,
) {
  const before = await readBoundDeliveryFile(
    file,
    "待保留的当日交付文件",
    undefined,
    parent,
  );
  if (!before || before.nlink !== 1)
    throw new Error("待保留的当日交付文件不是独立普通文件，Kocpy 未移动");
  const recoveryDirectoryPath = path.join(
    run.finalPath,
    `Kocpy恢复-${run.id}`,
  );
  let recoveryDirectory: BoundDeliveryDirectory;
  const recoveryStat = await fs.lstat(recoveryDirectoryPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (recoveryStat) {
    recoveryDirectory = await bindDeliveryDirectory(
      recoveryDirectoryPath,
      "当日交付异常文件恢复目录",
    );
    if (run.directoryBindings?.recoveryDirectory) {
      assertRecordedDeliveryDirectory(
        recoveryDirectory,
        run.directoryBindings.recoveryDirectory,
        "当日交付异常文件恢复目录",
      );
    } else {
      if ((await fs.readdir(recoveryDirectoryPath)).length)
        throw new Error("当日交付异常文件恢复目录存在未登记内容，已停止移动");
      run.directoryBindings!.recoveryDirectory =
        recordedDeliveryDirectory(recoveryDirectory);
      await persistRecoveryDirectory(
        run.directoryBindings!.recoveryDirectory,
      );
    }
  } else {
    if (run.directoryBindings?.recoveryDirectory)
      throw new Error("已记录的当日交付异常文件恢复目录缺失");
    await assertBoundDeliveryDirectory(finalDirectory, "当日交付最终目录");
    await fs.mkdir(recoveryDirectoryPath, { recursive: false, mode: 0o700 });
    recoveryDirectory = await bindDeliveryDirectory(
      recoveryDirectoryPath,
      "当日交付异常文件恢复目录",
    );
    await assertDeliveryDirectoryVolume(
      run,
      recoveryDirectory,
      "当日交付异常文件恢复目录",
    );
    run.directoryBindings!.recoveryDirectory =
      recordedDeliveryDirectory(recoveryDirectory);
    await persistRecoveryDirectory(run.directoryBindings!.recoveryDirectory);
  }
  await assertDeliveryDirectoryVolume(
    run,
    recoveryDirectory,
    "当日交付异常文件恢复目录",
  );
  const mediaRoot = path.join(run.finalPath, "Media"),
    relative = path.relative(mediaRoot, file).split(path.sep).join("/"),
    relativeDigest = createHash("sha256")
      .update(relative)
      .digest("hex")
      .slice(0, 16),
    preserved = path.join(
      recoveryDirectoryPath,
      `${path.basename(file)}.${relativeDigest}.${reason}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
  if (!safeDeliveryRelativePath(relative) || !inside(file, mediaRoot))
    throw new Error("待保留的当日交付文件越出 Media 范围，Kocpy 未移动");
  await assertBoundDeliveryDirectory(parent, "待保留文件所在目录");
  await assertBoundDeliveryDirectory(
    recoveryDirectory,
    "当日交付异常文件恢复目录",
  );
  await fs.rename(file, preserved);
  const after = await readBoundDeliveryFile(
    preserved,
    "已保留的当日交付文件",
    undefined,
    recoveryDirectory,
  );
  if (!after || !sameDeliveryFileIdentity(before, after) || after.nlink !== 1)
    throw new Error("当日交付异常文件保留后身份不一致");
  run.recoveryArtifacts = [...(run.recoveryArtifacts || []), preserved];
  await syncDirectory(parent.path);
  await syncDirectory(recoveryDirectory.path);
  return preserved;
}

async function scanDailyDeliveryRecoveryArtifacts(
  run: DailyDeliveryRun,
  finalDirectory: BoundDeliveryDirectory,
) {
  const recoveryDirectoryPath = path.join(
      run.finalPath,
      `Kocpy恢复-${run.id}`,
    ),
    stat = await fs.lstat(recoveryDirectoryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (!stat) {
    if (run.directoryBindings?.recoveryDirectory)
      throw new Error("已记录的当日交付异常文件恢复目录缺失");
    return [];
  }
  const directory = await bindDeliveryDirectory(
    recoveryDirectoryPath,
    "当日交付异常文件恢复目录",
  );
  await assertDeliveryDirectoryVolume(
    run,
    directory,
    "当日交付异常文件恢复目录",
  );
  if (!run.directoryBindings?.recoveryDirectory) {
    if ((await fs.readdir(recoveryDirectoryPath)).length)
      throw new Error("当日交付异常文件恢复目录存在未登记内容，已停止恢复");
    return [];
  }
  assertRecordedDeliveryDirectory(
    directory,
    run.directoryBindings.recoveryDirectory,
    "当日交付异常文件恢复目录",
  );
  await assertBoundDeliveryDirectory(finalDirectory, "当日交付最终目录");
  const result: string[] = [];
  for (const entry of await fs.readdir(recoveryDirectoryPath)) {
    if (
      !/^[^/]+\.[a-f0-9]{16}\.(?:incomplete|invalid)-\d+-[a-f0-9]{8}$/i.test(
        entry,
      )
    )
      throw new Error(`当日交付异常文件恢复目录包含未知条目：${entry}`);
    const artifact = path.join(recoveryDirectoryPath, entry),
      evidence = await readBoundDeliveryFile(
        artifact,
        "当日交付异常文件恢复证据",
        undefined,
        directory,
      );
    if (!evidence || evidence.nlink !== 1)
      throw new Error("当日交付异常文件恢复证据不是独立普通文件");
    result.push(artifact);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

async function recoverPublishedDelivery(
  staging: string,
  output: string,
  source: BoundDeliveryFile,
  expectedSha256: string,
  parent: BoundDeliveryDirectory,
) {
  const published = await hashBoundDeliveryFile(
    output,
    "待恢复的当日交付文件",
    parent,
  );
  if (!published) throw new Error("待恢复的当日交付文件不存在");
  if (published.sha256 !== expectedSha256) return undefined;
  const staged = await hashBoundDeliveryFile(
    staging,
    "待恢复的当日交付临时文件",
    parent,
  );
  if (published.binding.nlink === 2) {
    if (
      !staged ||
      staged.sha256 !== expectedSha256 ||
      staged.binding.nlink !== 2 ||
      !sameStableDeliveryFileBinding(published.binding, staged.binding) ||
      (published.binding.dev === source.dev &&
        published.binding.ino === source.ino)
    )
      throw new Error("当日交付硬链接发布恢复状态异常，已停止接纳");
    await unlinkBoundDeliveryFile(
      staging,
      staged.binding,
      "待恢复的当日交付临时文件",
      parent,
    );
    const recovered = await readBoundDeliveryFile(
      output,
      "恢复后的当日交付文件",
      undefined,
      parent,
    );
    if (
      !recovered ||
      recovered.nlink !== 1 ||
      !sameDeliveryFileIdentity(recovered, published.binding)
    )
      throw new Error("当日交付硬链接发布恢复后身份异常");
    assertIndependentDeliveryFile(recovered, source, "恢复后的当日交付文件");
    return expectedSha256;
  }
  assertIndependentDeliveryFile(
    published.binding,
    source,
    "待恢复的当日交付文件",
  );
  if (staged) {
    assertIndependentDeliveryFile(
      staged.binding,
      source,
      "待恢复的当日交付临时文件",
    );
    if (staged.sha256 !== expectedSha256)
      throw new Error("待恢复的当日交付临时文件内容不一致，Kocpy 未删除");
    await unlinkBoundDeliveryFile(
      staging,
      staged.binding,
      "待恢复的当日交付临时文件",
      parent,
    );
  }
  return expectedSha256;
}

const maxDailyDeliveryMetadataBytes = 128 * 1024 * 1024;

function dailyDeliveryMarkerSnapshot(run: DailyDeliveryRun): DailyDeliveryRun {
  return {
    ...run,
    completedFiles: 0,
    completedBytes: 0,
    files: [],
    recoveryArtifacts: [],
    directoryBindings: run.directoryBindings
      ? {
          destinationParent: run.directoryBindings.destinationParent,
          finalPath: run.directoryBindings.finalPath,
          mediaRoot: run.directoryBindings.mediaRoot,
          reportDirectory: run.directoryBindings.reportDirectory,
          recoveryDirectory: run.directoryBindings.recoveryDirectory,
        }
      : undefined,
  };
}

async function writeJsonAtomic(
  file: string,
  run: DailyDeliveryRun,
  parent: BoundDeliveryDirectory,
) {
  const serialized = JSON.stringify(dailyDeliveryMarkerSnapshot(run), null, 2);
  if (Buffer.byteLength(serialized, "utf8") > maxDailyDeliveryMetadataBytes)
    throw new Error("当日交付恢复标记超过安全写入上限，已停止继续写入");
  const temporary = `${file}.partial-${process.pid}-${randomUUID()}`;
  await assertBoundDeliveryDirectory(parent, "当日交付恢复标记父目录");
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertBoundDeliveryDirectory(parent, "当日交付恢复标记父目录");
  await fs.rename(temporary, file);
  const published = await readBoundDeliveryFile(
    file,
    "当日交付恢复标记",
    undefined,
    parent,
  );
  if (!published || published.nlink !== 1)
    throw new Error("当日交付恢复标记发布身份异常");
  await syncDirectory(parent.path);
}

interface DailyDeliveryOwnershipSidecar {
  schemaVersion: 2;
  runId: string;
  sourceTaskId: string;
  destinationParent: string;
  finalPath: string;
  destinationVolumeId?: string;
  destinationVolumeUuid?: string;
  sourceVolumeIdentity?: VolumeIdentity;
  destinationVolumeIdentity?: VolumeIdentity;
  directoryBindings?: DailyDeliveryRun["directoryBindings"];
  allocationDigest: string;
  totalFiles: number;
  totalBytes: number;
  createdAt: number;
}

const dailyDeliveryOwnershipPath = (run: DailyDeliveryRun) =>
  path.join(
    run.destinationParent,
    `.${path.basename(run.finalPath)}.${run.id}.kocpy-owner.json`,
  );

function dailyDeliveryOwnership(
  run: DailyDeliveryRun,
): DailyDeliveryOwnershipSidecar {
  return {
    schemaVersion: 2,
    runId: run.id,
    sourceTaskId: run.sourceTaskId,
    destinationParent: run.destinationParent,
    finalPath: run.finalPath,
    destinationVolumeId: run.destinationVolumeId,
    destinationVolumeUuid: run.destinationVolumeUuid,
    sourceVolumeIdentity: run.sourceVolumeIdentity,
    destinationVolumeIdentity: run.destinationVolumeIdentity,
    directoryBindings: run.directoryBindings,
    allocationDigest: run.allocationDigest,
    totalFiles: run.totalFiles,
    totalBytes: run.totalBytes,
    createdAt: run.createdAt,
  };
}

function assertDailyDeliveryOwnership(
  value: unknown,
  run: DailyDeliveryRun,
): asserts value is DailyDeliveryOwnershipSidecar {
  const expected = dailyDeliveryOwnership(run),
    actual = value as Partial<DailyDeliveryOwnershipSidecar> | undefined;
  if (
    !actual ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.runId !== expected.runId ||
    actual.sourceTaskId !== expected.sourceTaskId ||
    actual.destinationParent !== expected.destinationParent ||
    actual.finalPath !== expected.finalPath ||
    actual.destinationVolumeId !== expected.destinationVolumeId ||
    actual.destinationVolumeUuid !== expected.destinationVolumeUuid ||
    JSON.stringify(actual.sourceVolumeIdentity) !==
      JSON.stringify(expected.sourceVolumeIdentity) ||
    JSON.stringify(actual.destinationVolumeIdentity) !==
      JSON.stringify(expected.destinationVolumeIdentity) ||
    !sameDeliveryDirectoryBinding(
      actual.directoryBindings?.destinationParent,
      expected.directoryBindings?.destinationParent,
    ) ||
    actual.allocationDigest !== expected.allocationDigest ||
    actual.totalFiles !== expected.totalFiles ||
    actual.totalBytes !== expected.totalBytes ||
    actual.createdAt !== expected.createdAt
  )
    throw new Error(
      "当日交付外部所有权标记与权威任务、路径或磁盘身份不一致，已停止写入",
    );
}

async function readDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
  parent: BoundDeliveryDirectory,
) {
  try {
    const evidence = await readBoundDeliveryBuffer(
      file,
      "当日交付外部所有权标记",
      parent,
      maxDailyDeliveryMetadataBytes,
    );
    if (!evidence) return undefined;
    if (
      evidence.binding.size <= 0 ||
      evidence.binding.size > maxDailyDeliveryMetadataBytes
    )
      throw new Error("所有权标记大小无效");
    const value = JSON.parse(evidence.bytes.toString("utf8")) as unknown;
    assertDailyDeliveryOwnership(value, run);
    return value;
  } catch (error) {
    if (
      error instanceof Error &&
      /不是安全的普通文件|不可安全打开|额外硬链接/.test(error.message)
    )
      throw new Error("当日交付外部所有权标记不可安全读取，已停止写入");
    if (
      error instanceof Error &&
      error.message.startsWith("当日交付外部所有权标记与")
    )
      throw error;
    throw new Error(
      `当日交付外部所有权标记损坏，已停止写入：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function acquireDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
  parent: BoundDeliveryDirectory,
) {
  const value = dailyDeliveryOwnership(run),
    serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > maxDailyDeliveryMetadataBytes)
    throw new Error("当日交付外部所有权标记超过安全写入上限");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await readDailyDeliveryOwnership(file, run, parent);
    return { created: false as const, value };
  }
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(file).catch(() => undefined);
    await syncDirectory(path.dirname(file)).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await assertBoundDeliveryDirectory(parent, "交付目的地父目录");
  await syncDirectory(parent.path);
  return { created: true as const, value };
}

async function updateDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
  parent: BoundDeliveryDirectory,
) {
  await readDailyDeliveryOwnership(file, run, parent);
  const temporary = `${file}.partial-${process.pid}-${randomUUID()}`,
    serialized = JSON.stringify(dailyDeliveryOwnership(run), null, 2);
  if (Buffer.byteLength(serialized, "utf8") > maxDailyDeliveryMetadataBytes)
    throw new Error("当日交付外部所有权标记超过安全写入上限");
  await assertBoundDeliveryDirectory(parent, "交付目的地父目录");
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assertBoundDeliveryDirectory(parent, "交付目的地父目录");
  await fs.rename(temporary, file);
  await syncDirectory(parent.path);
  await readDailyDeliveryOwnership(file, run, parent);
}

async function releaseDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
  parent: BoundDeliveryDirectory,
) {
  const value = await readDailyDeliveryOwnership(file, run, parent);
  if (!value) return;
  await assertBoundDeliveryDirectory(parent, "交付目的地父目录");
  await fs.unlink(file);
  await syncDirectory(parent.path);
}

async function assertBootstrapDeliveryDirectory(
  directory: string,
  markerPath: string,
  runId: string,
  recordedMedia?: { dev: number; ino: number },
) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("交付最终路径已存在且不是安全目录");
  const entries = await fs.readdir(directory);
  const partialPrefix = `${path.basename(markerPath)}.partial-`;
  const bootstrapJournalStats = new Map<string, Stats>();
  for (const entry of entries) {
    if (entry === "Media" && recordedMedia) {
      const media = await bindDeliveryDirectory(
        path.join(directory, entry),
        "当日交付 bootstrap Media 目录",
      );
      assertRecordedDeliveryDirectory(
        media,
        recordedMedia,
        "当日交付 bootstrap Media 目录",
      );
      if (media.dev !== stat.dev || (await fs.readdir(media.path)).length)
        throw new Error(
          "当日交付 Media 目录在恢复标记完成前出现未知内容，已停止接管",
        );
      continue;
    }
    if (
      entry === dailyDeliveryJournalFileName ||
      entry === dailyDeliveryJournalPartialName(runId) ||
      entry.startsWith(dailyDeliveryJournalRecoveryPrefix) ||
      entry.startsWith(`${dailyDeliveryJournalFileName}.torn-tail-`)
    ) {
      const candidateStat = await fs.lstat(path.join(directory, entry));
      const mayBeLinkedCreationBoundary =
        entry === dailyDeliveryJournalFileName ||
        entry === dailyDeliveryJournalPartialName(runId);
      if (
        !candidateStat.isFile() ||
        candidateStat.isSymbolicLink() ||
        (mayBeLinkedCreationBoundary
          ? ![1, 2].includes(candidateStat.nlink)
          : candidateStat.nlink !== 1)
      )
        throw new Error(
          "当日交付目录的恢复日志不是独立安全普通文件，已停止接管",
        );
      bootstrapJournalStats.set(entry, candidateStat);
      continue;
    }
    if (!entry.startsWith(partialPrefix))
      throw new Error("当日交付目录在所有权标记完成前出现未知内容，已停止接管");
    const candidate = path.join(directory, entry),
      candidateStat = await fs.lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink())
      throw new Error("当日交付目录的临时标记不是安全普通文件，已停止接管");
  }
  const partials = entries.filter((entry) => entry.startsWith(partialPrefix));
  const journalStat = bootstrapJournalStats.get(dailyDeliveryJournalFileName),
    journalPartialStat = bootstrapJournalStats.get(
      dailyDeliveryJournalPartialName(runId),
    );
  if (journalStat?.nlink === 2 || journalPartialStat?.nlink === 2) {
    if (
      !journalStat ||
      !journalPartialStat ||
      journalStat.nlink !== 2 ||
      journalPartialStat.nlink !== 2 ||
      journalStat.dev !== journalPartialStat.dev ||
      journalStat.ino !== journalPartialStat.ino
    )
      throw new Error(
        "当日交付恢复日志存在无法归属于创建中断的额外硬链接，已停止接管",
      );
  }
  for (const entry of partials) await fs.unlink(path.join(directory, entry));
  if (partials.length) await syncDirectory(directory);
}

async function preserveInterruptedGeneratedArtifact(
  file: string,
  expected: BoundDeliveryFile,
  parent: BoundDeliveryDirectory,
) {
  if (expected.nlink !== 1)
    throw new Error("当日交付部分生成产物不是独立普通文件，Kocpy 未移动");
  const recoveryDirectory = `${file}.recovery-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await assertBoundDeliveryDirectory(parent, "当日交付生成产物父目录");
  await fs.mkdir(recoveryDirectory, { recursive: false, mode: 0o700 });
  const recoveryParent = await bindDeliveryDirectory(
      recoveryDirectory,
      "当日交付生成产物恢复目录",
    ),
    preserved = path.join(recoveryDirectory, path.basename(file));
  await fs.rename(file, preserved);
  const after = await readBoundDeliveryFile(
    preserved,
    "已保留的当日交付部分生成产物",
    undefined,
    recoveryParent,
  );
  if (
    !after ||
    after.nlink !== 1 ||
    !sameDeliveryFileIdentity(after, expected)
  )
    throw new Error("当日交付部分生成产物保留后身份不一致");
  await syncDirectory(recoveryParent.path);
  await syncDirectory(parent.path);
  return preserved;
}

const generatedArtifactTemporaryPath = (file: string) =>
  `${file}.kocpy-publish-partial`;

async function writeGeneratedArtifactIdempotent(
  file: string,
  value: string | Buffer,
  parent: BoundDeliveryDirectory,
) {
  const expected = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
    expectedDigest = createHash("sha256").update(expected).digest("hex"),
    temporary = generatedArtifactTemporaryPath(file);
  let existing = await hashBoundDeliveryFile(
      file,
      "当日交付生成产物",
      parent,
    ),
    staged = await hashBoundDeliveryFile(
      temporary,
      "当日交付生成产物临时文件",
      parent,
    );
  if (existing) {
    if (existing.binding.nlink === 2) {
      if (
        !staged ||
        staged.binding.nlink !== 2 ||
        staged.sha256 !== expectedDigest ||
        existing.sha256 !== expectedDigest ||
        !sameStableDeliveryFileBinding(existing.binding, staged.binding)
      )
        throw new Error(`交付报告中断发布状态异常，Kocpy 未接纳：${file}`);
      await unlinkBoundDeliveryFile(
        temporary,
        staged.binding,
        "当日交付生成产物临时文件",
        parent,
      );
      existing = await hashBoundDeliveryFile(
        file,
        "恢复后的当日交付生成产物",
        parent,
      );
      if (
        !existing ||
        existing.binding.nlink !== 1 ||
        existing.sha256 !== expectedDigest
      )
        throw new Error(`交付报告中断发布恢复失败：${file}`);
      return;
    }
    if (existing.binding.nlink !== 1)
      throw new Error(`交付报告位置已有额外硬链接，Kocpy 未接纳：${file}`);
    if (existing.sha256 !== expectedDigest) {
      if (
        !staged ||
        staged.binding.nlink !== 1 ||
        staged.sha256 !== expectedDigest
      )
        throw new Error(`交付报告位置已有内容不同的文件，Kocpy 未覆盖：${file}`);
      await preserveInterruptedGeneratedArtifact(
        file,
        existing.binding,
        parent,
      );
      existing = undefined;
    } else {
      if (staged) {
        if (staged.binding.nlink !== 1 || staged.sha256 !== expectedDigest)
          throw new Error(`交付报告临时文件状态异常，Kocpy 未清理：${file}`);
        await unlinkBoundDeliveryFile(
          temporary,
          staged.binding,
          "当日交付生成产物临时文件",
          parent,
        );
      }
      return;
    }
  }
  if (staged) {
    if (staged.binding.nlink !== 1 || staged.sha256 !== expectedDigest)
      throw new Error(`交付报告临时文件内容或身份异常，Kocpy 未覆盖：${file}`);
  } else {
    await assertBoundDeliveryDirectory(parent, "当日交付生成产物父目录");
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o644,
    );
    try {
      await handle.writeFile(expected);
      await handle.sync();
      const binding = deliveryFileBinding(await handle.stat());
      if (binding.nlink !== 1 || binding.size !== expected.length)
        throw new Error("当日交付生成产物临时文件身份异常");
    } finally {
      await handle.close();
    }
    staged = await hashBoundDeliveryFile(
      temporary,
      "当日交付生成产物临时文件",
      parent,
    );
    if (
      !staged ||
      staged.binding.nlink !== 1 ||
      staged.sha256 !== expectedDigest
    )
      throw new Error("当日交付生成产物临时文件写入后回读失败");
  }
  const stagedBinding = staged.binding;
  let linked = false;
  try {
    await fs.link(temporary, file);
    linked = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const raced = await hashBoundDeliveryFile(
        file,
        "当日交付生成产物",
        parent,
      );
      if (!raced || raced.binding.nlink !== 1 || raced.sha256 !== expectedDigest)
        throw new Error(`交付报告位置已有内容不同的文件，Kocpy 未覆盖：${file}`);
      await unlinkBoundDeliveryFile(
        temporary,
        stagedBinding,
        "当日交付生成产物临时文件",
        parent,
      );
      return;
    }
    if (
      ![
        "EXDEV",
        "EPERM",
        "EACCES",
        "EINVAL",
        "ENOTSUP",
        "EOPNOTSUPP",
      ].includes(code || "")
    )
      throw error;
    await copyBoundDeliveryFileExclusive(
      temporary,
      file,
      stagedBinding,
      parent,
    );
  }
  if (linked) {
    const temporaryLinked = await readBoundDeliveryFile(
        temporary,
        "当日交付生成产物临时文件",
        undefined,
        parent,
      ),
      publishedLinked = await readBoundDeliveryFile(
        file,
        "当日交付生成产物",
        undefined,
        parent,
      );
    if (
      !temporaryLinked ||
      !publishedLinked ||
      !sameDeliveryFileIdentity(temporaryLinked, stagedBinding) ||
      !sameStableDeliveryFileBinding(temporaryLinked, publishedLinked) ||
      temporaryLinked.nlink !== 2 ||
      publishedLinked.nlink !== 2
    )
      throw new Error("当日交付生成产物硬链接发布身份异常");
    await syncBoundDeliveryFile(
      file,
      publishedLinked,
      "当日交付生成产物",
      parent,
    );
    await unlinkBoundDeliveryFile(
      temporary,
      temporaryLinked,
      "当日交付生成产物临时文件",
      parent,
    );
  } else {
    const stillTemporary = await readBoundDeliveryFile(
      temporary,
      "当日交付生成产物临时文件",
      undefined,
      parent,
    );
    if (
      !stillTemporary ||
      stillTemporary.nlink !== 1 ||
      !sameStableDeliveryFileBinding(stillTemporary, stagedBinding)
    )
      throw new Error("当日交付生成产物复制发布后临时文件身份异常");
    await unlinkBoundDeliveryFile(
      temporary,
      stillTemporary,
      "当日交付生成产物临时文件",
      parent,
    );
  }
  const published = await hashBoundDeliveryFile(
    file,
    "当日交付生成产物",
    parent,
  );
  if (!published || published.binding.nlink !== 1 || published.sha256 !== expectedDigest)
    throw new Error(`当日交付生成产物发布后回读失败：${file}`);
}

async function verifyGeneratedArtifactFinal(
  file: string,
  expectedDigest: string,
  parent: BoundDeliveryDirectory,
) {
  const evidence = await hashBoundDeliveryFile(
    file,
    "当日交付生成产物终检",
    parent,
  );
  if (
    !evidence ||
    evidence.binding.nlink !== 1 ||
    evidence.sha256 !== expectedDigest
  )
    throw new Error(`当日交付生成产物完成前终检失败：${file}`);
  return evidence.binding;
}

async function recheckGeneratedArtifactBinding(
  file: string,
  expected: BoundDeliveryFile,
  parent: BoundDeliveryDirectory,
) {
  const actual = await readBoundDeliveryFile(
    file,
    "当日交付生成产物完成前身份",
    undefined,
    parent,
  );
  if (
    !actual ||
    actual.nlink !== 1 ||
    !sameStableDeliveryFileBinding(actual, expected)
  )
    throw new Error(`当日交付生成产物在终检后发生变化：${file}`);
}

async function readMarker(file: string, parent: BoundDeliveryDirectory) {
  try {
    const evidence = await readBoundDeliveryBuffer(
      file,
      "当日交付恢复标记",
      parent,
      maxDailyDeliveryMetadataBytes,
    );
    if (!evidence) return undefined;
    if (
      evidence.binding.size <= 0 ||
      evidence.binding.size > maxDailyDeliveryMetadataBytes
    )
      throw new Error("恢复标记大小无效");
    return JSON.parse(evidence.bytes.toString("utf8")) as DailyDeliveryRun;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("当日交付恢复标记不可安全读取，已停止写入并保留现有目录");
  }
}

const dailyDeliveryJournalFileName =
  ".kocpy-daily-delivery.journal.ndjson";
const dailyDeliveryJournalPartialName = (runId: string) =>
  `${dailyDeliveryJournalFileName}.partial-${runId}`;
const dailyDeliveryJournalRecoveryPrefix =
  `${dailyDeliveryJournalFileName}.recovery-`;
type DailyDeliveryJournalEventType =
  | "header"
  | "parent-bound"
  | "recovery-directory-bound"
  | "report-directory-bound"
  | "publication-intent"
  | "file-complete";
interface DailyDeliveryJournalEvent {
  schemaVersion: 1;
  sequence: number;
  previousSha256: string;
  type: DailyDeliveryJournalEventType;
  payload: unknown;
  sha256: string;
}

function dailyDeliveryJournalEvent(
  sequence: number,
  previousSha256: string,
  type: DailyDeliveryJournalEventType,
  payload: unknown,
): DailyDeliveryJournalEvent {
  const unsigned = {
      schemaVersion: 1 as const,
      sequence,
      previousSha256,
      type,
      payload,
    },
    sha256 = createHash("sha256")
      .update(JSON.stringify(unsigned))
      .digest("hex");
  return { ...unsigned, sha256 };
}

const dailyDeliveryJournalLine = (event: DailyDeliveryJournalEvent) =>
  `${JSON.stringify(event)}\n`;

function dailyDeliveryJournalHeader(run: DailyDeliveryRun) {
  return dailyDeliveryJournalEvent(0, "0".repeat(64), "header", {
    runId: run.id,
    sourceTaskId: run.sourceTaskId,
    projectId: run.projectId,
    projectNameSnapshot: run.projectNameSnapshot,
    shootingDate: run.shootingDate,
    operator: run.operator,
    createdAt: run.createdAt,
    sourceDestinationId: run.sourceDestinationId,
    sourceRoot: run.sourceRoot,
    sourceVolumeId: run.sourceVolumeId,
    sourceVolumeUuid: run.sourceVolumeUuid,
    sourceVolumeIdentity: run.sourceVolumeIdentity,
    destinationParent: run.destinationParent,
    finalPath: run.finalPath,
    destinationVolumeId: run.destinationVolumeId,
    destinationVolumeUuid: run.destinationVolumeUuid,
    destinationVolumeIdentity: run.destinationVolumeIdentity,
    directoryBindings: {
      destinationParent: run.directoryBindings?.destinationParent,
      finalPath: run.directoryBindings?.finalPath,
      mediaRoot: run.directoryBindings?.mediaRoot,
    },
    hashAlgorithm: run.hashAlgorithm,
    allocationDigest: run.allocationDigest,
    totalFiles: run.totalFiles,
    totalBytes: run.totalBytes,
  });
}

const sha256Text = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  return value;
}

const canonicalJson = (value: unknown) =>
  JSON.stringify(canonicalJsonValue(value));

function exactObjectKeys(value: unknown, keys: string[]) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>)
        .sort()
        .join("\0") === [...keys].sort().join("\0"),
  );
}

function safeDeliveryRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8192 &&
    !value.includes("\0") &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "." &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
  );
}

function journalExpectedParents(records: FileRecord[]) {
  const result = new Set<string>();
  for (const record of records) {
    const parts = record.relativePath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      result.add(current);
    }
  }
  return result;
}

function validateDailyDeliveryJournalEvent(
  value: unknown,
  expectedSequence: number,
  previousSha256: string,
) {
  const event = value as DailyDeliveryJournalEvent;
  if (
    !event ||
    !exactObjectKeys(event, [
      "schemaVersion",
      "sequence",
      "previousSha256",
      "type",
      "payload",
      "sha256",
    ]) ||
    event.schemaVersion !== 1 ||
    event.sequence !== expectedSequence ||
    event.previousSha256 !== previousSha256 ||
    ![
      "header",
      "parent-bound",
      "recovery-directory-bound",
      "report-directory-bound",
      "publication-intent",
      "file-complete",
    ].includes(event.type) ||
    !/^[a-f0-9]{64}$/.test(event.sha256)
  )
    throw new Error("当日交付恢复日志事件结构或链序无效");
  const expected = dailyDeliveryJournalEvent(
    event.sequence,
    event.previousSha256,
    event.type,
    event.payload,
  );
  if (expected.sha256 !== event.sha256)
    throw new Error("当日交付恢复日志中段被修改，已停止恢复");
  return event;
}

async function truncateBoundDeliveryFile(
  file: string,
  expected: BoundDeliveryFile,
  size: number,
  parent: BoundDeliveryDirectory,
) {
  await assertBoundDeliveryDirectory(parent, "当日交付恢复日志父目录");
  const handle = await fs.open(
    file,
    constants.O_RDWR | (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = deliveryFileBinding(await handle.stat());
    if (!sameStableDeliveryFileBinding(before, expected))
      throw new Error("当日交付恢复日志在截断尾部前发生变化");
    await handle.truncate(size);
    await handle.sync();
    const after = deliveryFileBinding(await handle.stat()),
      pathAfter = await fs.lstat(file);
    if (
      after.size !== size ||
      after.dev !== expected.dev ||
      after.ino !== expected.ino ||
      after.nlink !== 1 ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    )
      throw new Error("当日交付恢复日志尾部截断后身份异常");
    return after;
  } finally {
    await handle.close();
  }
}

interface LoadedDailyDeliveryJournal {
  binding: BoundDeliveryFile;
  events: DailyDeliveryJournalEvent[];
  files: DailyDeliveryRun["files"];
  parents: Record<string, { dev: number; ino: number }>;
  reportDirectory?: { dev: number; ino: number };
  recoveryDirectory?: { dev: number; ino: number };
  publicationInProgress?: DailyDeliveryRun["publicationInProgress"];
}

function parseAndValidateDailyDeliveryJournal(
  run: DailyDeliveryRun,
  records: FileRecord[],
  bytes: Buffer,
) {
  const lastNewline = bytes.lastIndexOf(0x0a),
    validLength = lastNewline + 1;
  if (!validLength) throw new Error("当日交付恢复日志没有完整事件");
  const events: DailyDeliveryJournalEvent[] = [],
    lineEnds: number[] = [],
    completed = new Map<string, DailyDeliveryRun["files"][number]>(),
    parents = Object.create(null) as Record<
      string,
      { dev: number; ino: number }
    >,
    expectedRecords = new Map(records.map((record) => [record.relativePath, record])),
    expectedParents = journalExpectedParents(records);
  let previousSha256 = "0".repeat(64),
    lineStart = 0,
    publicationInProgress:
      | DailyDeliveryRun["publicationInProgress"]
      | undefined,
    reportDirectory: { dev: number; ino: number } | undefined;
  let recoveryDirectory: { dev: number; ino: number } | undefined;
  for (let lineEnd = bytes.indexOf(0x0a, lineStart); lineEnd >= 0 && lineEnd < validLength; lineEnd = bytes.indexOf(0x0a, lineStart)) {
    const line = bytes.subarray(lineStart, lineEnd).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("当日交付恢复日志包含损坏的完整事件");
    }
    const event = validateDailyDeliveryJournalEvent(
      parsed,
      events.length,
      previousSha256,
    );
    if (!events.length) {
      const expectedHeader = dailyDeliveryJournalHeader(run);
      if (
        event.type !== "header" ||
        canonicalJson(event.payload) !== canonicalJson(expectedHeader.payload)
      )
        throw new Error("当日交付恢复日志不属于当前任务或根目录身份已变化");
    } else if (event.type === "header") {
      throw new Error("当日交付恢复日志包含重复头事件");
    } else if (event.type === "parent-bound") {
      const payload = event.payload as {
        relativePath?: unknown;
        dev?: unknown;
        ino?: unknown;
      };
      if (
        !payload ||
        !exactObjectKeys(payload, ["relativePath", "dev", "ino"]) ||
        !safeDeliveryRelativePath(payload.relativePath) ||
        !expectedParents.has(payload.relativePath) ||
        !Number.isSafeInteger(payload.dev) ||
        Number(payload.dev) < 0 ||
        !Number.isSafeInteger(payload.ino) ||
        Number(payload.ino) <= 0 ||
        Object.prototype.hasOwnProperty.call(parents, payload.relativePath)
      )
        throw new Error("当日交付恢复日志父目录事件无效、重复或越出确认范围");
      Object.defineProperty(parents, payload.relativePath, {
        value: { dev: Number(payload.dev), ino: Number(payload.ino) },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (event.type === "recovery-directory-bound") {
      const payload = event.payload as { dev?: unknown; ino?: unknown };
      if (
        recoveryDirectory ||
        !payload ||
        !exactObjectKeys(payload, ["dev", "ino"]) ||
        !Number.isSafeInteger(payload.dev) ||
        Number(payload.dev) < 0 ||
        !Number.isSafeInteger(payload.ino) ||
        Number(payload.ino) <= 0
      )
        throw new Error("当日交付恢复日志异常文件目录身份事件无效或重复");
      recoveryDirectory = {
        dev: Number(payload.dev),
        ino: Number(payload.ino),
      };
    } else if (event.type === "report-directory-bound") {
      const payload = event.payload as { dev?: unknown; ino?: unknown };
      if (
        reportDirectory ||
        publicationInProgress ||
        completed.size !== expectedRecords.size ||
        !payload ||
        !exactObjectKeys(payload, ["dev", "ino"]) ||
        !Number.isSafeInteger(payload.dev) ||
        Number(payload.dev) < 0 ||
        !Number.isSafeInteger(payload.ino) ||
        Number(payload.ino) <= 0
      )
        throw new Error("当日交付恢复日志报告目录身份事件无效或重复");
      reportDirectory = { dev: Number(payload.dev), ino: Number(payload.ino) };
    } else if (event.type === "publication-intent") {
      const payload = event.payload as NonNullable<
          DailyDeliveryRun["publicationInProgress"]
        >,
        expected =
          payload && safeDeliveryRelativePath(payload.relativePath)
            ? expectedRecords.get(payload.relativePath)
            : undefined,
        output = expected
          ? path.join(run.finalPath, "Media", payload.relativePath)
          : "";
      if (
        !payload ||
        !exactObjectKeys(payload, [
          "relativePath",
          "stagingPath",
          "finalPath",
        ]) ||
        !expected ||
        publicationInProgress ||
        completed.has(payload.relativePath) ||
        payload.finalPath !== output ||
        payload.stagingPath !== `${output}.partial-${run.id}`
      )
        throw new Error("当日交付恢复日志发布意图无效、重叠或越出确认范围");
      const parentRelative = path.posix.dirname(payload.relativePath);
      if (
        parentRelative !== "." &&
        !Object.prototype.hasOwnProperty.call(parents, parentRelative)
      )
        throw new Error("当日交付恢复日志在父目录身份持久化前记录了发布意图");
      publicationInProgress = {
        relativePath: payload.relativePath,
        stagingPath: payload.stagingPath,
        finalPath: payload.finalPath,
      };
    } else if (event.type === "file-complete") {
      const payload = event.payload as DailyDeliveryRun["files"][number],
        expected =
          payload && safeDeliveryRelativePath(payload.relativePath)
            ? expectedRecords.get(payload.relativePath)
            : undefined;
      if (
        !payload ||
        !exactObjectKeys(payload, [
          "relativePath",
          "size",
          "sourceChecksum",
          "sourceVerifiedAt",
          "deliveredChecksum",
          "verified",
        ]) ||
        !expected ||
        !publicationInProgress ||
        publicationInProgress.relativePath !== payload.relativePath ||
        completed.has(payload.relativePath) ||
        payload.size !== expected.size ||
        !sha256Text(payload.sourceChecksum) ||
        !sha256Text(payload.deliveredChecksum) ||
        payload.sourceChecksum !== payload.deliveredChecksum ||
        payload.verified !== true ||
        !Number.isSafeInteger(payload.sourceVerifiedAt) ||
        payload.sourceVerifiedAt < run.createdAt
      )
        throw new Error("当日交付恢复日志完成证据无效、重复或不匹配发布意图");
      completed.set(payload.relativePath, payload);
      publicationInProgress = undefined;
    }
    events.push(event);
    previousSha256 = event.sha256;
    lineEnds.push(lineEnd + 1);
    lineStart = lineEnd + 1;
  }
  if (!events.length || events[0].type !== "header")
    throw new Error("当日交付恢复日志缺少任务头事件");
  if (run.deliveryJournal) {
    const cursorEvent = events[run.deliveryJournal.sequence],
      cursorEnd = lineEnds[run.deliveryJournal.sequence];
    if (
      run.deliveryJournal.fileName !== dailyDeliveryJournalFileName ||
      !cursorEvent ||
      cursorEvent.sha256 !== run.deliveryJournal.headSha256 ||
      cursorEnd !== run.deliveryJournal.byteLength
    )
      throw new Error("当日交付恢复日志与持久化游标不一致");
  }
  return {
    validLength,
    events,
    files: [...completed.values()],
    parents,
    reportDirectory,
    recoveryDirectory,
    publicationInProgress,
  };
}

async function preserveDailyDeliveryJournalTail(
  journalPath: string,
  tail: Buffer,
  parent: BoundDeliveryDirectory,
) {
  const auditPath = `${journalPath}.torn-tail-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await assertBoundDeliveryDirectory(parent, "当日交付恢复日志父目录");
  const handle = await fs.open(
    auditPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    await handle.writeFile(tail);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const evidence = await readBoundDeliveryBuffer(
    auditPath,
    "当日交付恢复日志尾残审计文件",
    parent,
    maxDailyDeliveryMetadataBytes,
  );
  if (!evidence || !evidence.bytes.equals(tail))
    throw new Error("当日交付恢复日志尾残未能安全保留，Kocpy 未截断原日志");
  await syncDirectory(parent.path);
  return auditPath;
}

async function loadDailyDeliveryJournal(
  run: DailyDeliveryRun,
  finalDirectory: BoundDeliveryDirectory,
  records: FileRecord[],
): Promise<LoadedDailyDeliveryJournal> {
  const journalPath = path.join(finalDirectory.path, dailyDeliveryJournalFileName),
    evidence = await readBoundDeliveryBuffer(
      journalPath,
      "当日交付恢复日志",
      finalDirectory,
      maxDailyDeliveryMetadataBytes,
    );
  if (!evidence) throw new Error("当日交付恢复日志缺失");
  const parsed = parseAndValidateDailyDeliveryJournal(
    run,
    records,
    evidence.bytes,
  );
  let binding = evidence.binding;
  if (parsed.validLength !== evidence.bytes.length) {
    await preserveDailyDeliveryJournalTail(
      journalPath,
      evidence.bytes.subarray(parsed.validLength),
      finalDirectory,
    );
    binding = await truncateBoundDeliveryFile(
      journalPath,
      evidence.binding,
      parsed.validLength,
      finalDirectory,
    );
  }
  run.deliveryJournal = {
    schemaVersion: 1,
    fileName: dailyDeliveryJournalFileName,
    sequence: parsed.events.length - 1,
    headSha256: parsed.events.at(-1)!.sha256,
    byteLength: binding.size,
  };
  return {
    binding,
    events: parsed.events,
    files: parsed.files,
    parents: parsed.parents,
    reportDirectory: parsed.reportDirectory,
    recoveryDirectory: parsed.recoveryDirectory,
    publicationInProgress: parsed.publicationInProgress,
  };
}

function dailyDeliveryJournalSeedEvents(run: DailyDeliveryRun) {
  const events = [dailyDeliveryJournalHeader(run)];
  let previous = events[0];
  const append = (
    type: Exclude<DailyDeliveryJournalEventType, "header">,
    payload: unknown,
  ) => {
    previous = dailyDeliveryJournalEvent(
      previous.sequence + 1,
      previous.sha256,
      type,
      payload,
    );
    events.push(previous);
  };
  for (const [relativePath, binding] of Object.entries(
    run.directoryBindings?.parents || {},
  ).sort(([left], [right]) => left.localeCompare(right)))
    append("parent-bound", { relativePath, ...binding });
  if (run.directoryBindings?.recoveryDirectory)
    append("recovery-directory-bound", run.directoryBindings.recoveryDirectory);
  for (const file of [...run.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    const output = path.join(run.finalPath, "Media", file.relativePath);
    append("publication-intent", {
      relativePath: file.relativePath,
      stagingPath: `${output}.partial-${run.id}`,
      finalPath: output,
    });
    append("file-complete", file);
  }
  if (run.directoryBindings?.reportDirectory)
    append("report-directory-bound", run.directoryBindings.reportDirectory);
  if (run.publicationInProgress)
    append("publication-intent", run.publicationInProgress);
  return events;
}

export function estimateDailyDeliveryJournalBytes(
  run: DailyDeliveryRun,
  records: FileRecord[],
) {
  const parents = Object.create(null) as Record<
    string,
    { dev: number; ino: number }
  >;
  for (const relativePath of journalExpectedParents(records))
    Object.defineProperty(parents, relativePath, {
      value: {
        dev: Number.MAX_SAFE_INTEGER,
        ino: Number.MAX_SAFE_INTEGER,
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  const worstCase: DailyDeliveryRun = {
    ...run,
    directoryBindings: {
      ...run.directoryBindings!,
      parents,
      reportDirectory: {
        dev: Number.MAX_SAFE_INTEGER,
        ino: Number.MAX_SAFE_INTEGER,
      },
      recoveryDirectory: {
        dev: Number.MAX_SAFE_INTEGER,
        ino: Number.MAX_SAFE_INTEGER,
      },
    },
    files: records.map((record) => ({
      relativePath: record.relativePath,
      size: record.size,
      sourceChecksum: "f".repeat(64),
      sourceVerifiedAt: Number.MAX_SAFE_INTEGER,
      deliveredChecksum: "f".repeat(64),
      verified: true,
    })),
    publicationInProgress: undefined,
  };
  return dailyDeliveryJournalSeedEvents(worstCase).reduce(
    (sum, event) => sum + Buffer.byteLength(dailyDeliveryJournalLine(event)),
    0,
  );
}

export function estimateDailyDeliveryMarkerBytes(run: DailyDeliveryRun) {
  return Buffer.byteLength(
    JSON.stringify(dailyDeliveryMarkerSnapshot(run), null, 2),
  );
}

async function publishDailyDeliveryJournalExclusive(
  temporary: string,
  journalPath: string,
  expectedBytes: Buffer,
  parent: BoundDeliveryDirectory,
) {
  let temporaryEvidence = await hashBoundDeliveryFile(
    temporary,
    "当日交付恢复日志创建临时文件",
    parent,
  );
  if (
    !temporaryEvidence ||
    temporaryEvidence.binding.nlink !== 1 ||
    temporaryEvidence.sha256 !== createHash("sha256").update(expectedBytes).digest("hex")
  )
    throw new Error("当日交付恢复日志创建临时文件不完整，已保留并停止恢复");
  await assertBoundDeliveryDirectory(parent, "当日交付最终目录");
  try {
    await fs.link(temporary, journalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      !["EXDEV", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(
        code || "",
      )
    )
      throw error;
    await copyBoundDeliveryFileExclusive(
      temporary,
      journalPath,
      temporaryEvidence.binding,
      parent,
    );
  }
  const finalEvidence = await hashBoundDeliveryFile(
    journalPath,
    "当日交付恢复日志",
    parent,
  );
  temporaryEvidence = await hashBoundDeliveryFile(
    temporary,
    "当日交付恢复日志创建临时文件",
    parent,
  );
  if (
    !finalEvidence ||
    !temporaryEvidence ||
    finalEvidence.sha256 !== temporaryEvidence.sha256 ||
    finalEvidence.sha256 !== createHash("sha256").update(expectedBytes).digest("hex")
  )
    throw new Error("当日交付恢复日志独占发布后身份或内容异常");
  if (
    finalEvidence.binding.dev === temporaryEvidence.binding.dev &&
    finalEvidence.binding.ino === temporaryEvidence.binding.ino
  ) {
    if (finalEvidence.binding.nlink !== 2 || temporaryEvidence.binding.nlink !== 2)
      throw new Error("当日交付恢复日志硬链接发布身份异常");
  } else if (
    finalEvidence.binding.nlink !== 1 ||
    temporaryEvidence.binding.nlink !== 1
  ) {
    throw new Error("当日交付恢复日志复制发布存在额外硬链接");
  }
  await fs.unlink(temporary);
  await syncDirectory(parent.path);
  const published = await readBoundDeliveryFile(
    journalPath,
    "当日交付恢复日志",
    undefined,
    parent,
  );
  if (!published || published.nlink !== 1)
    throw new Error("当日交付恢复日志发布清理后身份异常");
}

async function preserveDailyDeliveryJournalCreationArtifact(
  file: string,
  label: string,
  parent: BoundDeliveryDirectory,
) {
  const before = await readBoundDeliveryFile(file, label, undefined, parent);
  if (!before || before.nlink !== 1)
    throw new Error(`${label}不是独立普通文件，Kocpy 未移动或覆盖`);
  const preserved = path.join(
    parent.path,
    `${dailyDeliveryJournalRecoveryPrefix}${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  await assertBoundDeliveryDirectory(parent, "当日交付最终目录");
  await fs.rename(file, preserved);
  const after = await readBoundDeliveryFile(
    preserved,
    `${label}保留副本`,
    undefined,
    parent,
  );
  if (!after || after.nlink !== 1 || !sameDeliveryFileIdentity(before, after))
    throw new Error(`${label}保留后身份异常`);
  await syncDirectory(parent.path);
  return preserved;
}

async function createDailyDeliveryJournal(
  run: DailyDeliveryRun,
  finalDirectory: BoundDeliveryDirectory,
  records: FileRecord[],
) {
  const serialized = Buffer.from(
    dailyDeliveryJournalSeedEvents(run).map(dailyDeliveryJournalLine).join(""),
  );
  if (serialized.length > maxDailyDeliveryMetadataBytes)
    throw new Error("当日交付恢复日志超过安全上限");
  const journalPath = path.join(finalDirectory.path, dailyDeliveryJournalFileName),
    temporary = path.join(
      finalDirectory.path,
      dailyDeliveryJournalPartialName(run.id),
    );
  await assertBoundDeliveryDirectory(finalDirectory, "当日交付最终目录");
  const journalStat = await fs.lstat(journalPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (journalStat) {
    const expectedDigest = createHash("sha256").update(serialized).digest("hex"),
      finalEvidence = await hashBoundDeliveryFile(
        journalPath,
        "当日交付恢复日志",
        finalDirectory,
      ),
      temporaryEvidence = await hashBoundDeliveryFile(
        temporary,
        "当日交付恢复日志创建临时文件",
        finalDirectory,
      );
    if (!finalEvidence)
      throw new Error("当日交付恢复日志在创建恢复期间消失");
    if (finalEvidence.sha256 !== expectedDigest) {
      if (
        !temporaryEvidence ||
        temporaryEvidence.binding.nlink !== 1 ||
        temporaryEvidence.sha256 !== expectedDigest
      )
        throw new Error("当日交付恢复日志已存在但不属于当前初始化状态");
      await preserveDailyDeliveryJournalCreationArtifact(
        journalPath,
        "当日交付恢复日志创建中断的部分目标",
        finalDirectory,
      );
      await publishDailyDeliveryJournalExclusive(
        temporary,
        journalPath,
        serialized,
        finalDirectory,
      );
      return loadDailyDeliveryJournal(run, finalDirectory, records);
    }
    if (temporaryEvidence) {
      const sameInode =
        finalEvidence.binding.dev === temporaryEvidence.binding.dev &&
        finalEvidence.binding.ino === temporaryEvidence.binding.ino;
      if (
        temporaryEvidence.sha256 !== expectedDigest ||
        (sameInode
          ? finalEvidence.binding.nlink !== 2 || temporaryEvidence.binding.nlink !== 2
          : finalEvidence.binding.nlink !== 1 || temporaryEvidence.binding.nlink !== 1)
      ) {
        if (temporaryEvidence.binding.nlink !== 1)
          throw new Error("当日交付恢复日志创建中断状态异常，已停止恢复");
        await preserveDailyDeliveryJournalCreationArtifact(
          temporary,
          "当日交付恢复日志创建中断的临时残片",
          finalDirectory,
        );
      } else {
        await fs.unlink(temporary);
      }
      await syncDirectory(finalDirectory.path);
    }
    return loadDailyDeliveryJournal(run, finalDirectory, records);
  }
  const existingTemporary = await readBoundDeliveryBuffer(
    temporary,
    "当日交付恢复日志创建临时文件",
    finalDirectory,
    maxDailyDeliveryMetadataBytes,
  );
  if (existingTemporary) {
    if (!existingTemporary.bytes.equals(serialized)) {
      await preserveDailyDeliveryJournalCreationArtifact(
        temporary,
        "当日交付恢复日志创建中断的临时残片",
        finalDirectory,
      );
    }
  }
  if (!existingTemporary || !existingTemporary.bytes.equals(serialized)) {
    const handle = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      await handle.writeFile(serialized);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await publishDailyDeliveryJournalExclusive(
    temporary,
    journalPath,
    serialized,
    finalDirectory,
  );
  return loadDailyDeliveryJournal(run, finalDirectory, records);
}

async function appendDailyDeliveryJournal(
  run: DailyDeliveryRun,
  finalDirectory: BoundDeliveryDirectory,
  expectedBinding: BoundDeliveryFile,
  type: Exclude<DailyDeliveryJournalEventType, "header">,
  payload: unknown,
) {
  const cursor = run.deliveryJournal;
  if (!cursor) throw new Error("当日交付恢复日志游标缺失");
  const event = dailyDeliveryJournalEvent(
      cursor.sequence + 1,
      cursor.headSha256,
      type,
      payload,
    ),
    line = Buffer.from(dailyDeliveryJournalLine(event)),
    journalPath = path.join(finalDirectory.path, dailyDeliveryJournalFileName);
  if (cursor.byteLength + line.length > maxDailyDeliveryMetadataBytes)
    throw new Error("当日交付恢复日志超过安全上限");
  await assertBoundDeliveryDirectory(finalDirectory, "当日交付最终目录");
  const handle = await fs.open(
    journalPath,
    constants.O_WRONLY |
      constants.O_APPEND |
      (constants.O_NOFOLLOW || 0),
  );
  try {
    const before = deliveryFileBinding(await handle.stat());
    if (
      !sameStableDeliveryFileBinding(before, expectedBinding) ||
      before.nlink !== 1 ||
      before.size !== cursor.byteLength
    )
      throw new Error("当日交付恢复日志在追加前发生变化");
    let offset = 0;
    while (offset < line.length) {
      const { bytesWritten } = await handle.write(
        line,
        offset,
        line.length - offset,
        null,
      );
      if (!bytesWritten)
        throw new Error("当日交付恢复日志追加写入中断");
      offset += bytesWritten;
    }
    await handle.sync();
    const after = deliveryFileBinding(await handle.stat()),
      pathAfter = await fs.lstat(journalPath);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.nlink !== 1 ||
      after.size !== before.size + line.length ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    )
      throw new Error("当日交付恢复日志追加后身份异常");
    run.deliveryJournal = {
      schemaVersion: 1,
      fileName: dailyDeliveryJournalFileName,
      sequence: event.sequence,
      headSha256: event.sha256,
      byteLength: after.size,
    };
    return after;
  } finally {
    await handle.close();
  }
}

export interface DailyDeliveryExecutionHooks {
  /** Test-only crash boundary after mkdir and before the in-directory marker. */
  afterFinalDirectoryCreated?: () => Promise<void> | void;
  /** Test-only crash boundary after Media ownership is durable, before marker. */
  afterMediaDirectoryCreated?: () => Promise<void> | void;
  /** Test-only crash boundary after the recovery journal exists, before marker. */
  afterJournalCreated?: () => Promise<void> | void;
  /** Test-only mutation boundary after one source evidence read and before copy. */
  afterSourceEvidenceRead?: (
    sourceFile: string,
    relativePath: string,
  ) => Promise<void> | void;
  /** Test-only crash boundary after exclusive publication and before cleanup. */
  afterPublicationLinked?: (
    stagingPath: string,
    finalPath: string,
    relativePath: string,
  ) => Promise<void> | void;
  /** Test-only crash boundary after publication intent is journaled. */
  afterPublicationIntentPersisted?: (
    relativePath: string,
  ) => Promise<void> | void;
  /** Test-only crash boundary after completed evidence is journaled. */
  afterFileCompleted?: (relativePath: string) => Promise<void> | void;
  /** Non-persistent UI progress; the journal remains the recovery authority. */
  onProgress?: (completedFiles: number, completedBytes: number) => void;
  /** Test-only mutation boundary after the first full Media verification. */
  afterInitialTerminalVerification?: () => Promise<void> | void;
}

async function authorizeBoundDailyDeliveryArtifact(
  run: DailyDeliveryRun,
  fileName: string,
  allowEmptyRecoveryAdoption = false,
) {
  if (path.basename(fileName) !== fileName || !fileName)
    throw new Error("当日交付报告文件名无效");
  const destinationParentPath = await canonical(run.destinationParent),
    destinationParent = await bindDeliveryDirectory(
      destinationParentPath,
      "交付目的地父目录",
    ),
    identity = await volumeIdentity(destinationParentPath);
  assertDailyDeliveryVolumeIdentity(
    run.destinationVolumeIdentity,
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    identity,
    "交付目的地",
  );
  assertRecordedDeliveryDirectory(
    destinationParent,
    run.directoryBindings?.destinationParent,
    "交付目的地父目录",
  );
  if (
    !inside(path.resolve(run.finalPath), destinationParentPath) ||
    path.dirname(path.resolve(run.finalPath)) !== destinationParentPath
  )
    throw new Error("交付最终目录已经越出原交付目的地，已停止发布报告");
  const expectedFinal = path.join(
    destinationParentPath,
    path.basename(run.finalPath),
  );
  if (expectedFinal !== run.finalPath)
    throw new Error("交付最终目录路径已经变化，已停止发布报告");
  const finalDirectory = await bindDeliveryDirectory(
    run.finalPath,
    "当日交付最终目录",
  );
  assertRecordedDeliveryDirectory(
    finalDirectory,
    run.directoryBindings?.finalPath,
    "当日交付最终目录",
  );
  await assertDeliveryRootChain(run, destinationParent, finalDirectory);
  const reportDirectory = path.join(run.finalPath, "Kocpy报告");
  let created = false;
  try {
    const reportStat = await fs.lstat(reportDirectory);
    if (!reportStat.isDirectory() || reportStat.isSymbolicLink())
      throw new Error("交付报告位置不是安全的真实目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (run.status === "completed" || run.directoryBindings?.reportDirectory)
      throw new Error("已记录的当日交付报告目录缺失，已停止重新创建");
    await assertDeliveryRootChain(run, destinationParent, finalDirectory);
    await fs.mkdir(reportDirectory, { recursive: false });
    created = true;
  }
  const reportParent = await bindDeliveryDirectory(
    reportDirectory,
    "当日交付报告目录",
  );
  await assertDeliveryDirectoryVolume(run, reportParent, "当日交付报告目录");
  if (run.directoryBindings?.reportDirectory) {
    assertRecordedDeliveryDirectory(
      reportParent,
      run.directoryBindings.reportDirectory,
      "当日交付报告目录",
    );
  } else {
    if (
      !created &&
      (!allowEmptyRecoveryAdoption || (await fs.readdir(reportDirectory)).length)
    )
      throw new Error("当日交付报告目录没有持久化身份，已安全停止");
    run.directoryBindings!.reportDirectory =
      recordedDeliveryDirectory(reportParent);
  }
  const target = path.join(reportDirectory, fileName),
    authorized = await safeChild(
      run.finalPath,
      path.relative(run.finalPath, target),
    );
  if (path.resolve(authorized) !== path.resolve(target))
    throw new Error("交付报告路径越出当日交付目录");
  const targetBinding = await readBoundDeliveryFile(
    target,
    "交付报告目标",
    undefined,
    reportParent,
  );
  if (targetBinding?.nlink === 2) {
    const stagedBinding = await readBoundDeliveryFile(
      generatedArtifactTemporaryPath(target),
      "交付报告中断发布临时文件",
      undefined,
      reportParent,
    );
    if (
      !stagedBinding ||
      stagedBinding.nlink !== 2 ||
      !sameStableDeliveryFileBinding(targetBinding, stagedBinding)
    )
      throw new Error(
        "交付报告目标存在无法归属于 Kocpy 中断发布的额外硬链接，已停止恢复",
      );
  } else if (targetBinding && targetBinding.nlink !== 1) {
    throw new Error("交付报告目标已存在且不是安全的普通文件");
  }
  await assertDeliveryRootChain(run, destinationParent, finalDirectory);
  await assertBoundDeliveryDirectory(reportParent, "当日交付报告目录");
  return { target, parent: reportParent, destinationParent, finalDirectory };
}

export async function authorizeDailyDeliveryArtifact(
  run: DailyDeliveryRun,
  fileName: string,
) {
  return (await authorizeBoundDailyDeliveryArtifact(run, fileName)).target;
}

export function dailyDeliveryReportFileName(run: DailyDeliveryRun) {
  return `Kocpy_${run.shootingDate.replace(/-/g, "")}_${run.id.slice(0, 8)}_当日交付报告.pdf`;
}

export async function verifyPublishedDailyDeliveryReport(
  run: DailyDeliveryRun,
  target: string,
  expectedSha256: string,
) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256))
    throw new Error("当日交付报告期望摘要无效");
  const authorized = await authorizeBoundDailyDeliveryArtifact(
    run,
    dailyDeliveryReportFileName(run),
  ),
    authorizedPath = authorized.target;
  if (authorizedPath !== target)
    throw new Error("当日交付报告目标已经偏离授权路径");
  const evidence = await hashBoundDeliveryFile(
    authorizedPath,
    "当日交付 PDF 报告",
    authorized.parent,
  );
  if (!evidence || evidence.binding.nlink !== 1)
    throw new Error("当日交付报告不是独立的安全普通文件");
  const actualSha256 = evidence.sha256;
  if (actualSha256 !== expectedSha256)
    throw new Error("当日交付报告落盘回读摘要不一致，未记录为完成");
  return { authorizedPath, actualSha256 };
}

export async function publishDailyDeliveryReport(
  run: DailyDeliveryRun,
  target: string,
  value: Uint8Array,
  expectedSha256: string,
) {
  const bytes = Buffer.from(value),
    actualInputSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    !/^[a-f0-9]{64}$/i.test(expectedSha256) ||
    actualInputSha256 !== expectedSha256
  )
    throw new Error("当日交付报告待发布内容与授权摘要不一致");
  const authorized = await authorizeBoundDailyDeliveryArtifact(
    run,
    dailyDeliveryReportFileName(run),
  );
  if (authorized.target !== target)
    throw new Error("当日交付报告目标已经偏离授权路径");
  await writeGeneratedArtifactIdempotent(
    authorized.target,
    bytes,
    authorized.parent,
  );
  return verifyPublishedDailyDeliveryReport(run, target, expectedSha256);
}

export async function reauthorizeRecordedDailyDeliveryReport(
  run: DailyDeliveryRun,
) {
  const recordedPath = run.reportPaths?.[0];
  if (!recordedPath || !run.reportSha256) return undefined;

  // A persisted path is evidence, not authority. Rebuild the only permitted
  // path from the immutable run snapshot and re-check the directory/volume
  // before reading either the recorded digest or the file itself.
  const authorized = await authorizeBoundDailyDeliveryArtifact(
    run,
    dailyDeliveryReportFileName(run),
  ),
    authorizedPath = authorized.target;
  if (run.reportPaths?.length !== 1 || recordedPath !== authorizedPath)
    throw new Error("已记录的当日交付报告路径不再属于该交付任务");
  const digestKeys = Object.keys(run.reportSha256),
    recordedDigest = run.reportSha256[authorizedPath];
  if (
    digestKeys.length !== 1 ||
    digestKeys[0] !== authorizedPath ||
    !/^[a-f0-9]{64}$/i.test(recordedDigest || "")
  )
    throw new Error("已记录的当日交付报告摘要无效");
  let actualDigest: string | undefined;
  try {
    const evidence = await hashBoundDeliveryFile(
      authorizedPath,
      "已记录的当日交付 PDF 报告",
      authorized.parent,
    );
    if (evidence && evidence.binding.nlink !== 1)
      throw new Error("已记录的当日交付报告存在额外硬链接");
    actualDigest = evidence?.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { authorizedPath, recordedDigest, actualDigest };
}

function mhlForDelivery(task: BackupTask, run: DailyDeliveryRun) {
  const created = new Date(run.completedAt || Date.now()).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>\n<hashlist version="1.1"><creator><name>Kocpy</name><date>${xml(created)}</date></creator><process><note>${xml(`Daily delivery from immutable task ${task.id}`)}</note></process><hashes>${run.files
    .map(
      (file) =>
        `<hash><file>${xml(path.join("Media", file.relativePath))}</file><size>${file.size}</size><sha256>${file.deliveredChecksum}</sha256><metadata><source_task>${xml(task.id)}</source_task><shooting_date>${xml(run.shootingDate)}</shooting_date></metadata></hash>`,
    )
    .join("")}</hashes></hashlist>\n`;
}

async function terminalVerifyDailyDelivery(
  run: DailyDeliveryRun,
  records: FileRecord[],
  sourceBindings: Map<string, BoundDeliveryFile>,
  sourceRoot: string,
  destinationParentPath: string,
  destinationParent: BoundDeliveryDirectory,
  finalDirectory: BoundDeliveryDirectory,
  mediaDirectory: BoundDeliveryDirectory,
) {
  const evidence = new Map(run.files.map((file) => [file.relativePath, file])),
    verifiedBindings = new Map<string, BoundDeliveryFile>();
  if (evidence.size !== records.length || evidence.size !== run.totalFiles)
    throw new Error("当日交付终检范围与已确认文件不一致");
  const [sourceIdentityBefore, destinationIdentityBefore] = await Promise.all([
    volumeIdentity(sourceRoot),
    volumeIdentity(destinationParentPath),
  ]);
  assertDailyDeliveryVolumeIdentity(
    run.sourceVolumeIdentity,
    run.sourceVolumeUuid,
    run.sourceVolumeId,
    sourceIdentityBefore,
    "完整素材卷副本",
  );
  assertDailyDeliveryVolumeIdentity(
    run.destinationVolumeIdentity,
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    destinationIdentityBefore,
    "交付目的地",
  );
  await assertDeliveryRootChain(
    run,
    destinationParent,
    finalDirectory,
    mediaDirectory,
  );
  for (const record of records) {
    const fileEvidence = evidence.get(record.relativePath),
      source = sourceBindings.get(record.relativePath);
    if (!fileEvidence || !source)
      throw new Error(`当日交付终检缺少文件证据：${record.relativePath}`);
    const parent = await bindDeliveryTargetParent(
        run,
        mediaDirectory,
        record.relativePath,
        false,
        async () => {
          throw new Error("当日交付终检不允许创建目录");
        },
      ),
      output = path.join(parent.path, path.posix.basename(record.relativePath)),
      actual = await hashBoundDeliveryFile(
        output,
        `当日交付终检文件：${record.relativePath}`,
        parent,
      );
    if (!actual)
      throw new Error(`当日交付终检发现文件缺失：${record.relativePath}`);
    assertIndependentDeliveryFile(
      actual.binding,
      source,
      `当日交付终检文件：${record.relativePath}`,
    );
    if (
      actual.binding.size !== record.size ||
      actual.sha256 !== fileEvidence.sourceChecksum ||
      actual.sha256 !== fileEvidence.deliveredChecksum
    )
      throw new Error(`当日交付终检 SHA-256 不一致：${record.relativePath}`);
    verifiedBindings.set(record.relativePath, actual.binding);
    await assertDeliveryRootChain(
      run,
      destinationParent,
      finalDirectory,
      mediaDirectory,
    );
  }
  const [sourceIdentity, destinationIdentity] = await Promise.all([
    volumeIdentity(sourceRoot),
    volumeIdentity(destinationParentPath),
  ]);
  assertDailyDeliveryVolumeIdentity(
    run.sourceVolumeIdentity,
    run.sourceVolumeUuid,
    run.sourceVolumeId,
    sourceIdentity,
    "完整素材卷副本",
  );
  assertDailyDeliveryVolumeIdentity(
    run.destinationVolumeIdentity,
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    destinationIdentity,
    "交付目的地",
  );
  await assertDeliveryRootChain(
    run,
    destinationParent,
    finalDirectory,
    mediaDirectory,
  );
  return verifiedBindings;
}

async function recheckTerminalDeliveryBindings(
  run: DailyDeliveryRun,
  records: FileRecord[],
  terminalBindings: Map<string, BoundDeliveryFile>,
  sourceBindings: Map<string, BoundDeliveryFile>,
  destinationParentPath: string,
  destinationParent: BoundDeliveryDirectory,
  finalDirectory: BoundDeliveryDirectory,
  mediaDirectory: BoundDeliveryDirectory,
) {
  if (terminalBindings.size !== records.length)
    throw new Error("当日交付完成前文件身份范围不完整");
  assertDailyDeliveryVolumeIdentity(
    run.destinationVolumeIdentity,
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    await volumeIdentity(destinationParentPath),
    "交付目的地",
  );
  await assertDeliveryRootChain(
    run,
    destinationParent,
    finalDirectory,
    mediaDirectory,
  );
  for (const record of records) {
    const expected = terminalBindings.get(record.relativePath),
      source = sourceBindings.get(record.relativePath);
    if (!expected || !source)
      throw new Error(`当日交付完成前缺少文件身份：${record.relativePath}`);
    const parent = await bindDeliveryTargetParent(
        run,
        mediaDirectory,
        record.relativePath,
        false,
        async () => {
          throw new Error("当日交付完成前复核不允许创建目录");
        },
      ),
      output = path.join(parent.path, path.posix.basename(record.relativePath)),
      actual = await readBoundDeliveryFile(
        output,
        `当日交付完成前文件：${record.relativePath}`,
        undefined,
        parent,
      );
    if (!actual || !sameStableDeliveryFileBinding(actual, expected))
      throw new Error(`当日交付文件在终检后发生变化：${record.relativePath}`);
    assertIndependentDeliveryFile(
      actual,
      source,
      `当日交付完成前文件：${record.relativePath}`,
    );
  }
  await assertDeliveryRootChain(
    run,
    destinationParent,
    finalDirectory,
    mediaDirectory,
  );
}

async function assertExactDailyDeliveryMediaTree(
  run: DailyDeliveryRun,
  records: FileRecord[],
  mediaDirectory: BoundDeliveryDirectory,
) {
  const expectedFiles = new Set(records.map((record) => record.relativePath)),
    expectedDirectories = new Set<string>();
  for (const relativePath of expectedFiles) {
    const parts = relativePath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      expectedDirectories.add(current);
    }
  }
  const foundFiles = new Set<string>();
  const walk = async (
    directory: BoundDeliveryDirectory,
    relativeDirectory: string,
  ): Promise<void> => {
    await assertBoundDeliveryDirectory(directory, "当日交付 Media 树目录");
    for (const entry of await fs.readdir(directory.path, {
      withFileTypes: true,
    })) {
      const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name,
        absolutePath = path.join(directory.path, entry.name),
        stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink())
        throw new Error(`当日交付 Media 树包含符号链接：${relativePath}`);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath))
          throw new Error(`当日交付 Media 树包含未登记目录：${relativePath}`);
        const child = await bindDeliveryDirectory(
          absolutePath,
          `当日交付 Media 子目录 ${relativePath}`,
        );
        await assertDeliveryDirectoryVolume(
          run,
          child,
          `当日交付 Media 子目录 ${relativePath}`,
        );
        assertRecordedDeliveryDirectory(
          child,
          run.directoryBindings?.parents?.[relativePath],
          `当日交付 Media 子目录 ${relativePath}`,
        );
        await walk(child, relativePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || !expectedFiles.has(relativePath))
        throw new Error(`当日交付 Media 树包含未登记或非独立文件：${relativePath}`);
      foundFiles.add(relativePath);
    }
  };
  await walk(mediaDirectory, "");
  if (
    foundFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((relativePath) => !foundFiles.has(relativePath))
  )
    throw new Error("当日交付 Media 树与确认范围不一致");
}

/**
 * Copy a confirmed shooting-day subset from one verified card copy. The
 * immutable full-card backup and its original manifests are never modified.
 */
export async function executeDailyDeliveryRun(
  task: BackupTask,
  plan: CardDateAllocationPlan,
  run: DailyDeliveryRun,
  checkpoint: (run: DailyDeliveryRun) => Promise<void> = async () => {},
  hooks: DailyDeliveryExecutionHooks = {},
) {
  const records = selectedRecords(task, plan, run.shootingDate);
  if (run.sourceTaskId !== task.id) throw new Error("当日交付不属于该素材卷");
  if (run.allocationDigest !== cardDateAllocationDigest(plan))
    throw new Error("日期归属已被修改，请新建交付任务");
  const sourceDestinationIndex = task.destinations.findIndex(
      (destination) => destination.id === run.sourceDestinationId,
    ),
    sourceDestination = task.destinations[sourceDestinationIndex];
  if (
    sourceDestinationIndex < 0 ||
    !sourceDestination?.verified ||
    !sourceDestination.resolvedPath
  )
    throw new Error("完整素材卷副本已不再可用或校验状态已变化");
  const sourceRoot = await canonical(run.sourceRoot),
    destinationParent = await canonical(run.destinationParent),
    finalPath = path.join(destinationParent, path.basename(run.finalPath)),
    sourceRootDirectory = await bindDeliveryDirectory(
      sourceRoot,
      "完整素材卷根目录",
    ),
    destinationParentDirectory = await bindDeliveryDirectory(
      destinationParent,
      "交付目的地父目录",
    );
  if ((await canonical(sourceDestination.resolvedPath)) !== sourceRoot)
    throw new Error("完整素材卷副本路径与任务记录不一致，已停止写入");
  if (finalPath !== run.finalPath)
    throw new Error("交付目的地解析结果发生变化，已停止写入");
  const sourceIdentity = await volumeIdentity(sourceRoot),
    destinationIdentity = await volumeIdentity(destinationParent);
  assertDailyDeliveryVolumeIdentity(
    run.sourceVolumeIdentity,
    run.sourceVolumeUuid,
    run.sourceVolumeId,
    sourceIdentity,
    "完整素材卷副本",
  );
  assertDailyDeliveryVolumeIdentity(
    run.destinationVolumeIdentity,
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    destinationIdentity,
    "交付目的地",
  );
  assertRecordedDeliveryDirectory(
    destinationParentDirectory,
    run.directoryBindings?.destinationParent,
    "交付目的地父目录",
  );
  await validatePaths(sourceRoot, [destinationParent]);
  const markerPath = path.join(finalPath, ".kocpy-daily-delivery.json"),
    ownershipPath = dailyDeliveryOwnershipPath(run);
  let existingMarker: DailyDeliveryRun | undefined,
    finalDirectory: BoundDeliveryDirectory,
    bootstrapOwnership = false;
  try {
    const stat = await fs.lstat(finalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("交付最终路径已存在且不是安全目录");
    finalDirectory = await bindDeliveryDirectory(finalPath, "当日交付最终目录");
    existingMarker = await readMarker(markerPath, finalDirectory);
    if (!existingMarker) {
      const ownership = await readDailyDeliveryOwnership(
        ownershipPath,
        run,
        destinationParentDirectory,
      );
      if (!ownership)
        throw new Error("交付最终目录已存在且不属于本次任务，禁止覆盖或合并");
      if (
        !sameDeliveryDirectoryBinding(
          ownership.directoryBindings?.finalPath,
          finalDirectory,
        )
      )
        throw new Error("交付最终目录已被同名真实目录替换，已停止恢复");
      run.directoryBindings = structuredClone(ownership.directoryBindings);
      bootstrapOwnership = true;
      await assertBootstrapDeliveryDirectory(
        finalPath,
        markerPath,
        run.id,
        ownership.directoryBindings?.mediaRoot,
      );
    } else if (existingMarker.id !== run.id) {
      throw new Error("交付最终目录已存在且不属于本次任务，禁止覆盖或合并");
    }
    const immutableMarkerFields = [
        "sourceTaskId",
        "shootingDate",
        "sourceDestinationId",
        "sourceRoot",
        "destinationParent",
        "finalPath",
        "allocationDigest",
        "totalFiles",
        "totalBytes",
      ] as const,
      markerToValidate = existingMarker;
    if (
      markerToValidate &&
      (immutableMarkerFields.some(
        (field) => markerToValidate[field] !== run[field],
      ) ||
        JSON.stringify(markerToValidate.sourceVolumeIdentity) !==
          JSON.stringify(run.sourceVolumeIdentity) ||
        JSON.stringify(markerToValidate.destinationVolumeIdentity) !==
          JSON.stringify(run.destinationVolumeIdentity) ||
        !sameDeliveryDirectoryBinding(
          markerToValidate.directoryBindings?.destinationParent,
          destinationParentDirectory,
        ) ||
        !sameDeliveryDirectoryBinding(
          markerToValidate.directoryBindings?.finalPath,
          finalDirectory,
        ) ||
        (markerToValidate.directoryBindings?.mediaRoot &&
          run.directoryBindings?.mediaRoot &&
          !sameDeliveryDirectoryBinding(
            markerToValidate.directoryBindings.mediaRoot,
            run.directoryBindings.mediaRoot,
          )) ||
        (markerToValidate.directoryBindings?.reportDirectory &&
          run.directoryBindings?.reportDirectory &&
          !sameDeliveryDirectoryBinding(
            markerToValidate.directoryBindings.reportDirectory,
            run.directoryBindings.reportDirectory,
          )) ||
        (markerToValidate.directoryBindings?.recoveryDirectory &&
          run.directoryBindings?.recoveryDirectory &&
          !sameDeliveryDirectoryBinding(
            markerToValidate.directoryBindings.recoveryDirectory,
            run.directoryBindings.recoveryDirectory,
          )))
    )
      throw new Error("当日交付恢复标记与权威任务记录不一致，已停止写入");
    const expected = new Map(
      records.map((record) => [record.relativePath, record]),
    );
    if (
      markerToValidate &&
      (new Set(markerToValidate.files.map((file) => file.relativePath)).size !==
        markerToValidate.files.length ||
        markerToValidate.files.some(
          (file) =>
            !expected.has(file.relativePath) ||
            expected.get(file.relativePath)!.size !== file.size,
        ))
    )
      throw new Error("当日交付恢复标记包含范围外文件，已停止写入");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const ownership = await acquireDailyDeliveryOwnership(
      ownershipPath,
      run,
      destinationParentDirectory,
    );
    bootstrapOwnership = true;
    try {
      await fs.mkdir(finalPath, { recursive: false });
    } catch (mkdirError) {
      if (ownership.created)
        await releaseDailyDeliveryOwnership(
          ownershipPath,
          run,
          destinationParentDirectory,
        ).catch(() => undefined);
      throw mkdirError;
    }
    finalDirectory = await bindDeliveryDirectory(
      finalPath,
      "当日交付最终目录",
    );
    await assertDeliveryDirectoryVolume(run, finalDirectory, "当日交付最终目录");
    run.directoryBindings!.finalPath =
      recordedDeliveryDirectory(finalDirectory);
    await updateDailyDeliveryOwnership(
      ownershipPath,
      run,
      destinationParentDirectory,
    );
    await hooks.afterFinalDirectoryCreated?.();
  }
  const resumedFiles = new Map(
    run.files.map((file) => [file.relativePath, file]),
  );
  for (const file of existingMarker?.files || [])
    resumedFiles.set(file.relativePath, file);
  const resumedDirectoryBindings = structuredClone(run.directoryBindings)!;
  if (
    !resumedDirectoryBindings.mediaRoot &&
    existingMarker?.directoryBindings?.mediaRoot
  )
    resumedDirectoryBindings.mediaRoot =
      existingMarker.directoryBindings.mediaRoot;
  if (
    !resumedDirectoryBindings.reportDirectory &&
    existingMarker?.directoryBindings?.reportDirectory
  )
    resumedDirectoryBindings.reportDirectory =
      existingMarker.directoryBindings.reportDirectory;
  if (
    !resumedDirectoryBindings.recoveryDirectory &&
    existingMarker?.directoryBindings?.recoveryDirectory
  )
    resumedDirectoryBindings.recoveryDirectory =
      existingMarker.directoryBindings.recoveryDirectory;
  const resumedParents = Object.create(null) as Record<
    string,
    { dev: number; ino: number }
  >;
  for (const [relativePath, binding] of Object.entries({
    ...(run.directoryBindings?.parents || {}),
    ...(existingMarker?.directoryBindings?.parents || {}),
  }))
    Object.defineProperty(resumedParents, relativePath, {
      value: binding,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  resumedDirectoryBindings.parents = resumedParents;
  const resumedFileList = [...resumedFiles.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  run = {
    ...run,
    files: resumedFileList,
    completedFiles: resumedFileList.length,
    completedBytes: resumedFileList.reduce((sum, file) => sum + file.size, 0),
    deliveryJournal:
      existingMarker?.deliveryJournal || run.deliveryJournal,
    publicationInProgress:
      existingMarker?.publicationInProgress || run.publicationInProgress,
    recoveryArtifacts: [
      ...new Set([
        ...(run.recoveryArtifacts || []),
        ...(existingMarker?.recoveryArtifacts || []),
      ]),
    ],
    directoryBindings: resumedDirectoryBindings,
    status: "running",
    startedAt: existingMarker?.startedAt || run.startedAt || Date.now(),
    error: undefined,
  };
  assertRecordedDeliveryDirectory(
    finalDirectory!,
    run.directoryBindings?.finalPath,
    "当日交付最终目录",
  );
  const mediaRoot = path.join(finalPath, "Media");
  let mediaDirectory: BoundDeliveryDirectory;
  const mediaStat = await fs.lstat(mediaRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (mediaStat) {
    mediaDirectory = await bindDeliveryDirectory(mediaRoot, "当日交付 Media 目录");
    assertRecordedDeliveryDirectory(
      mediaDirectory,
      run.directoryBindings?.mediaRoot,
      "当日交付 Media 目录",
    );
  } else {
    if (run.directoryBindings?.mediaRoot || existingMarker)
      throw new Error("已记录的当日交付 Media 目录缺失，已停止恢复");
    await assertDeliveryRootChain(
      run,
      destinationParentDirectory,
      finalDirectory!,
    );
    await fs.mkdir(mediaRoot, { recursive: false, mode: 0o755 });
    mediaDirectory = await bindDeliveryDirectory(mediaRoot, "当日交付 Media 目录");
    await assertDeliveryDirectoryVolume(run, mediaDirectory, "当日交付 Media 目录");
    run.directoryBindings!.mediaRoot = recordedDeliveryDirectory(mediaDirectory);
    if (bootstrapOwnership)
      await updateDailyDeliveryOwnership(
        ownershipPath,
        run,
        destinationParentDirectory,
      );
    await hooks.afterMediaDirectoryCreated?.();
  }
  await assertDeliveryRootChain(
    run,
    destinationParentDirectory,
    finalDirectory!,
    mediaDirectory,
  );
  if (
    estimateDailyDeliveryJournalBytes(run, records) >
    maxDailyDeliveryMetadataBytes
  )
    throw new Error(
      "当日交付恢复日志预计超过安全上限，尚未复制任何交付文件；请缩小单次交付范围",
    );
  const journalPath = path.join(finalPath, dailyDeliveryJournalFileName),
    journalPartialPath = path.join(
      finalPath,
      dailyDeliveryJournalPartialName(run.id),
    ),
    journalExists = Boolean(
      await fs.lstat(journalPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
    ),
    journalPartialExists = Boolean(
      await fs.lstat(journalPartialPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }),
    );
  if (run.deliveryJournal && !journalExists && !journalPartialExists)
    throw new Error("已持久化的当日交付恢复日志缺失，已停止恢复");
  const loadedJournal =
    journalExists && !(bootstrapOwnership && journalPartialExists)
      ? await loadDailyDeliveryJournal(run, finalDirectory!, records)
      : await createDailyDeliveryJournal(run, finalDirectory!, records);
  await hooks.afterJournalCreated?.();
  let journalBinding = loadedJournal.binding;
  run.files = [...loadedJournal.files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  run.completedFiles = run.files.length;
  run.completedBytes = run.files.reduce((sum, file) => sum + file.size, 0);
  run.publicationInProgress = loadedJournal.publicationInProgress;
  run.directoryBindings!.parents = loadedJournal.parents;
  run.directoryBindings!.reportDirectory = loadedJournal.reportDirectory;
  run.directoryBindings!.recoveryDirectory =
    loadedJournal.recoveryDirectory;
  run.recoveryArtifacts = await scanDailyDeliveryRecoveryArtifacts(
    run,
    finalDirectory!,
  );
  const appendJournal = async (
    type: Exclude<DailyDeliveryJournalEventType, "header">,
    payload: unknown,
  ) => {
    journalBinding = await appendDailyDeliveryJournal(
      run,
      finalDirectory!,
      journalBinding,
      type,
      payload,
    );
  };
  await writeJsonAtomic(markerPath, run, finalDirectory!);
  await checkpoint(run);
  if (bootstrapOwnership)
    await releaseDailyDeliveryOwnership(
      ownershipPath,
      run,
      destinationParentDirectory,
    );
  try {
    const completed = new Map(
      run.files.map((file) => [file.relativePath, file] as const),
    ),
      sourceBindings = new Map<string, BoundDeliveryFile>();
    let completedBytes = run.completedBytes;
    for (const record of records) {
      await assertBoundDeliveryDirectory(
        sourceRootDirectory,
        "完整素材卷根目录",
      );
      await assertDeliveryRootChain(
        run,
        destinationParentDirectory,
        finalDirectory!,
        mediaDirectory,
      );
      const destinationRecord = record.destinations[sourceDestinationIndex];
      if (!destinationRecord?.verified)
        throw new Error(`所选完整副本未通过该文件校验：${record.relativePath}`);
      const sourceFile = await canonical(destinationRecord.path);
      if (!inside(sourceFile, sourceRoot))
        throw new Error(
          `完整副本文件路径越出素材卷目录：${record.relativePath}`,
        );
      const sourceHashes = await dualHashFile(
          sourceFile,
          task.hashAlgorithm,
          () =>
            hooks.afterSourceEvidenceRead?.(sourceFile, record.relativePath),
        ),
        sourceOriginalChecksum = sourceHashes.other;
      await assertBoundDeliveryDirectory(
        sourceRootDirectory,
        "完整素材卷根目录",
      );
      if (sourceHashes.binding.size !== record.size)
        throw new Error(`完整副本文件大小与记录不一致：${record.relativePath}`);
      if (sourceOriginalChecksum !== record.srcChecksum)
        throw new Error(
          `完整副本内容已偏离原始校验记录：${record.relativePath}`,
        );
      const sourceSha256 = sourceHashes.sha256,
        sourceBinding = sourceHashes.binding,
        existing = completed.get(record.relativePath);
      sourceBindings.set(record.relativePath, sourceBinding);
      const targetParent = await bindDeliveryTargetParent(
          run,
          mediaDirectory,
          record.relativePath,
          true,
          async (relativePath, binding) => {
            await appendJournal("parent-bound", {
              relativePath,
              ...binding,
            });
          },
          true,
        ),
        output = path.join(targetParent.path, path.posix.basename(record.relativePath));
      if ((await safeChild(mediaRoot, record.relativePath)) !== output)
        throw new Error(`交付目录在写入前发生变化：${record.relativePath}`);
      if (existing?.verified) {
        const actual = await hashBoundDeliveryFile(
          output,
          `已记录的交付文件：${record.relativePath}`,
          targetParent,
        );
        if (!actual)
          throw new Error(`已记录的交付文件不存在：${record.relativePath}`);
        assertIndependentDeliveryFile(
          actual.binding,
          sourceBinding,
          `已记录的交付文件：${record.relativePath}`,
        );
        if (
          actual.sha256 !== existing.deliveredChecksum ||
          actual.sha256 !== sourceSha256
        )
          throw new Error(`已记录的交付文件发生变化：${record.relativePath}`);
        continue;
      }
      const staging = `${output}.partial-${run.id}`;
      const ownsPublication =
        run.publicationInProgress?.relativePath === record.relativePath &&
        run.publicationInProgress.stagingPath === staging &&
        run.publicationInProgress.finalPath === output;
      const outputEntry = await fs.lstat(output).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (outputEntry) {
        if (!ownsPublication)
          throw new Error(
            `交付位置已有未登记文件，已保留并停止：${record.relativePath}`,
          );
        const recovered = await recoverPublishedDelivery(
          staging,
          output,
          sourceBinding,
          sourceSha256,
          targetParent,
        );
        if (recovered) {
          const evidence = {
            relativePath: record.relativePath,
            size: record.size,
            sourceChecksum: sourceSha256,
            sourceVerifiedAt: Date.now(),
            deliveredChecksum: recovered,
            verified: true,
          } satisfies DailyDeliveryRun["files"][number];
          completed.set(record.relativePath, evidence);
          run.files.push(evidence);
          completedBytes += evidence.size;
          run.publicationInProgress = undefined;
          run.completedFiles = completed.size;
          run.completedBytes = completedBytes;
          await appendJournal("file-complete", evidence);
          await hooks.afterFileCompleted?.(record.relativePath);
          hooks.onProgress?.(run.completedFiles, run.completedBytes);
          if (run.completedFiles === 1) await checkpoint(run);
          continue;
        }
        await preserveGeneratedArtifact(
          output,
          run,
          "incomplete",
          targetParent,
          finalDirectory!,
          async (binding) => {
            await appendJournal("recovery-directory-bound", binding);
          },
        );
      }
      let stagedEvidence = await hashBoundDeliveryFile(
        staging,
        `当日交付临时文件：${record.relativePath}`,
        targetParent,
      );
      if (stagedEvidence) {
        assertIndependentDeliveryFile(
          stagedEvidence.binding,
          sourceBinding,
          `当日交付临时文件：${record.relativePath}`,
        );
        if (stagedEvidence.sha256 !== sourceSha256) {
          await preserveGeneratedArtifact(
            staging,
            run,
            "invalid",
            targetParent,
            finalDirectory!,
            async (binding) => {
              await appendJournal("recovery-directory-bound", binding);
            },
          );
          stagedEvidence = undefined;
        }
      }
      if (!stagedEvidence) {
        await copyBoundDeliveryFileExclusive(
          sourceFile,
          staging,
          sourceBinding,
          targetParent,
        );
        stagedEvidence = await hashBoundDeliveryFile(
          staging,
          `当日交付临时文件：${record.relativePath}`,
          targetParent,
        );
        if (!stagedEvidence)
          throw new Error(`交付临时文件写入后不存在：${record.relativePath}`);
        assertIndependentDeliveryFile(
          stagedEvidence.binding,
          sourceBinding,
          `当日交付临时文件：${record.relativePath}`,
        );
        if (stagedEvidence.sha256 !== sourceSha256)
          throw new Error(`交付写入后校验失败：${record.relativePath}`);
        await syncBoundDeliveryFile(
          staging,
          stagedEvidence.binding,
          `当日交付临时文件：${record.relativePath}`,
          targetParent,
        );
      }
      if (!ownsPublication) {
        run.publicationInProgress = {
          relativePath: record.relativePath,
          stagingPath: staging,
          finalPath: output,
        };
        await appendJournal("publication-intent", run.publicationInProgress);
        await hooks.afterPublicationIntentPersisted?.(record.relativePath);
        if (completed.size === 0) await checkpoint(run);
      }
      await publishDeliveryExclusive(
        staging,
        output,
        stagedEvidence.binding,
        sourceBinding,
        targetParent,
        () =>
          hooks.afterPublicationLinked?.(
            staging,
            output,
            record.relativePath,
          ),
      );
      await assertDeliveryRootChain(
        run,
        destinationParentDirectory,
        finalDirectory!,
        mediaDirectory,
      );
      await assertDeliveryDirectoryVolume(run, targetParent, "当日交付文件目标父目录");
      const deliveredChecksum = sourceSha256,
        evidence = {
        relativePath: record.relativePath,
        size: record.size,
        sourceChecksum: sourceSha256,
        sourceVerifiedAt: Date.now(),
        deliveredChecksum,
        verified: true,
      } satisfies DailyDeliveryRun["files"][number];
      completed.set(record.relativePath, evidence);
      run.files.push(evidence);
      completedBytes += evidence.size;
      run.publicationInProgress = undefined;
      run.completedFiles = completed.size;
      run.completedBytes = completedBytes;
      await appendJournal("file-complete", evidence);
      await hooks.afterFileCompleted?.(record.relativePath);
      hooks.onProgress?.(run.completedFiles, run.completedBytes);
      if (run.completedFiles === 1) await checkpoint(run);
    }
    run.files = [...completed.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
    if (
      run.files.length !== run.totalFiles ||
      run.completedBytes !== run.totalBytes
    )
      throw new Error("交付文件统计与确认范围不一致");
    await assertExactDailyDeliveryMediaTree(run, records, mediaDirectory);
    const terminalBindings = await terminalVerifyDailyDelivery(
      run,
      records,
      sourceBindings,
      sourceRoot,
      destinationParent,
      destinationParentDirectory,
      finalDirectory!,
      mediaDirectory,
    );
    await hooks.afterInitialTerminalVerification?.();
    run.completedAt ||= Date.now();
    const base = `Kocpy_${run.shootingDate.replace(/-/g, "")}_${run.id.slice(0, 8)}`,
      hadReportDirectoryBinding = Boolean(
        run.directoryBindings?.reportDirectory,
      ),
      jsonArtifact = await authorizeBoundDailyDeliveryArtifact(
        run,
        `${base}_当日交付清单.json`,
        true,
      );
    if (!hadReportDirectoryBinding) {
      const reportBinding = run.directoryBindings?.reportDirectory;
      if (!reportBinding)
        throw new Error("当日交付报告目录创建后没有可持久化身份");
      await appendJournal("report-directory-bound", reportBinding);
    }
    const mhlArtifact = await authorizeBoundDailyDeliveryArtifact(
        run,
        `${base}_当日交付清单.mhl`,
      ),
      jsonPath = jsonArtifact.target,
      mhlPath = mhlArtifact.target,
      completedSnapshot: DailyDeliveryRun = { ...run, status: "completed" },
      jsonValue = JSON.stringify(
        {
          schemaVersion: 1,
          application: "Kocpy",
          generatedAt: run.completedAt,
          sourceTask: {
            id: task.id,
            name: task.name,
            originalHashAlgorithm: task.hashAlgorithm,
            immutableFullCardPath: sourceRoot,
          },
          delivery: completedSnapshot,
          evidenceBoundary:
            "本清单证明所列当日交付文件与所选完整素材卷副本一致；不替代完整素材卷备份、历史清单或人工签收。",
        },
        null,
        2,
      ),
      mhlValue = mhlForDelivery(task, completedSnapshot),
      jsonDigest = createHash("sha256").update(jsonValue).digest("hex"),
      mhlDigest = createHash("sha256").update(mhlValue).digest("hex");
    if (jsonArtifact.parent.path !== mhlArtifact.parent.path)
      throw new Error("当日交付清单授权目录不一致");
    // The report directory identity must be durable before the first artifact
    // byte is written, otherwise a crash could leave an unowned directory.
    await writeJsonAtomic(markerPath, run, finalDirectory!);
    await checkpoint(run);
    await assertDeliveryRootChain(
      run,
      destinationParentDirectory,
      finalDirectory!,
      mediaDirectory,
    );
    await writeGeneratedArtifactIdempotent(
      jsonPath,
      jsonValue,
      jsonArtifact.parent,
    );
    await assertDeliveryRootChain(
      run,
      destinationParentDirectory,
      finalDirectory!,
      mediaDirectory,
    );
    await writeGeneratedArtifactIdempotent(
      mhlPath,
      mhlValue,
      mhlArtifact.parent,
    );
    const jsonFinalBinding = await verifyGeneratedArtifactFinal(
        jsonPath,
        jsonDigest,
        jsonArtifact.parent,
      ),
      mhlFinalBinding = await verifyGeneratedArtifactFinal(
        mhlPath,
        mhlDigest,
        mhlArtifact.parent,
      );
    await recheckTerminalDeliveryBindings(
      run,
      records,
      terminalBindings,
      sourceBindings,
      destinationParent,
      destinationParentDirectory,
      finalDirectory!,
      mediaDirectory,
    );
    await recheckGeneratedArtifactBinding(
      jsonPath,
      jsonFinalBinding,
      jsonArtifact.parent,
    );
    await recheckGeneratedArtifactBinding(
      mhlPath,
      mhlFinalBinding,
      mhlArtifact.parent,
    );
    await assertExactDailyDeliveryMediaTree(run, records, mediaDirectory);
    const finalRecoveryArtifacts = await scanDailyDeliveryRecoveryArtifacts(
      run,
      finalDirectory!,
    );
    if (
      canonicalJson(finalRecoveryArtifacts) !==
      canonicalJson([...(run.recoveryArtifacts || [])].sort())
    )
      throw new Error("当日交付异常文件恢复证据在完成前发生变化");
    run.manifestPaths = [jsonPath, mhlPath];
    run.status = "completed";
    await checkpoint(run);
    const marker = await readBoundDeliveryFile(
      markerPath,
      "已完成的当日交付恢复标记",
      undefined,
      finalDirectory!,
    );
    if (!marker || marker.nlink !== 1)
      throw new Error("已完成的当日交付恢复标记身份异常，Kocpy 未删除");
    await unlinkBoundDeliveryFile(
      markerPath,
      marker,
      "已完成的当日交付恢复标记",
      finalDirectory!,
    );
    await syncDirectory(finalPath);
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(markerPath, run, finalDirectory!).catch(() => undefined);
    await checkpoint(run).catch(() => undefined);
    throw error;
  }
}

export function dailyDeliveryReportHtml(
  task: BackupTask,
  run: DailyDeliveryRun,
) {
  const formatBytes = (bytes: number) => {
    const units = ["B", "KB", "MB", "GB", "TB"],
      index = bytes
        ? Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)))
        : 0;
    return `${(bytes / 1024 ** index).toLocaleString("zh-CN", { maximumFractionDigits: index > 1 ? 2 : 0 })} ${units[index]}`;
  };
  const rows = run.files
    .map(
      (file) =>
        `<tr><td>${xml(file.relativePath)}</td><td>${formatBytes(file.size)}</td><td>${xml(file.deliveredChecksum)}</td><td>${file.verified ? "通过" : "未通过"}</td></tr>`,
    )
    .join("");
  return Buffer.from(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{font-family:-apple-system,"PingFang SC",sans-serif;color:#24212c;padding:28px;font-size:11px}.cover{background:linear-gradient(135deg,#1b1e26,#6254a8);color:#fff;border-radius:16px;padding:26px}.cover h1{margin:0 0 8px;font-size:24px}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.summary div,.section{border:1px solid #e5e1eb;border-radius:10px;padding:14px}.summary strong{display:block;font-size:19px}.summary span{color:#777;font-size:9px}.section{margin-top:12px}.path{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:8px;border-bottom:1px solid #eee;text-align:left;overflow-wrap:anywhere}th{background:#eee9ff}.notice{background:#fff8e9;border-color:#e9c16c}@page{size:A4;margin:12mm}@media print{body{padding:0}}</style></head><body><div class="cover"><h1>Kocpy · 当日交付校验报告</h1><div>${xml(run.projectNameSnapshot || "未关联项目")} · ${xml(run.shootingDate)}</div><div>报告编号 ${xml(run.id.toUpperCase())}</div></div><div class="summary"><div><strong>${run.totalFiles}</strong><span>FILES / 交付文件</span></div><div><strong>${formatBytes(run.totalBytes)}</strong><span>DATA / 交付数据量</span></div><div><strong>${run.status === "completed" ? "通过" : "未完成"}</strong><span>SHA-256 独立回读</span></div></div><div class="section"><h2>交付范围</h2><p>完整素材卷：${xml(task.name)}（任务 ${xml(task.id)}）</p><p class="path">来源：${xml(run.sourceRoot)}</p><p class="path">目的地：${xml(run.finalPath)}</p><p>操作人：${xml(run.operator)} · 开始 ${run.startedAt ? new Date(run.startedAt).toLocaleString("zh-CN") : "-"} · 完成 ${run.completedAt ? new Date(run.completedAt).toLocaleString("zh-CN") : "-"}</p></div><div class="section notice"><h2>证据边界</h2><p>本报告证明所列文件由一个校验通过的完整素材卷副本生成，并在交付位置重新读取 SHA-256 一致。它不修改或替代完整素材卷，不证明未选择的文件可以删除，也不等同于人工签收。</p></div><div class="section"><h2>文件明细</h2><table><thead><tr><th>相对路径</th><th>大小</th><th>交付 SHA-256</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>`,
    "utf8",
  );
}

/** Read one file once and return both SHA-256 and its recorded hash. */
async function dualHashFile(
  file: string,
  other: HashAlgorithm,
  afterRead?: () => Promise<void> | void,
) {
  const sha256 = createHash("sha256"),
    secondary =
      other === "xxhash32"
        ? new XxHash32()
        : other === "sha256"
          ? sha256
          : createHash(other),
    binding = await readBoundDeliveryFile(
      file,
      "完整素材卷源文件",
      (chunk) => {
        sha256.update(chunk);
        if (secondary !== sha256) secondary.update(chunk);
      },
    );
  if (!binding) throw new Error("完整素材卷源文件不存在");
  await afterRead?.();
  const primary = sha256.digest("hex");
  return {
    binding,
    sha256: primary,
    other:
      secondary === sha256
        ? primary
        : secondary instanceof XxHash32
          ? secondary.digestDecimal()
          : secondary.digest("hex"),
  };
}
