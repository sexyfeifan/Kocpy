import { constants, createReadStream, promises as fs } from "node:fs";
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
    destinationIdentity = await volumeIdentity(destinationParent);
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
    destinationParent,
    finalPath,
    destinationVolumeId: destinationIdentity.id,
    destinationVolumeUuid: destinationIdentity.uuid,
    hashAlgorithm: "sha256",
    allocationDigest: cardDateAllocationDigest(plan),
    totalFiles: records.length,
    totalBytes,
    completedFiles: 0,
    completedBytes: 0,
    files: [],
  };
}

async function syncFile(file: string) {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function publishExclusive(staging: string, finalPath: string) {
  try {
    await fs.link(staging, finalPath);
    await syncFile(finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code || ""))
      throw error;
    await fs.copyFile(staging, finalPath, constants.COPYFILE_EXCL);
    await syncFile(finalPath);
  }
  await fs.unlink(staging);
  await syncDirectory(path.dirname(finalPath));
}

async function preserveGeneratedArtifact(
  file: string,
  run: DailyDeliveryRun,
  reason: "incomplete" | "invalid",
) {
  const preserved = `${file}.${reason}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  await fs.rename(file, preserved);
  run.recoveryArtifacts = [...(run.recoveryArtifacts || []), preserved];
  return preserved;
}

async function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.partial-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });
  await syncFile(temporary);
  await fs.rename(temporary, file);
  await syncDirectory(path.dirname(file));
}

interface DailyDeliveryOwnershipSidecar {
  schemaVersion: 1;
  runId: string;
  sourceTaskId: string;
  destinationParent: string;
  finalPath: string;
  destinationVolumeId?: string;
  destinationVolumeUuid?: string;
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
    schemaVersion: 1,
    runId: run.id,
    sourceTaskId: run.sourceTaskId,
    destinationParent: run.destinationParent,
    finalPath: run.finalPath,
    destinationVolumeId: run.destinationVolumeId,
    destinationVolumeUuid: run.destinationVolumeUuid,
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
    actual.allocationDigest !== expected.allocationDigest ||
    actual.totalFiles !== expected.totalFiles ||
    actual.totalBytes !== expected.totalBytes ||
    actual.createdAt !== expected.createdAt
  )
    throw new Error(
      "当日交付外部所有权标记与权威任务、路径或磁盘身份不一致，已停止写入",
    );
}

async function readDailyDeliveryOwnership(file: string, run: DailyDeliveryRun) {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("当日交付外部所有权标记不可安全读取，已停止写入");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("所有权标记不是普通文件");
    const serialized = await handle.readFile("utf8"),
      value = JSON.parse(serialized) as unknown;
    assertDailyDeliveryOwnership(value, run);
    return value;
  } catch (error) {
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
  } finally {
    await handle.close();
  }
}

async function acquireDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
) {
  const value = dailyDeliveryOwnership(run),
    serialized = JSON.stringify(value, null, 2);
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
    await readDailyDeliveryOwnership(file, run);
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
  await syncDirectory(path.dirname(file));
  return { created: true as const, value };
}

async function releaseDailyDeliveryOwnership(
  file: string,
  run: DailyDeliveryRun,
) {
  const value = await readDailyDeliveryOwnership(file, run);
  if (!value) return;
  await fs.unlink(file);
  await syncDirectory(path.dirname(file));
}

async function assertBootstrapDeliveryDirectory(
  directory: string,
  markerPath: string,
) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("交付最终路径已存在且不是安全目录");
  const entries = await fs.readdir(directory);
  const partialPrefix = `${path.basename(markerPath)}.partial-`;
  for (const entry of entries) {
    if (!entry.startsWith(partialPrefix))
      throw new Error("当日交付目录在所有权标记完成前出现未知内容，已停止接管");
    const candidate = path.join(directory, entry),
      candidateStat = await fs.lstat(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink())
      throw new Error("当日交付目录的临时标记不是安全普通文件，已停止接管");
  }
  for (const entry of entries) await fs.unlink(path.join(directory, entry));
  if (entries.length) await syncDirectory(directory);
}

async function writeGeneratedArtifactIdempotent(
  file: string,
  value: string | Buffer,
) {
  const expected = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"),
    digest = (input: Buffer) =>
      createHash("sha256").update(input).digest("hex"),
    existing = await fs.readFile(file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (existing) {
    if (digest(existing) !== digest(expected))
      throw new Error(`交付报告位置已有内容不同的文件，Kocpy 未覆盖：${file}`);
    return;
  }
  const temporary = `${file}.partial-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, expected, { flag: "wx" });
  await syncFile(temporary);
  try {
    await publishExclusive(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await fs.readFile(file);
    if (digest(raced) !== digest(expected))
      throw new Error(`交付报告位置已有内容不同的文件，Kocpy 未覆盖：${file}`);
  }
}

