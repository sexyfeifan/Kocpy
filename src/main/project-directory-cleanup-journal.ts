import path from "node:path";
import { promises as fs } from "node:fs";
import type { Storage } from "./storage";
import type {
  ProjectConfig,
  ProjectDirectoryCleanupAudit,
  ProjectDirectoryCleanupAuditTarget,
  ProjectManagedDirectoryRecord,
} from "./types";
import type { ProjectDirectoryCleanupJournal } from "./project-directory-cleanup";

export const PROJECT_DIRECTORY_CLEANUP_JOURNAL =
  "project-directory-cleanup-recovery.json";

let projectDirectoryCleanupMutationInFlight: Promise<unknown> | undefined;

/**
 * The recovery journal is process-global, so its complete mutation transaction
 * must also be process-global. This lock is independent from UI/maintenance
 * orchestration: future callers cannot enter the journal/write/rmdir window in
 * parallel and replace or clear another project's sole recovery authority.
 */
export async function withProjectDirectoryCleanupMutation<T>(
  action: () => Promise<T>,
): Promise<T> {
  if (projectDirectoryCleanupMutationInFlight)
    throw new Error(
      "另一个项目的空目录整理正在执行；请等待完成后重新预览，以免覆盖恢复记录。",
    );
  const current = Promise.resolve().then(action);
  projectDirectoryCleanupMutationInFlight = current;
  try {
    return await current;
  } finally {
    if (projectDirectoryCleanupMutationInFlight === current)
      projectDirectoryCleanupMutationInFlight = undefined;
  }
}

/**
 * The cleanup recovery journal is a single global file. A new cleanup must
 * therefore wait for any prior project's journal to be reconciled; otherwise
 * the second cleanup could replace the only durable evidence for the first.
 * Non-cleanup project operations may keep their narrower, project-local gate.
 */
export function assertProjectDirectoryCleanupJournalIdle(
  journal: ProjectDirectoryCleanupJournal | undefined,
  recoveryError: string | undefined,
  projectId: string,
  scope: "project" | "global" = "project",
) {
  if (!recoveryError && !journal) return;
  if (
    !recoveryError &&
    scope === "project" &&
    journal?.projectId !== projectId
  )
    return;
  const anotherProject = journal && journal.projectId !== projectId;
  throw new Error(
    recoveryError ||
      (anotherProject
        ? "另一个项目有一次空目录整理等待恢复调和。请重启 Kocpy 完成调和；在此之前不会开始新的空目录整理，以免覆盖恢复记录。"
        : "该项目有一次空目录整理等待恢复调和。请重启 Kocpy 完成调和；在此之前不会补目录、重复整理或删除项目。"),
  );
}

function validated(value: unknown): ProjectDirectoryCleanupJournal | undefined {
  if (value === undefined) return undefined;
  const journal = value as Partial<ProjectDirectoryCleanupJournal>;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.id !== "string" ||
    typeof journal.auditId !== "string" ||
    typeof journal.previewId !== "string" ||
    typeof journal.projectId !== "string" ||
    typeof journal.workstationId !== "string" ||
    typeof journal.date !== "string" ||
    typeof journal.operator !== "string" ||
    typeof journal.requestedAt !== "number" ||
    typeof journal.startedAt !== "number" ||
    !Array.isArray(journal.targets) ||
    journal.targets.length > 1_000
  )
    throw new Error("空目录整理恢复日志无效，已停止相关项目目录操作");
  for (const target of journal.targets)
    if (
      !target ||
      typeof target.destinationRoot !== "string" ||
      !path.isAbsolute(target.destinationRoot) ||
      typeof target.relativePath !== "string" ||
      path.isAbsolute(target.relativePath) ||
      target.relativePath.split(/[\\/]+/).some((part) => part === "..") ||
      typeof target.path !== "string" ||
      !path.isAbsolute(target.path) ||
      typeof target.authorized !== "boolean" ||
      !["pending", "removed", "skipped"].includes(target.result)
    )
      throw new Error("空目录整理恢复日志包含无效目标，已停止相关项目目录操作");
  return journal as ProjectDirectoryCleanupJournal;
}

export async function readProjectDirectoryCleanupJournal(storage: Storage) {
  return validated(
    await storage.read<unknown>(PROJECT_DIRECTORY_CLEANUP_JOURNAL, undefined),
  );
}

export async function writeProjectDirectoryCleanupJournal(
  storage: Storage,
  journal: ProjectDirectoryCleanupJournal,
) {
  await storage.write(PROJECT_DIRECTORY_CLEANUP_JOURNAL, validated(journal));
}

