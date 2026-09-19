import path from "node:path";
import type {
  AutomaticReportRecord,
  AutomaticReportTarget,
  BackupTask,
  Destination,
} from "./types";
import { segment } from "./backup/safety";
import { sha256Bytes } from "./completion-automation";

const reportFileName = (task: Pick<BackupTask, "id" | "name">) =>
  `${segment(task.name)}_${task.id.slice(0, 12).toUpperCase()}_自动校验报告.pdf`;

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
    record.operationAttemptId !== task.operationAttemptId ||
    !["disabled", "pending", "running", "completed", "failed"].includes(
      record.status,
    ) ||
    !Number.isSafeInteger(record.attempts) ||
    record.attempts < 0 ||
    !Array.isArray(record.targets) ||
    record.targets.length > task.destinations.length
  )
    throw new Error("任务自动报告记录无效");
  if (
    (!record.enabled && record.status !== "disabled") ||
    (record.status === "completed" &&
      record.targets.some((target) => target.status !== "completed"))
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
          target.bytes === undefined))
    )
      throw new Error("任务自动报告目标无效");
    destinationIds.add(target.destinationId);
  }
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
  await dependencies.persist();

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
    if (target.status === "completed") continue;
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