async function readMarker(file: string) {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("当日交付恢复标记不可安全读取，已停止写入并保留现有目录");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("恢复标记不是普通文件");
    return JSON.parse(await handle.readFile("utf8")) as DailyDeliveryRun;
  } catch {
    throw new Error("当日交付恢复标记损坏，已停止写入并保留现有目录");
  } finally {
    await handle.close();
  }
}

export interface DailyDeliveryExecutionHooks {
  /** Test-only crash boundary after mkdir and before the in-directory marker. */
  afterFinalDirectoryCreated?: () => Promise<void> | void;
  /** Test-only mutation boundary after one source evidence read and before copy. */
  afterSourceEvidenceRead?: (
    sourceFile: string,
    relativePath: string,
  ) => Promise<void> | void;
}

export async function authorizeDailyDeliveryArtifact(
  run: DailyDeliveryRun,
  fileName: string,
) {
  if (path.basename(fileName) !== fileName || !fileName)
    throw new Error("当日交付报告文件名无效");
  const destinationParent = await canonical(run.destinationParent),
    identity = await volumeIdentity(destinationParent);
  assertVolumeIdentity(
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    identity,
    "交付目的地",
  );
  if (
    !inside(path.resolve(run.finalPath), destinationParent) ||
    path.dirname(path.resolve(run.finalPath)) !== destinationParent
  )
    throw new Error("交付最终目录已经越出原交付目的地，已停止发布报告");
  const expectedFinal = path.join(
    destinationParent,
    path.basename(run.finalPath),
  );
  if (expectedFinal !== run.finalPath)
    throw new Error("交付最终目录路径已经变化，已停止发布报告");
  const finalStat = await fs.lstat(run.finalPath);
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink())
    throw new Error("交付最终目录不再是安全的真实目录");
  const finalRealPath = await fs.realpath(run.finalPath);
  if (finalRealPath !== run.finalPath)
    throw new Error("交付最终目录已通过别名或符号链接重定向");
  const reportDirectory = path.join(run.finalPath, "Kocpy报告");
  try {
    const reportStat = await fs.lstat(reportDirectory);
    if (!reportStat.isDirectory() || reportStat.isSymbolicLink())
      throw new Error("交付报告位置不是安全的真实目录");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(reportDirectory, { recursive: false });
  }
  if ((await fs.realpath(reportDirectory)) !== reportDirectory)
    throw new Error("交付报告目录已通过符号链接重定向");
  const target = path.join(reportDirectory, fileName),
    authorized = await safeChild(
      run.finalPath,
      path.relative(run.finalPath, target),
    );
  if (path.resolve(authorized) !== path.resolve(target))
    throw new Error("交付报告路径越出当日交付目录");
  try {
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink())
      throw new Error("交付报告目标已存在且不是安全的普通文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
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
  const authorizedPath = await authorizeDailyDeliveryArtifact(
    run,
    dailyDeliveryReportFileName(run),
  );
  if (authorizedPath !== target)
    throw new Error("当日交付报告目标已经偏离授权路径");
  const actualSha256 = await hashFile(authorizedPath, "sha256");
  if (actualSha256 !== expectedSha256)
    throw new Error("当日交付报告落盘回读摘要不一致，未记录为完成");
  return { authorizedPath, actualSha256 };
}