export async function clearProjectDirectoryCleanupJournal(storage: Storage) {
  for (const suffix of ["", ".bak"])
    await fs
      .unlink(path.join(storage.root, PROJECT_DIRECTORY_CLEANUP_JOURNAL + suffix))
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
  const directory = await fs.open(storage.root, "r").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return;
  try {
    await directory.sync().catch((error) => {
      if (!new Set(["EINVAL", "ENOTSUP", "EBADF"]).has(error.code || ""))
        throw error;
    });
  } finally {
    await directory.close();
  }
}

function matchingProof(
  project: ProjectConfig,
  journal: ProjectDirectoryCleanupJournal,
  target: ProjectDirectoryCleanupJournal["targets"][number],
): ProjectManagedDirectoryRecord | undefined {
  const proof = (project.managedProjectDirectories || []).find(
    (record) => record.id === target.proofId,
  );
  if (
    !proof ||
    !proof.workstationId ||
    proof.workstationId !== journal.workstationId ||
    path.resolve(proof.destinationRoot) !== path.resolve(target.destinationRoot) ||
    proof.relativePath !== target.relativePath ||
    path.resolve(proof.destinationRoot, proof.relativePath) !==
      path.resolve(target.path)
  )
    return undefined;
  return proof;
}

async function pathState(target: string) {
  try {
    const stat = await fs.lstat(target);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? ("present" as const)
      : ("changed" as const);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "missing" as const;
    return "unknown" as const;
  }
}

/**
 * Reconcile facts only. Recovery never performs rmdir and never converts an
 * uncheckpointed missing path into a confirmed Kocpy deletion.
 */
export async function reconcileProjectDirectoryCleanupJournal(
  projects: ProjectConfig[],
  value: ProjectDirectoryCleanupJournal,
  now = Date.now(),
) {
  const journal = validated(value)!;
  const next = structuredClone(projects),
    project = next.find((item) => item.id === journal.projectId);
  if (!project)
    throw new Error(
      "空目录整理恢复日志对应的项目不存在；日志已保留，相关目录操作继续锁定",
    );
  const existing = project.directoryCleanupAudits?.find(
    (audit) => audit.id === journal.auditId,
  );
  if (existing)
    return { projects: next, audit: existing, changed: false, alreadyApplied: true };

  const targets: ProjectDirectoryCleanupAuditTarget[] = [];
  for (const target of journal.targets) {
    const proof = matchingProof(project, journal, target),
      state = await pathState(target.path),
      checkedAt = target.checkedAt || now;
    if (!target.authorized || !proof) {
      targets.push({
        destinationRoot: target.destinationRoot,
        relativePath: target.relativePath,
        path: target.path,
        result: "skipped",
        reason:
          "恢复日志目标没有可验证的本机创建授权；Kocpy 未删除，也未补写删除结论",
        checkedAt,
      });
      continue;
    }
    if (target.result === "removed") {
      proof.removedAt ||= checkedAt;
      proof.cleanupAuditId = journal.auditId;
      proof.missingObservedAt = undefined;
      targets.push({
        destinationRoot: target.destinationRoot,
        relativePath: target.relativePath,
        path: target.path,
        result: "removed",
        reason:
          state === "present" || state === "changed"
            ? `${target.resultReason || "非递归移除已完成并写入恢复日志"}；恢复检查时路径已重新出现，未再次触碰`
            : target.resultReason || "非递归移除已完成并写入恢复日志",
        checkedAt,
      });
      continue;
    }
    if (target.result === "pending" && state === "missing") {
      proof.missingObservedAt = now;
      proof.cleanupAuditId = journal.auditId;
      targets.push({
        destinationRoot: target.destinationRoot,
        relativePath: target.relativePath,
        path: target.path,
        result: "missing-unconfirmed",
        reason:
          "恢复日志只证明删除已获授权，未记录 rmdir 成功；恢复时目录缺失，原因无法确认，未记作 Kocpy 已删除",
        checkedAt,
      });
      continue;
    }
    targets.push({
      destinationRoot: target.destinationRoot,
      relativePath: target.relativePath,
      path: target.path,
      result: "skipped",
      reason:
        target.result === "skipped"
          ? target.resultReason || "上次检查决定保留该目录"
          : state === "unknown"
            ? "上次整理在结果确认前中断，恢复时无法确认目录状态；未自动继续删除"
            : "上次整理在结果确认前中断，目录当前仍存在；未自动继续删除",
      checkedAt,
    });
  }
  const audit: ProjectDirectoryCleanupAudit = {
    id: journal.auditId,
    previewId: journal.previewId,
    projectId: journal.projectId,
    date: journal.date,
    scheduleKey: journal.scheduleKey,
    operator: journal.operator,
    requestedAt: journal.requestedAt,
    completedAt: now,
    targets,
  };
  project.directoryCleanupAudits = [
    ...(project.directoryCleanupAudits || []),
    audit,
  ];
  return { projects: next, audit, changed: true, alreadyApplied: false };
}
