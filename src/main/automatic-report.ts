import path from "node:path";
import type {
  AutomaticReportRecord,
  AutomaticReportTarget,
  BackupTask,
  Destination,
} from "./types";
import { inside, segment } from "./backup/safety";
import { sha256Bytes } from "./completion-automation";

const reportFileName = (task: Pick<BackupTask, "id" | "name">) =>
  `${segment(task.name)}_${task.id.slice(0, 12).toUpperCase()}_首次完成校验快照.pdf`;

export function automaticReportEligible(task: BackupTask) {
  return Boolean(
    task.automaticReport?.enabled &&
      task.status === "completed" &&
      !task.workstationSources?.length &&
      (!task.provenance || task.provenance === "kocpy-transfer") &&
      task.destinations.length &&
      task.destinations.every(
        (destination) => destination.verified && destination.resolvedPath,
      ),
  );
}

export function automaticReportBlocksDestinationEject(
  task: BackupTask,
  volumePath: string,
) {
  const record = task.automaticReport,
    writing = automaticReportWriteInProgress(task),
    awaitingCompletedTask = Boolean(
      task.status === "completed" &&
        record?.enabled &&
        record.status !== "completed",
    );
  return Boolean(
    (writing || awaitingCompletedTask) &&
      task.destinations.some((destination) =>
        inside(destination.resolvedPath || destination.path, volumePath),
      ),
  );
}

export function automaticReportWriteInProgress(
  task: BackupTask,
  inFlight = false,
) {
  return Boolean(
    inFlight ||
      task.automaticReport?.status === "running" ||
      task.automaticReport?.targets.some(
        (target) => target.status === "publishing",
      ),
  );
}

export function automaticReportBlocksTaskMutation(
  task: BackupTask,
  inFlight = false,
) {
  const record = task.automaticReport;
  return Boolean(
    automaticReportWriteInProgress(task, inFlight) ||
      (task.status === "completed" &&
        record?.enabled &&
        record.status === "pending"),
  );
}

export function expectedAutomaticReportTargets(
  task: Pick<BackupTask, "id" | "name" | "destinations">,
): AutomaticReportTarget[] {
  const fileName = reportFileName(task);
  return task.destinations
    .filter((destination) => destination.verified && destination.resolvedPath)
    .map((destination) => {
      const destinationPath = path.resolve(destination.resolvedPath!),
        reportDirectory = path.join(destinationPath, "Kocpy报告");
      return {
        destinationId: destination.id,
        destinationPath,
        reportDirectory,
        outputPath: path.join(reportDirectory, fileName),
        status: "pending",
        attempts: 0,
      };
    });
}

/**
 * Rebind automatic-report evidence after a verified copy is moved or another
 * fully verified copy is associated with the same logical task. A previously
 * completed digest is retained only as recovery evidence: the next report run
 * must reread that exact file at the new path before it can be completed.
 */
export function reconcileAutomaticReportDestinations(task: BackupTask) {
  const record = task.automaticReport;
  if (!record?.enabled || record.status === "disabled") return record;
  const prior = new Map(
      record.targets.map((target) => [target.destinationId, target] as const),
    ),
    reusable = record.targets.find(
      (target) =>
        target.status === "completed" &&
        /^[a-f0-9]{64}$/.test(target.expectedSha256 || ""),
    ),
    fileName = reportFileName(task);
  record.targets = task.destinations
    .filter((destination) => destination.resolvedPath)
    .map((destination) => {
      const destinationPath = path.resolve(destination.resolvedPath!),
        reportDirectory = path.join(destinationPath, "Kocpy报告"),
        outputPath = path.join(reportDirectory, fileName),
        saved = prior.get(destination.id),
        unchanged =
          saved &&
          path.resolve(saved.destinationPath) === destinationPath &&
          path.resolve(saved.reportDirectory) === reportDirectory &&
          path.resolve(saved.outputPath) === outputPath,
        digestSource =
          !unchanged && saved?.status === "completed" && saved.expectedSha256
            ? saved
            : !saved
              ? reusable
              : undefined;
      if (unchanged && saved) return { ...saved };
      return {
        destinationId: destination.id,
        destinationPath,
        reportDirectory,
        outputPath,
        status: digestSource ? ("publishing" as const) : ("pending" as const),
        attempts: saved?.attempts || 0,
        expectedSha256: digestSource?.expectedSha256,
        bytes: digestSource?.bytes,
        rebindOnly: digestSource ? (true as const) : undefined,
        rebindSourceOutputPath: digestSource?.outputPath,
      };
    });
  record.status = "pending";
  record.completedAt = undefined;
  record.error = undefined;
  return record;
}

