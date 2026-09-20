import { createHash } from "node:crypto";
import path from "node:path";
import { validateArchiveEvidence } from "./archive-evidence";
import { validateCompletionActionRecords } from "./completion-automation";
import { validateAutomaticReportRecord } from "./automatic-report";
import { validateFileRecordMatrix } from "./inventory-baseline";
import type { ArchiveEvidenceState, BackupTask, ProjectConfig } from "./types";

export const WORKSPACE_SCHEMA = 2;
export const LEGACY_WORKSPACE_SCHEMA = 1;

export interface WorkspaceTombstone {
  id: string;
  deletedAt: number;
  revision: number;
}

export interface WorkspaceMigration {
  from: "legacy-json-and-catalog" | "catalog-recovery";
  migratedAt: number;
  taskSources: { json: number; catalog: number };
  projectSources: { json: number; catalog: number };
  archiveSources?: { health: number; changes: number; reminders: number };
}

export interface WorkspaceState {
  schemaVersion: number;
  revision: number;
  committedAt: number;
  tasks: BackupTask[];
  projects: ProjectConfig[];
  taskTombstones: WorkspaceTombstone[];
  projectTombstones: WorkspaceTombstone[];
  archiveEvidence?: ArchiveEvidenceState;
  migration?: WorkspaceMigration;
  digest: string;
}

export type WorkspaceStateInput = Omit<WorkspaceState, "digest">;

export interface SealedWorkspaceDocument {
  state: WorkspaceState;
  serialized: string;
}

const safeRelativePath = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 4096 &&
  !path.isAbsolute(value) &&
  !value.split(/[\\/]/).includes("..") &&
  !value.includes("\0");

const allocationRelativePath = (value: unknown) =>
  safeRelativePath(value) &&
  typeof value === "string" &&
  value !== "." &&
  !value.includes("\\") &&
  path.posix.normalize(value) === value &&
  !value.split("/").includes(".") &&
  !value.split("/").includes("");

const finiteTimestamp = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const safeInteger = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const sha256 = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const validDate = (value: unknown) => {
  if (typeof value !== "string") return false;
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
};

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
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const safeSegment = (value: string) =>
  value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 100);

const clipFamily = (relativePath: string) => {
  const parsed = path.parse(relativePath.normalize("NFC")),
    stem = parsed.name
      .replace(/\s*\(\d+\)$/i, "")
      .replace(/(?:[_\-.](?:proxy|prox|preview|thumb|thumbnail))$/i, "")
      .toLocaleLowerCase("en-US");
  return `${parsed.dir.normalize("NFC").toLocaleLowerCase("en-US")}\0${stem || parsed.name.toLocaleLowerCase("en-US")}`;
};