export async function reauthorizeRecordedDailyDeliveryReport(
  run: DailyDeliveryRun,
) {
  const recordedPath = run.reportPaths?.[0];
  if (!recordedPath || !run.reportSha256) return undefined;

  // A persisted path is evidence, not authority. Rebuild the only permitted
  // path from the immutable run snapshot and re-check the directory/volume
  // before reading either the recorded digest or the file itself.
  const authorizedPath = await authorizeDailyDeliveryArtifact(
    run,
    dailyDeliveryReportFileName(run),
  );
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
    actualDigest = await hashFile(authorizedPath, "sha256");
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
    finalPath = path.join(destinationParent, path.basename(run.finalPath));
  if ((await canonical(sourceDestination.resolvedPath)) !== sourceRoot)
    throw new Error("完整素材卷副本路径与任务记录不一致，已停止写入");
  if (finalPath !== run.finalPath)
    throw new Error("交付目的地解析结果发生变化，已停止写入");
  const sourceIdentity = await volumeIdentity(sourceRoot),
    destinationIdentity = await volumeIdentity(destinationParent);
  assertVolumeIdentity(
    run.sourceVolumeUuid,
    run.sourceVolumeId,
    sourceIdentity,
    "完整素材卷副本",
  );
  assertVolumeIdentity(
    run.destinationVolumeUuid,
    run.destinationVolumeId,
    destinationIdentity,
    "交付目的地",
  );
  await validatePaths(sourceRoot, [destinationParent]);
  const markerPath = path.join(finalPath, ".kocpy-daily-delivery.json"),
    ownershipPath = dailyDeliveryOwnershipPath(run);
  let existingMarker: DailyDeliveryRun | undefined;
  try {
    const stat = await fs.lstat(finalPath);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("交付最终路径已存在且不是安全目录");
    existingMarker = await readMarker(markerPath);
    if (!existingMarker) {
      if (!(await readDailyDeliveryOwnership(ownershipPath, run)))
        throw new Error("交付最终目录已存在且不属于本次任务，禁止覆盖或合并");
      await assertBootstrapDeliveryDirectory(finalPath, markerPath);
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
      immutableMarkerFields.some(
        (field) => markerToValidate[field] !== run[field],
      )
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
    const ownership = await acquireDailyDeliveryOwnership(ownershipPath, run);
    try {
      await fs.mkdir(finalPath, { recursive: false });
    } catch (mkdirError) {
      if (ownership.created)
        await releaseDailyDeliveryOwnership(ownershipPath, run).catch(
          () => undefined,
        );
      throw mkdirError;
    }
    await hooks.afterFinalDirectoryCreated?.();
  }
  run = {
    ...run,
    files: existingMarker?.files || run.files,
    completedFiles: existingMarker?.completedFiles || run.completedFiles,
    completedBytes: existingMarker?.completedBytes || run.completedBytes,
    publicationInProgress:
      existingMarker?.publicationInProgress || run.publicationInProgress,
    recoveryArtifacts:
      existingMarker?.recoveryArtifacts || run.recoveryArtifacts,
    status: "running",
    startedAt: existingMarker?.startedAt || run.startedAt || Date.now(),
    error: undefined,
  };
  await writeJsonAtomic(markerPath, run);
  await checkpoint(run);
  await releaseDailyDeliveryOwnership(ownershipPath, run);
  const mediaRoot = path.join(finalPath, "Media");
  await fs.mkdir(mediaRoot, { recursive: true });
  try {
    const completed = new Map(
      run.files.map((file) => [file.relativePath, file]),
    );
    for (const record of records) {
      const destinationRecord = record.destinations[sourceDestinationIndex];
      if (!destinationRecord?.verified)
        throw new Error(`所选完整副本未通过该文件校验：${record.relativePath}`);
      const sourceFile = await canonical(destinationRecord.path);
      if (!inside(sourceFile, sourceRoot))
        throw new Error(
          `完整副本文件路径越出素材卷目录：${record.relativePath}`,
        );
      const stat = await fs.stat(sourceFile);
      if (!stat.isFile() || stat.size !== record.size)
        throw new Error(`完整副本文件大小与记录不一致：${record.relativePath}`);
      const sourceHashes = await dualHashFile(
          sourceFile,
          task.hashAlgorithm,
          () =>
            hooks.afterSourceEvidenceRead?.(sourceFile, record.relativePath),
        ),
        sourceOriginalChecksum = sourceHashes.other;
      if (sourceOriginalChecksum !== record.srcChecksum)
        throw new Error(
          `完整副本内容已偏离原始校验记录：${record.relativePath}`,
        );
      const sourceSha256 = sourceHashes.sha256,
        existing = completed.get(record.relativePath),
        output = await safeChild(mediaRoot, record.relativePath);
      await fs.mkdir(path.dirname(output), { recursive: true });
      if ((await safeChild(mediaRoot, record.relativePath)) !== output)
        throw new Error(`交付目录在写入前发生变化：${record.relativePath}`);
      if (existing?.verified) {
        const actual = await hashFile(output, "sha256");
        if (actual !== existing.deliveredChecksum || actual !== sourceSha256)
          throw new Error(`已记录的交付文件发生变化：${record.relativePath}`);
        continue;
      }
      const outputExists = await fs.access(output).then(
        () => true,
        () => false,
      );
      const staging = `${output}.partial-${run.id}`;
      const ownsPublication =
        run.publicationInProgress?.relativePath === record.relativePath &&
        run.publicationInProgress.stagingPath === staging &&
        run.publicationInProgress.finalPath === output;
      if (outputExists) {
        if (!ownsPublication)
          throw new Error(
            `交付位置已有未登记文件，已保留并停止：${record.relativePath}`,
          );
        const recovered = await hashFile(output, "sha256");
        if (recovered === sourceSha256) {
          await fs.unlink(staging).catch(() => undefined);
          completed.set(record.relativePath, {
            relativePath: record.relativePath,
            size: record.size,
            sourceChecksum: sourceSha256,
            sourceVerifiedAt: Date.now(),
            deliveredChecksum: recovered,
            verified: true,
          });
          run.publicationInProgress = undefined;
          run.files = [...completed.values()].sort((left, right) =>
            left.relativePath.localeCompare(right.relativePath),
          );
          run.completedFiles = run.files.length;
          run.completedBytes = run.files.reduce(
            (sum, file) => sum + file.size,
            0,
          );
          await writeJsonAtomic(markerPath, run);
          await checkpoint(run);
          continue;
        }
        await preserveGeneratedArtifact(output, run, "incomplete");
      }
      if (
        await fs.access(staging).then(
          () => true,
          () => false,
        )
      ) {
        const staged = await hashFile(staging, "sha256");
        if (staged !== sourceSha256)
          await preserveGeneratedArtifact(staging, run, "invalid");
      }
      if (
        !(await fs.access(staging).then(
          () => true,
          () => false,
        ))
      ) {
        await fs.copyFile(sourceFile, staging, constants.COPYFILE_EXCL);
        await syncFile(staging);
        const staged = await hashFile(staging, "sha256");
        if (staged !== sourceSha256)
          throw new Error(`交付写入后校验失败：${record.relativePath}`);
      }
      run.publicationInProgress = {
        relativePath: record.relativePath,
        stagingPath: staging,
        finalPath: output,
      };
      await writeJsonAtomic(markerPath, run);
      await checkpoint(run);
      await publishExclusive(staging, output);
      const deliveredChecksum = await hashFile(output, "sha256");
      if (deliveredChecksum !== sourceSha256)
        throw new Error(`交付独立回读校验失败：${record.relativePath}`);
      completed.set(record.relativePath, {
        relativePath: record.relativePath,
        size: record.size,
        sourceChecksum: sourceSha256,
        sourceVerifiedAt: Date.now(),
        deliveredChecksum,
        verified: true,
      });
      run.publicationInProgress = undefined;
      run.files = [...completed.values()].sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      );
      run.completedFiles = run.files.length;
      run.completedBytes = run.files.reduce((sum, file) => sum + file.size, 0);
      await writeJsonAtomic(markerPath, run);
      await checkpoint(run);
    }
    if (
      run.files.length !== run.totalFiles ||
      run.completedBytes !== run.totalBytes
    )
      throw new Error("交付文件统计与确认范围不一致");
    run.completedAt ||= Date.now();
    const base = `Kocpy_${run.shootingDate.replace(/-/g, "")}_${run.id.slice(0, 8)}`,
      jsonPath = await authorizeDailyDeliveryArtifact(
        run,
        `${base}_当日交付清单.json`,
      ),
      mhlPath = await authorizeDailyDeliveryArtifact(
        run,
        `${base}_当日交付清单.mhl`,
      ),
      completedSnapshot: DailyDeliveryRun = { ...run, status: "completed" };
    await authorizeDailyDeliveryArtifact(run, path.basename(jsonPath));
    await writeGeneratedArtifactIdempotent(
      jsonPath,
      JSON.stringify(
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
    );
    await authorizeDailyDeliveryArtifact(run, path.basename(mhlPath));
    await writeGeneratedArtifactIdempotent(
      mhlPath,
      mhlForDelivery(task, completedSnapshot),
    );
    run.manifestPaths = [jsonPath, mhlPath];
    run.status = "completed";
    await checkpoint(run);
    await fs.unlink(markerPath);
    await syncDirectory(finalPath);
    return run;
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(markerPath, run).catch(() => undefined);
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
          : createHash(other);
  for await (const chunk of createReadStream(file, {
    highWaterMark: 4 * 1024 * 1024,
  })) {
    sha256.update(chunk);
    if (secondary !== sha256) secondary.update(chunk);
  }
  await afterRead?.();
  const primary = sha256.digest("hex");
  return {
    sha256: primary,
    other:
      secondary === sha256
        ? primary
        : secondary instanceof XxHash32
          ? secondary.digestDecimal()
          : secondary.digest("hex"),
  };
}