export function validateAutomaticReportRecord(task: BackupTask) {
  const record = task.automaticReport;
  if (record === undefined) return;
  if (
    !record ||
    record.schema !== 1 ||
    typeof record.enabled !== "boolean" ||
    !Number.isFinite(record.requestedAt) ||
    (record.generatedAt !== undefined && !Number.isFinite(record.generatedAt)) ||
    typeof record.operationAttemptId !== "string" ||
    !record.operationAttemptId ||
    !["disabled", "pending", "running", "completed", "failed"].includes(
      record.status,
    ) ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0 ||
    !Array.isArray(record.targets) ||
    record.targets.length > task.destinations.length
  )
    throw new Error("任务自动报告记录无效");
  const reportAttempt = task.operationAttempts?.find(
    (attempt) => attempt.id === record.operationAttemptId,
    ),
    historicalRebind = Boolean(
      record.status !== "completed" &&
        reportAttempt?.status === "completed" &&
        reportAttempt.completedAt &&
        record.targets.some((target) => target.rebindOnly) &&
        record.targets.every(
          (target) => target.status === "completed" || target.rebindOnly,
        ),
    );
  if (
    task.operationAttempts?.length
      ? !reportAttempt ||
        (record.status === "completed" &&
          (reportAttempt.status !== "completed" || !reportAttempt.completedAt)) ||
        (record.status !== "completed" &&
          record.operationAttemptId !== task.operationAttemptId &&
          !historicalRebind)
      : record.operationAttemptId !== task.operationAttemptId
  )
    throw new Error("任务自动报告尝试引用无效");
  if (
    (!record.enabled && record.status !== "disabled") ||
    (record.enabled && record.status === "disabled") ||
    (record.status === "completed" &&
      (record.targets.length !== task.destinations.length ||
        record.targets.some((target) => target.status !== "completed")))
  )
    throw new Error("任务自动报告状态不一致");
  const destinationIds = new Set<string>();
  for (const target of record.targets) {
    if (!target || typeof target.destinationId !== "string")
      throw new Error("任务自动报告目标无效");
    const destination = task.destinations.find(
        (item) => item.id === target.destinationId,
      ),
      destinationPath = destination?.resolvedPath
        ? path.resolve(destination.resolvedPath)
        : undefined,
      reportDirectory = destinationPath
        ? path.join(destinationPath, "Kocpy报告")
        : undefined,
      outputPath = reportDirectory
        ? path.join(reportDirectory, reportFileName(task))
        : undefined;
    if (
      destinationIds.has(target.destinationId) ||
      !destination ||
      !destinationPath ||
      path.resolve(target.destinationPath) !== destinationPath ||
      path.resolve(target.reportDirectory) !== reportDirectory ||
      path.resolve(target.outputPath) !== outputPath ||
      !["pending", "publishing", "completed", "failed"].includes(
        target.status,
      ) ||
      !Number.isSafeInteger(target.attempts) ||
      target.attempts < 0 ||
      (target.expectedSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(target.expectedSha256)) ||
      (target.bytes !== undefined &&
        (!Number.isSafeInteger(target.bytes) || target.bytes < 0)) ||
      (target.status === "completed" &&
        (!target.completedAt ||
          !target.expectedSha256 ||
          target.bytes === undefined)) ||
      (target.rebindOnly !== undefined && target.rebindOnly !== true) ||
      (target.rebindSourceOutputPath !== undefined &&
        (!target.rebindOnly || !path.isAbsolute(target.rebindSourceOutputPath))) ||
      (target.rebindOnly &&
        (!target.expectedSha256 || !target.rebindSourceOutputPath))
    )
      throw new Error("任务自动报告目标无效");
    destinationIds.add(target.destinationId);
  }
  if (
    record.status === "completed" &&
    task.destinations.some(
      (destination) => !destinationIds.has(destination.id),
    )
  )
    throw new Error("任务自动报告目标不完整");
}