const allocationSourceDigest = (task: BackupTask) => {
  const facts = task.fileRecords
    .map((record) => ({
      relativePath: record.relativePath.normalize("NFC"),
      size: record.size,
      checksum: record.srcChecksum,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
};

const allocationGroupId = (relativePaths: string[]) =>
  createHash("sha256")
    .update([...relativePaths].sort().join("\0"))
    .digest("hex")
    .slice(0, 24);

const allocationDigest = (task: BackupTask) => {
  const plan = task.dateAllocation!;
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
};

function validateDateAllocation(task: BackupTask) {
  const plan = task.dateAllocation;
  if (plan === undefined) return;
  if (
    !plan ||
    plan.schemaVersion !== 1 ||
    plan.sourceTaskId !== task.id ||
    !finiteTimestamp(plan.generatedAt) ||
    !finiteTimestamp(plan.updatedAt) ||
    plan.updatedAt < plan.generatedAt ||
    !Array.isArray(plan.groups)
  )
    throw new Error("素材日期归属结构无效");
  const records = new Map<string, BackupTask["fileRecords"][number]>(),
    normalizedPaths = new Set<string>(),
    expectedFamilies = new Map<string, BackupTask["fileRecords"]>();
  for (const record of task.fileRecords) {
    const normalized = record?.relativePath?.normalize?.("NFC");
    if (
      !record ||
      !allocationRelativePath(record.relativePath) ||
      records.has(record.relativePath) ||
      normalizedPaths.has(normalized) ||
      !safeInteger(record.size) ||
      typeof record.srcChecksum !== "string" ||
      !record.srcChecksum
    )
      throw new Error("素材日期归属所依据的文件记录无效或重复");
    records.set(record.relativePath, record);
    normalizedPaths.add(normalized);
    const family = clipFamily(record.relativePath);
    expectedFamilies.set(family, [
      ...(expectedFamilies.get(family) || []),
      record,
    ]);
  }
  if (
    !task.fileRecords.length ||
    plan.sourceEvidenceDigest !== allocationSourceDigest(task) ||
    plan.groups.length !== expectedFamilies.size
  )
    throw new Error("素材日期归属与任务文件证据不一致");

  const seenGroupIds = new Set<string>(),
    seenPaths = new Set<string>(),
    expectedById = new Map(
      [...expectedFamilies.values()].map((familyRecords) => {
        const relativePaths = familyRecords
            .map((record) => record.relativePath)
            .sort((left, right) => left.localeCompare(right)),
          id = allocationGroupId(relativePaths);
        return [
          id,
          {
            relativePaths,
            files: familyRecords.length,
            bytes: familyRecords.reduce((sum, record) => sum + record.size, 0),
            label: path.basename(
              familyRecords[0].relativePath,
              path.extname(familyRecords[0].relativePath),
            ),
          },
        ] as const;
      }),
    );
  for (const group of plan.groups) {
    if (
      !group ||
      typeof group.id !== "string" ||
      !/^[a-f0-9]{24}$/.test(group.id) ||
      seenGroupIds.has(group.id) ||
      typeof group.label !== "string" ||
      !group.label ||
      group.label.length > 1024 ||
      !Array.isArray(group.relativePaths) ||
      !group.relativePaths.length ||
      !safeInteger(group.files) ||
      !safeInteger(group.bytes) ||
      ![
        "embedded-media",
        "path-date",
        "file-modified-time",
        "user-confirmed",
        "unknown",
      ].includes(group.suggestionBasis) ||
      !["high", "review", "unknown"].includes(group.suggestionConfidence) ||
      !Array.isArray(group.evidence) ||
      group.evidence.some(
        (item) => typeof item !== "string" || item.length > 4096,
      ) ||
      (group.suggestedDate !== undefined && !validDate(group.suggestedDate)) ||
      (group.assignedDate !== undefined && !validDate(group.assignedDate)) ||
      (group.confirmedAt === undefined) !== (group.confirmedBy === undefined) ||
      (group.confirmedAt !== undefined &&
        (!finiteTimestamp(group.confirmedAt) ||
          group.confirmedAt < plan.generatedAt ||
          typeof group.confirmedBy !== "string" ||
          !group.confirmedBy.trim() ||
          group.confirmedBy.length > 512)) ||
      (group.assignedDate !== undefined && group.confirmedAt === undefined)
    )
      throw new Error("素材日期归属分组结构无效");
    seenGroupIds.add(group.id);
    const expected = expectedById.get(group.id);
    if (
      !expected ||
      group.label !== expected.label ||
      group.files !== expected.files ||
      group.bytes !== expected.bytes ||
      group.relativePaths.length !== expected.relativePaths.length ||
      group.relativePaths.some(
        (relativePath, index) =>
          !allocationRelativePath(relativePath) ||
          relativePath !== expected.relativePaths[index] ||
          !records.has(relativePath) ||
          seenPaths.has(relativePath),
      )
    )
      throw new Error("素材日期归属分组与任务文件记录不一致");
    for (const relativePath of group.relativePaths) seenPaths.add(relativePath);
  }
  if (seenPaths.size !== records.size)
    throw new Error("素材日期归属未完整覆盖任务文件记录");
}

function validDailyDeliveryVolumeIdentity(value: unknown) {
  if (value === undefined) return true;
  const identity = value as Record<string, unknown>;
  return Boolean(
    identity &&
      typeof identity.id === "string" &&
      identity.id.length > 0 &&
      identity.id.length <= 1024 &&
      typeof identity.name === "string" &&
      identity.name.length > 0 &&
      identity.name.length <= 1024 &&
      typeof identity.device === "string" &&
      identity.device.length > 0 &&
      identity.device.length <= 1024 &&
      (identity.uuid === undefined ||
        (typeof identity.uuid === "string" && identity.uuid.length <= 1024)) &&
      (identity.deviceNode === undefined ||
        (typeof identity.deviceNode === "string" &&
          identity.deviceNode.length <= 4096)) &&
      (identity.mountPoint === undefined || strictAbsolutePath(identity.mountPoint)) &&
      (identity.fileSystem === undefined ||
        (typeof identity.fileSystem === "string" &&
          identity.fileSystem.length <= 1024)) &&
      (identity.mountSourceDigest === undefined ||
        sha256(identity.mountSourceDigest))
  );
}

const validDailyDeliveryDirectoryIdentity = (value: unknown) => {
  const identity = value as { dev?: unknown; ino?: unknown } | undefined;
  return Boolean(
    identity &&
      Number.isSafeInteger(identity.dev) &&
      Number(identity.dev) >= 0 &&
      Number.isSafeInteger(identity.ino) &&
      Number(identity.ino) >= 0,
  );
};

function validDailyDeliveryDirectoryBindings(value: unknown) {
  if (value === undefined) return true;
  const bindings = value as NonNullable<
    BackupTask["dailyDeliveryRuns"]
  >[number]["directoryBindings"];
  if (
    !bindings ||
    !validDailyDeliveryDirectoryIdentity(bindings.destinationParent) ||
    (bindings.finalPath !== undefined &&
      !validDailyDeliveryDirectoryIdentity(bindings.finalPath)) ||
    (bindings.mediaRoot !== undefined &&
      !validDailyDeliveryDirectoryIdentity(bindings.mediaRoot)) ||
    (bindings.reportDirectory !== undefined &&
      !validDailyDeliveryDirectoryIdentity(bindings.reportDirectory)) ||
    (bindings.recoveryDirectory !== undefined &&
      !validDailyDeliveryDirectoryIdentity(bindings.recoveryDirectory)) ||
    (bindings.mediaRoot !== undefined && bindings.finalPath === undefined) ||
    (bindings.reportDirectory !== undefined && bindings.finalPath === undefined) ||
    (bindings.recoveryDirectory !== undefined &&
      bindings.finalPath === undefined) ||
    (bindings.parents !== undefined &&
      (typeof bindings.parents !== "object" ||
        bindings.parents === null ||
        Array.isArray(bindings.parents) ||
        bindings.mediaRoot === undefined))
  )
    return false;
  return Object.entries(bindings.parents || {}).every(
    ([relativePath, identity]) =>
      allocationRelativePath(`${relativePath}/.kocpy-parent-sentinel`) &&
      !relativePath.endsWith("/") &&
      validDailyDeliveryDirectoryIdentity(identity),
  );
}

function validDailyDeliveryJournal(value: unknown) {
  if (value === undefined) return true;
  const journal = value as Record<string, unknown>;
  return Boolean(
    journal &&
      journal.schemaVersion === 1 &&
      journal.fileName === ".kocpy-daily-delivery.journal.ndjson" &&
      safeInteger(journal.sequence) &&
      Number(journal.sequence) >= 0 &&
      sha256(journal.headSha256) &&
      safeInteger(journal.byteLength) &&
      Number(journal.byteLength) > 0 &&
      Number(journal.byteLength) <= 128 * 1024 * 1024
  );
}

function validateDailyDeliveryRuns(task: BackupTask) {
  const runs = task.dailyDeliveryRuns;
  if (runs === undefined) return;
  if (!Array.isArray(runs)) throw new Error("当日交付记录结构无效");
  if (!task.dateAllocation && runs.length)
    throw new Error("当日交付记录缺少日期归属依据");
  const runIds = new Set<string>(),
    plan = task.dateAllocation,
    currentAllocationDigest = plan ? allocationDigest(task) : "";
  for (const run of runs) {
    const requiresCurrentAllocation = [
      "pending",
      "running",
      "interrupted",
    ].includes(run?.status);
    if (
      !run ||
      typeof run.id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        run.id,
      ) ||
      runIds.has(run.id) ||
      run.sourceTaskId !== task.id ||
      run.projectId !== task.projectId ||
      (run.projectNameSnapshot !== undefined &&
        (typeof run.projectNameSnapshot !== "string" ||
          run.projectNameSnapshot.length > 512)) ||
      !validDate(run.shootingDate) ||
      typeof run.operator !== "string" ||
      !run.operator.trim() ||
      run.operator.length > 512 ||
      !finiteTimestamp(run.createdAt) ||
      (run.startedAt !== undefined &&
        (!finiteTimestamp(run.startedAt) || run.startedAt < run.createdAt)) ||
      (run.completedAt !== undefined &&
        (!finiteTimestamp(run.completedAt) ||
          run.completedAt < (run.startedAt || run.createdAt))) ||
      !["pending", "running", "interrupted", "completed", "failed"].includes(
        run.status,
      ) ||
      typeof run.sourceDestinationId !== "string" ||
      !run.sourceDestinationId ||
      !strictAbsolutePath(run.sourceRoot) ||
      typeof run.sourceVolumeId !== "string" ||
      !run.sourceVolumeId ||
      run.sourceVolumeId.length > 1024 ||
      (run.sourceVolumeUuid !== undefined &&
        (typeof run.sourceVolumeUuid !== "string" ||
          !run.sourceVolumeUuid ||
          run.sourceVolumeUuid.length > 1024)) ||
      !validDailyDeliveryVolumeIdentity(run.sourceVolumeIdentity) ||
      !strictAbsolutePath(run.destinationParent) ||
      !strictAbsolutePath(run.finalPath) ||
      typeof run.destinationVolumeId !== "string" ||
      !run.destinationVolumeId ||
      run.destinationVolumeId.length > 1024 ||
      (run.destinationVolumeUuid !== undefined &&
        (typeof run.destinationVolumeUuid !== "string" ||
          !run.destinationVolumeUuid ||
          run.destinationVolumeUuid.length > 1024)) ||
      !validDailyDeliveryVolumeIdentity(run.destinationVolumeIdentity) ||
      !validDailyDeliveryDirectoryBindings(run.directoryBindings) ||
      !validDailyDeliveryJournal(run.deliveryJournal) ||
      path.dirname(run.finalPath) !== run.destinationParent ||
      run.finalPath !==
        path.join(
          run.destinationParent,
          safeSegment(
            `${run.shootingDate.replace(/-/g, "")}_${task.name}_当日交付`,
          ),
        ) ||
      run.finalPath === run.destinationParent ||
      insidePath(run.sourceRoot, run.destinationParent) ||
      insidePath(run.destinationParent, run.sourceRoot) ||
      run.hashAlgorithm !== "sha256" ||
      !sha256(run.allocationDigest) ||
      (requiresCurrentAllocation &&
        run.allocationDigest !== currentAllocationDigest) ||
      !safeInteger(run.totalFiles) ||
      run.totalFiles < 1 ||
      !safeInteger(run.totalBytes) ||
      !safeInteger(run.completedFiles) ||
      !safeInteger(run.completedBytes) ||
      run.completedFiles > run.totalFiles ||
      run.completedBytes > run.totalBytes ||
      !Array.isArray(run.files)
    )
      throw new Error("当日交付记录结构、标识或路径无效");
    runIds.add(run.id);

    const sourceDestinations = task.destinations.filter(
      (destination) => destination.id === run.sourceDestinationId,
    );
    if (
      sourceDestinations.length !== 1 ||
      (sourceDestinations[0].resolvedPath !== undefined &&
        !strictAbsolutePath(sourceDestinations[0].resolvedPath))
    )
      throw new Error("当日交付来源目的地标识无效或不唯一");

    const currentSelectedPaths = new Set(
        plan!.groups
          .filter((group) => group.assignedDate === run.shootingDate)
          .flatMap((group) => group.relativePaths),
      ),
      currentSelectedRecords = new Map(
        task.fileRecords
          .filter((record) => currentSelectedPaths.has(record.relativePath))
          .map((record) => [record.relativePath, record]),
      ),
      currentSelectedBytes = [...currentSelectedRecords.values()].reduce(
        (sum, record) => sum + record.size,
        0,
      ),
      taskRecords = new Map(
        task.fileRecords.map((record) => [record.relativePath, record]),
      ),
      taskBytes = task.fileRecords.reduce(
        (sum, record) => sum + record.size,
        0,
      ),
      evidenceScope = requiresCurrentAllocation
        ? currentSelectedRecords
        : taskRecords;
    if (requiresCurrentAllocation) {
      if (
        !currentSelectedRecords.size ||
        currentSelectedRecords.size !== currentSelectedPaths.size ||
        run.totalFiles !== currentSelectedRecords.size ||
        run.totalBytes !== currentSelectedBytes
      )
        throw new Error("当日交付范围与已确认日期归属不一致");
    } else if (
      run.totalFiles > taskRecords.size ||
      run.totalBytes > taskBytes
    ) {
      throw new Error("历史当日交付范围超过任务文件证据");
    }

    const evidencePaths = new Set<string>();
    let evidenceBytes = 0;
    for (const evidence of run.files) {
      const record = evidence && evidenceScope.get(evidence.relativePath);
      if (
        !evidence ||
        !allocationRelativePath(evidence.relativePath) ||
        evidencePaths.has(evidence.relativePath) ||
        !record ||
        evidence.size !== record.size ||
        !safeInteger(evidence.size) ||
        !sha256(evidence.sourceChecksum) ||
        !sha256(evidence.deliveredChecksum) ||
        (task.hashAlgorithm === "sha256" &&
          evidence.sourceChecksum !== record.srcChecksum) ||
        evidence.sourceChecksum !== evidence.deliveredChecksum ||
        evidence.verified !== true ||
        !finiteTimestamp(evidence.sourceVerifiedAt) ||
        evidence.sourceVerifiedAt < run.createdAt
      )
        throw new Error("当日交付文件证据无效或越出确认范围");
      evidencePaths.add(evidence.relativePath);
      evidenceBytes += evidence.size;
    }
    if (
      run.completedFiles !== run.files.length ||
      run.completedBytes !== evidenceBytes ||
      (run.status === "completed" &&
        (run.completedFiles !== run.totalFiles ||
          run.completedBytes !== run.totalBytes ||
          run.completedAt === undefined)) ||
      (run.status === "pending" &&
        (run.startedAt !== undefined ||
          run.completedAt !== undefined ||
          run.files.length > 0)) ||
      (["running", "completed"].includes(run.status) &&
        run.error !== undefined) ||
      (["interrupted", "failed"].includes(run.status) &&
        (typeof run.error !== "string" || !run.error.trim())) ||
      (run.error !== undefined &&
        (typeof run.error !== "string" || run.error.length > 8192))
    )
      throw new Error("当日交付状态与完成计数不一致");

    const mediaRoot = path.join(run.finalPath, "Media"),
      expectedOutputs = new Map(
        [...evidenceScope.keys()].map((relativePath) => [
          relativePath,
          path.join(mediaRoot, relativePath),
        ]),
      );
    if (run.publicationInProgress !== undefined) {
      const publication = run.publicationInProgress,
        output = expectedOutputs.get(publication.relativePath);
      if (
        !publication ||
        !output ||
        evidencePaths.has(publication.relativePath) ||
        !strictAbsolutePath(publication.stagingPath) ||
        !strictAbsolutePath(publication.finalPath) ||
        publication.finalPath !== output ||
        publication.stagingPath !== `${output}.partial-${run.id}` ||
        !insidePath(publication.finalPath, mediaRoot) ||
        !insidePath(publication.stagingPath, mediaRoot) ||
        !["running", "interrupted", "failed"].includes(run.status)
      )
        throw new Error("当日交付发布恢复记录不安全");
    }

    if (run.recoveryArtifacts !== undefined) {
      if (!Array.isArray(run.recoveryArtifacts))
        throw new Error("当日交付恢复文件记录无效");
      const unique = new Set<string>();
      const recoveryDirectory = path.join(
        run.finalPath,
        `Kocpy恢复-${run.id}`,
      );
      for (const artifact of run.recoveryArtifacts) {
        const matchesOwnedPath = new RegExp(
          `^[^/]+\\.[a-f0-9]{16}\\.(?:incomplete|invalid)-\\d+-[a-f0-9]{8}$`,
          "i",
        ).test(path.basename(artifact));
        if (
          !strictAbsolutePath(artifact) ||
          path.dirname(artifact) !== recoveryDirectory ||
          !insidePath(artifact, run.finalPath) ||
          unique.has(artifact) ||
          !matchesOwnedPath ||
          run.status === "pending"
        )
          throw new Error("当日交付恢复文件路径不安全");
        unique.add(artifact);
      }
    }

    const reportDirectory = path.join(run.finalPath, "Kocpy报告"),
      base = `Kocpy_${run.shootingDate.replace(/-/g, "")}_${run.id.slice(0, 8)}`,
      expectedManifests = [
        path.join(reportDirectory, `${base}_当日交付清单.json`),
        path.join(reportDirectory, `${base}_当日交付清单.mhl`),
      ],
      expectedReport = path.join(reportDirectory, `${base}_当日交付报告.pdf`);
    if (run.manifestPaths !== undefined) {
      if (
        !Array.isArray(run.manifestPaths) ||
        run.manifestPaths.length !== expectedManifests.length ||
        run.manifestPaths.some(
          (item, index) =>
            !strictAbsolutePath(item) ||
            !insidePath(item, reportDirectory) ||
            item !== expectedManifests[index],
        )
      )
        throw new Error("当日交付清单路径无效");
    }
    if (
      (run.status === "completed" && run.manifestPaths === undefined) ||
      (["pending", "running", "interrupted"].includes(run.status) &&
        run.manifestPaths !== undefined) ||
      (run.manifestPaths !== undefined &&
        (run.completedFiles !== run.totalFiles ||
          run.completedBytes !== run.totalBytes ||
          run.completedAt === undefined))
    )
      throw new Error("当日交付完成状态与清单记录不一致");

    const hasReportState = run.reportStatus !== undefined,
      hasReportPaths = run.reportPaths !== undefined,
      hasReportDigests = run.reportSha256 !== undefined;
    if (!hasReportState) {
      if (hasReportPaths || hasReportDigests || run.reportError !== undefined)
        throw new Error("当日交付报告状态不完整");
    } else {
      if (
        run.status !== "completed" ||
        !["pending", "completed", "failed"].includes(run.reportStatus!) ||
        (run.reportError !== undefined &&
          (typeof run.reportError !== "string" ||
            !run.reportError.trim() ||
            run.reportError.length > 8192)) ||
        (run.reportStatus === "failed") !== (run.reportError !== undefined)
      )
        throw new Error("当日交付报告状态无效");
      if (hasReportPaths !== hasReportDigests)
        throw new Error("当日交付报告路径与摘要不完整");
      if (hasReportPaths) {
        if (
          !Array.isArray(run.reportPaths) ||
          run.reportPaths.length !== 1 ||
          run.reportPaths[0] !== expectedReport ||
          !strictAbsolutePath(run.reportPaths[0]) ||
          !insidePath(run.reportPaths[0], reportDirectory) ||
          !run.reportSha256 ||
          Object.keys(run.reportSha256).length !== 1 ||
          !sha256(run.reportSha256[expectedReport])
        )
          throw new Error("当日交付报告路径或 SHA-256 摘要无效");
      } else if (run.reportStatus !== "failed") {
        throw new Error("当日交付报告尚无可验证的发布证据");
      }
    }
  }
}

function validateTaskSnapshots(task: BackupTask) {
  validateDateAllocation(task);
  validateDailyDeliveryRuns(task);
  const policy = task.inventoryPolicy;
  if (
    policy !== undefined &&
    (!policy ||
      policy.version !== "complete-v2" ||
      !["complete", "filtered"].includes(policy.mode) ||
      !Number.isFinite(policy.createdAt) ||
      typeof policy.includeHidden !== "boolean" ||
      policy.mode !== (policy.includeHidden ? "complete" : "filtered") ||
      policy.includeAppleDouble !== policy.includeHidden ||
      policy.includeSystemMetadata !== policy.includeHidden ||
      policy.includeEmptyDirectories !== true ||
      policy.symlinkPolicy !== "fail" ||
      policy.specialFilePolicy !== "fail")
  )
    throw new Error("任务文件范围策略无效");
  const scope = task.inventoryScope;
  if (scope !== undefined) {
    if (
      !policy ||
      !scope ||
      JSON.stringify(scope.policy) !== JSON.stringify(policy) ||
      !Number.isFinite(scope.capturedAt) ||
      typeof scope.sourcePath !== "string" ||
      !path.isAbsolute(scope.sourcePath) ||
      !/^[a-f0-9]{64}$/.test(scope.fingerprint) ||
      !Number.isSafeInteger(scope.includedFiles) ||
      scope.includedFiles < 0 ||
      scope.includedFiles !== task.totalFiles ||
      !Number.isSafeInteger(scope.includedBytes) ||
      scope.includedBytes < 0 ||
      scope.includedBytes !== task.totalBytes ||
      !Number.isSafeInteger(scope.includedDirectories) ||
      scope.includedDirectories < 0 ||
      !Array.isArray(scope.includedDirectoryPaths) ||
      scope.includedDirectoryPaths.length !== scope.includedDirectories ||
      new Set(scope.includedDirectoryPaths).size !==
        scope.includedDirectoryPaths.length ||
      scope.includedDirectoryPaths.some(
        (item) => !allocationRelativePath(item),
      ) ||
      new Set(scope.includedDirectoryPaths.map((item) => item.normalize("NFC")))
        .size !== scope.includedDirectoryPaths.length ||
      !Number.isSafeInteger(scope.excludedFiles) ||
      scope.excludedFiles < 0 ||
      !Number.isSafeInteger(scope.excludedDirectories) ||
      scope.excludedDirectories < 0 ||
      !Number.isSafeInteger(scope.excludedBytes) ||
      scope.excludedBytes < 0 ||
      !Array.isArray(scope.exclusions) ||
      scope.exclusions.length !==
        scope.excludedFiles + scope.excludedDirectories
    )
      throw new Error("任务文件范围快照无效");
    let excludedBytes = 0,
      excludedFiles = 0,
      excludedDirectories = 0;
    const exclusionPaths = new Set<string>();
    for (const item of scope.exclusions) {
      if (
        !item ||
        !safeRelativePath(item.relativePath) ||
        exclusionPaths.has(item.relativePath) ||
        !["file", "directory"].includes(item.kind) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        !Number.isFinite(item.modifiedAt) ||
        item.reason !== "hidden-by-user-filter"
      )
        throw new Error("任务文件范围排除记录无效");
      exclusionPaths.add(item.relativePath);
      excludedBytes += item.bytes;
      if (item.kind === "file") excludedFiles++;
      else excludedDirectories++;
    }
    if (
      excludedBytes !== scope.excludedBytes ||
      excludedFiles !== scope.excludedFiles ||
      excludedDirectories !== scope.excludedDirectories
    )
      throw new Error("任务文件范围排除汇总不一致");
  }
  const context = task.reportContext;
  if (
    context !== undefined &&
    (!context ||
      !Number.isFinite(context.capturedAt) ||
      (context.projectId !== undefined &&
        (typeof context.projectId !== "string" ||
          context.projectId.length > 512)) ||
      (context.projectName !== undefined &&
        (typeof context.projectName !== "string" ||
          context.projectName.length > 512)) ||
      ![
        "project-selection",
        "task-input",
        "legacy-project-lookup",
        "unassigned",
      ].includes(context.projectNameSource) ||
      (context.shootingDate !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(context.shootingDate)) ||
      !["task-input", "legacy-task-field", "unrecorded"].includes(
        context.shootingDateSource,
      ))
  )
    throw new Error("任务报告上下文快照无效");
  validateAutomaticReportRecord(task);
}

function assertWorkspaceBody(candidate: WorkspaceStateInput) {
  if (
    ![LEGACY_WORKSPACE_SCHEMA, WORKSPACE_SCHEMA].includes(
      candidate.schemaVersion,
    ) ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 1 ||
    !Number.isFinite(candidate.committedAt) ||
    !Array.isArray(candidate.tasks) ||
    !Array.isArray(candidate.projects) ||
    !Array.isArray(candidate.taskTombstones) ||
    !Array.isArray(candidate.projectTombstones)
  )
    throw new Error("工作区状态结构或版本不受支持");
  if (
    candidate.schemaVersion === WORKSPACE_SCHEMA &&
    !candidate.archiveEvidence
  )
    throw new Error("工作区状态缺少归档证据域");
  if (candidate.archiveEvidence)
    validateArchiveEvidence(candidate.archiveEvidence);
  if (
    candidate.tasks.some(
      (task) =>
        !task ||
        typeof task.id !== "string" ||
        !task.id ||
        !Array.isArray(task.fileRecords),
    ) ||
    candidate.projects.some(
      (project) => !project || typeof project.id !== "string" || !project.id,
    ) ||
    [...candidate.taskTombstones, ...candidate.projectTombstones].some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        !item.id ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1 ||
        !Number.isFinite(item.deletedAt),
    )
  )
    throw new Error("工作区状态包含无效的任务、项目或删除记录");
  for (const task of candidate.tasks) {
    validateFileRecordMatrix(task);
    validateCompletionActionRecords(task);
    validateTaskSnapshots(task);
  }
  const taskIds = candidate.tasks.map((task) => task.id),
    projectIds = candidate.projects.map((project) => project.id),
    taskTombstoneIds = candidate.taskTombstones.map((item) => item.id),
    projectTombstoneIds = candidate.projectTombstones.map((item) => item.id),
    taskIdSet = new Set(taskIds),
    projectIdSet = new Set(projectIds);
  if (
    taskIdSet.size !== taskIds.length ||
    projectIdSet.size !== projectIds.length ||
    new Set(taskTombstoneIds).size !== taskTombstoneIds.length ||
    new Set(projectTombstoneIds).size !== projectTombstoneIds.length ||
    taskTombstoneIds.some((id) => taskIdSet.has(id)) ||
    projectTombstoneIds.some((id) => projectIdSet.has(id))
  )
    throw new Error("工作区状态存在重复或互相冲突的标识");
}

export function workspaceDigest(value: WorkspaceStateInput): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sealWorkspaceState(value: WorkspaceStateInput): WorkspaceState {
  return sealWorkspaceDocument(value).state;
}

export function sealWorkspaceDocument(
  value: WorkspaceStateInput,
): SealedWorkspaceDocument {
  assertWorkspaceBody(value);
  const body = JSON.stringify(value),
    digest = createHash("sha256").update(body).digest("hex"),
    state = { ...value, digest };
  return {
    state,
    // The body was already serialized to calculate the authoritative digest.
    // Append the digest without serializing the multi-gigabyte-scale entity
    // arrays a second time.
    serialized: `${body.slice(0, -1)},"digest":${JSON.stringify(digest)}}`,
  };
}

export function validateWorkspaceState(value: unknown): WorkspaceState {
  if (!value || typeof value !== "object")
    throw new Error("工作区状态不是有效对象");
  const candidate = value as WorkspaceState;
  if (!/^[a-f0-9]{64}$/.test(candidate.digest))
    throw new Error("工作区状态结构或版本不受支持");
  const { digest, ...body } = candidate;
  assertWorkspaceBody(body);
  if (workspaceDigest(body) !== digest) throw new Error("工作区状态摘要不匹配");
  return candidate;
}

export function entityDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