function validateOrCreateTargets(task: BackupTask) {
  const record = task.automaticReport!;
  const expected = expectedAutomaticReportTargets(task);
  if (!record.targets.length) {
    record.targets = expected;
    return;
  }
  if (record.targets.length !== expected.length)
    throw new Error("自动报告目标与已校验目的地不一致，已停止写入");
  for (const item of expected) {
    const saved = record.targets.find(
      (target) => target.destinationId === item.destinationId,
    );
    if (
      !saved ||
      path.resolve(saved.destinationPath) !== item.destinationPath ||
      path.resolve(saved.reportDirectory) !== item.reportDirectory ||
      path.resolve(saved.outputPath) !== item.outputPath
    )
      throw new Error("自动报告路径与实际备份目录不一致，已停止写入");
  }
}

export interface AutomaticReportDependencies {
  render: () => Promise<Uint8Array>;
  persist: () => Promise<unknown>;
  authorizeTarget: (
    destination: Destination,
    target: AutomaticReportTarget,
  ) => Promise<void>;
  existingSha256: (outputPath: string) => Promise<string | undefined>;
  readArtifact: (outputPath: string) => Promise<Uint8Array>;
  publish: (
    outputPath: string,
    value: Uint8Array,
  ) => Promise<{ path: string; sha256: string }>;
  now?: () => number;
}

/**
 * Publish reports only after the caller has durably persisted the completed
 * backup. Every externally visible write is preceded by another durable
 * `publishing` checkpoint so a restart can recover by comparing the digest.
 */
export async function runAutomaticReport(
  task: BackupTask,
  dependencies: AutomaticReportDependencies,
): Promise<AutomaticReportRecord | undefined> {
  const record = task.automaticReport;
  if (!record || !record.enabled || record.status === "disabled") return record;
  if (!automaticReportEligible(task)) return record;
  if (record.status === "completed") return record;
  const now = dependencies.now || Date.now;
  try {
    validateOrCreateTargets(task);
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
    await dependencies.persist();
    return record;
  }
  record.status = "running";
  record.attempts += 1;
  record.lastAttemptAt = now();
  record.generatedAt ||= task.completedAt || record.requestedAt;
  record.error = undefined;
  for (const target of record.targets) {
    if (target.status === "failed") {
      target.status = "pending";
      target.error = undefined;
    }
  }
  try {
    await dependencies.persist();
  } catch (error) {
    // The running checkpoint is the authority that permits an external report
    // write. If it cannot be made durable, do not render or publish anything.
    // Keep the live task retryable as well: otherwise the in-memory `running`
    // state would block task changes and volume ejection until a restart.
    record.status = "failed";
    record.error = `数据已校验，自动报告启动检查点保存失败；尚未生成或写入报告，可在工作区恢复后重试：${
      error instanceof Error ? error.message : String(error)
    }`;
    try {
      await dependencies.persist();
    } catch {
      // The original workspace failure can also prevent recording the failed
      // state. It still remains failed in memory so the UI can offer a retry;
      // startup recovery will retry any previously durable running checkpoint.
    }
    return record;
  }

  // A crash can happen after exclusive publication but before the completion
  // checkpoint. Recover that exact artifact before rendering again: PDF
  // generators may add their own metadata even when the HTML is frozen.
  for (const target of record.targets) {
    if (target.status === "completed" || !target.expectedSha256) continue;
    const destination = task.destinations.find(
      (item) => item.id === target.destinationId,
    );
    if (!destination) {
      target.status = "failed";
      target.error = "已校验目的地记录不存在";
      await dependencies.persist();
      continue;
    }
    try {
      await dependencies.authorizeTarget(destination, target);
      const existing = await dependencies.existingSha256(target.outputPath);
      if (!existing && target.rebindOnly) {
        const sourcePath = target.rebindSourceOutputPath!,
          sourceDigest = await dependencies.existingSha256(sourcePath);
        if (sourceDigest !== target.expectedSha256)
          throw new Error(
            `无法从原已验证报告恢复字节：${sourcePath}`,
          );
        const value = await dependencies.readArtifact(sourcePath);
        if (sha256Bytes(value) !== target.expectedSha256)
          throw new Error("原已验证报告回读摘要不一致");
        const published = await dependencies.publish(target.outputPath, value);
        if (published.sha256 !== target.expectedSha256)
          throw new Error("重定位报告发布摘要不一致");
        const copied = await dependencies.existingSha256(target.outputPath);
        if (copied !== target.expectedSha256)
          throw new Error("重定位报告落盘后回读摘要不一致");
        target.status = "completed";
        target.completedAt ||= now();
        target.error = undefined;
        await dependencies.persist();
        continue;
      }
      if (!existing) continue;
      if (existing !== target.expectedSha256)
        throw new Error(`目标已有不同内容，Kocpy 未覆盖：${target.outputPath}`);
      target.status = "completed";
      target.completedAt ||= now();
      target.error = undefined;
      await dependencies.persist();
    } catch (error) {
      target.status = "failed";
      target.error = error instanceof Error ? error.message : String(error);
      await dependencies.persist();
    }
  }
  if (record.targets.every((target) => target.status === "completed")) {
    record.status = "completed";
    record.completedAt ||= now();
    record.error = undefined;
    await dependencies.persist();
    return record;
  }

  const renderTargets = record.targets.filter(
    (target) => target.status !== "completed" && !target.rebindOnly,
  );
  if (!renderTargets.length) {
    const failed = record.targets.filter(
      (target) => target.status !== "completed",
    );
    record.status = "failed";
    record.error = `数据已校验；${failed.length} 个重定位报告缺少可验证的原始快照，Kocpy 未重新渲染历史证据。`;
    await dependencies.persist();
    return record;
  }

  let value: Uint8Array;
  try {
    value = await dependencies.render();
  } catch (error) {
    record.status = "failed";
    record.error = `数据已校验，报告生成失败：${
      error instanceof Error ? error.message : String(error)
    }`;
    await dependencies.persist();
    return record;
  }
  const expectedSha256 = sha256Bytes(value);
  for (const target of record.targets) {
    if (target.status === "completed" || target.rebindOnly) continue;
    const destination = task.destinations.find(
      (item) => item.id === target.destinationId,
    );
    if (!destination) {
      target.status = "failed";
      target.error = "已校验目的地记录不存在";
      continue;
    }
    target.status = "publishing";
    target.attempts += 1;
    target.expectedSha256 = expectedSha256;
    target.bytes = value.byteLength;
    target.error = undefined;
    await dependencies.persist();
    try {
      await dependencies.authorizeTarget(destination, target);
      const existing = await dependencies.existingSha256(target.outputPath);
      if (existing) {
        if (existing !== expectedSha256)
          throw new Error(
            `目标已有不同内容，Kocpy 未覆盖：${target.outputPath}`,
          );
      } else {
        const published = await dependencies.publish(target.outputPath, value);
        if (published.sha256 !== expectedSha256)
          throw new Error("报告发布摘要与计划摘要不一致");
      }
      const verified = await dependencies.existingSha256(target.outputPath);
      if (verified !== expectedSha256)
        throw new Error("报告落盘后回读摘要不一致");
      target.status = "completed";
      target.completedAt = now();
      target.error = undefined;
      await dependencies.persist();
    } catch (error) {
      target.status = "failed";
      target.error = error instanceof Error ? error.message : String(error);
      await dependencies.persist();
    }
  }
  const failed = record.targets.filter((target) => target.status !== "completed");
  if (failed.length) {
    record.status = "failed";
    record.error = `数据已校验；${failed.length} 个目的地的报告保存失败，可重试。`;
  } else {
    record.status = "completed";
    record.completedAt = now();
    record.error = undefined;
  }
  await dependencies.persist();
  return record;
}

export function completedAutomaticReportPaths(task: BackupTask) {
  return (task.automaticReport?.targets || [])
    .filter(
      (target) =>
        target.status === "completed" &&
        /^[a-f0-9]{64}$/.test(target.expectedSha256 || ""),
    )
    .map((target) => path.resolve(target.outputPath));
}

export async function verifiedAutomaticReportPaths(
  task: BackupTask,
  readSha256: (outputPath: string) => Promise<string | undefined>,
) {
  const verified: string[] = [];
  for (const outputPath of completedAutomaticReportPaths(task)) {
    const target = task.automaticReport?.targets.find(
      (item) => path.resolve(item.outputPath) === outputPath,
    );
    if (
      target?.expectedSha256 &&
      (await readSha256(outputPath)) === target.expectedSha256
    )
      verified.push(outputPath);
  }
  return verified;
}
