import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { compareVolumeIdentity, type VolumeIdentity } from "../common/volume-identity";
import { normalizePositions } from "../common/interaction";
import { shootingDateKey } from "../common/shooting-dates";
import { volumeIdentity } from "./system";
import {
  projectFrameworkPaths,
  projectShootingDates,
} from "./project-path";
import type {
  BackupTask,
  ProjectConfig,
  ProjectDirectoryCleanupAudit,
  ProjectDirectoryCleanupPreview,
  ProjectDirectoryCleanupPreviewTarget,
  ProjectManagedDirectoryRecord,
} from "./types";

export interface ProjectDirectoryCleanupInput {
  date: string;
  scheduleKey?: string;
}

export interface ProjectDirectoryCleanupJournalTarget {
  destinationRoot: string;
  relativePath: string;
  path: string;
  proofId?: string;
  authorized: boolean;
  authorizationReason: string;
  result: "pending" | "removed" | "skipped";
  resultReason?: string;
  checkedAt?: number;
}

export interface ProjectDirectoryCleanupJournal {
  schemaVersion: 1;
  id: string;
  auditId: string;
  previewId: string;
  projectId: string;
  workstationId: string;
  date: string;
  scheduleKey?: string;
  operator: string;
  requestedAt: number;
  startedAt: number;
  targets: ProjectDirectoryCleanupJournalTarget[];
}

export interface ProjectDirectoryCleanupJournalCallbacks {
  /** Must durably persist the full authorization before the first rmdir. */
  beforeMutation: (
    journal: ProjectDirectoryCleanupJournal,
  ) => Promise<void>;
  /** Must durably persist the outcome immediately after every target attempt. */
  checkpoint: (journal: ProjectDirectoryCleanupJournal) => Promise<void>;
}

interface CleanupDependencies {
  identity: (directory: string) => Promise<VolumeIdentity>;
  now: () => number;
  id: () => string;
  workstationId: string;
}

const defaults: CleanupDependencies = {
  identity: volumeIdentity,
  now: Date.now,
  id: randomUUID,
  workstationId: "",
};

const resolved = (value: string) => path.resolve(value);
const sameRoot = (a: string, b: string) => resolved(a) === resolved(b);
const targetKey = (destinationRoot: string, relativePath: string) =>
  `${resolved(destinationRoot)}\0${relativePath}`;
const isStrictChild = (root: string, child: string) => {
  const relative = path.relative(resolved(root), resolved(child));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const pathsOverlap = (a: string, b: string) => {
  const first = resolved(a),
    second = resolved(b);
  if (first === second) return true;
  return isStrictChild(first, second) || isStrictChild(second, first);
};

function scheduleDecisionExists(
  project: ProjectConfig,
  input: ProjectDirectoryCleanupInput,
) {
  const day = shootingDateKey(input.date);
  if (!input.scheduleKey)
    return Boolean(
      project.restDays?.some((value) => shootingDateKey(value) === day),
    );
  return Object.entries(project.unusedDevicesByDate || {})
    .filter(([date]) => shootingDateKey(date) === day)
    .flatMap(([, values]) => values)
    .includes(input.scheduleKey);
}

function frameworkScopes(project: ProjectConfig) {
  if (!project.shootingDateStart) return [];
  return projectShootingDates(
    project.shootingDateStart,
    project.shootingDateEnd || project.shootingDateStart,
  ).flatMap((date) =>
    project.devices.flatMap((device) => {
      const positions = normalizePositions(project.devicePositions?.[device]);
      return (positions.length ? positions : [undefined]).map((position) => ({
        id: `${date}\0${device}\0${position || ""}`,
        date,
        device,
        position,
        scheduleKey: position ? `${device}::${position}` : device,
      }));
    }),
  );
}

/**
 * A pre-card framework path may be shared when a custom naming rule places the
 * card token before date/device tokens or omits those tokens altogether. A
 * cleanup decision can authorize that path only when every scope that owns it
 * is covered by the same decision.
 */
function frameworkPathSharedOutsideDecision(
  project: ProjectConfig,
  input: ProjectDirectoryCleanupInput,
  relativePath: string,
) {
  const date = shootingDateKey(input.date),
    scopes = frameworkScopes(project),
    selected = new Set(
      scopes
        .filter((scope) => {
          if (scope.date !== date) return false;
          if (!input.scheduleKey) return true;
          const [device, position] = input.scheduleKey.split("::");
          return (
            scope.device === device &&
            (!position ||
              scope.position === (position === "unassigned" ? undefined : position))
          );
        })
        .map((scope) => scope.id),
    ),
    owners = scopes.filter((scope) =>
      projectFrameworkPaths(project, scope.date, scope.scheduleKey).includes(
        relativePath,
      ),
    );
  return !owners.length || owners.some((scope) => !selected.has(scope.id));
}

function taskOutputPaths(task: BackupTask): string[] {
  const paths = [task.sourcePath, ...task.destinations.map((item) => item.resolvedPath).filter((item): item is string => Boolean(item))];
  if (task.shootingDateFolder || task.namingTemplate)
    for (const destination of task.destinations)
      paths.push(
        path.join(
          destination.path,
          task.shootingDateFolder || "",
          task.namingTemplate || "",
        ),
      );
  return paths;
}

function referencesTarget(
  project: ProjectConfig,
  tasks: BackupTask[],
  target: string,
) {
  return tasks.some(
    (task) =>
      task.projectId === project.id &&
      taskOutputPaths(task).some((taskPath) => pathsOverlap(taskPath, target)),
  );
}

function proofFor(
  project: ProjectConfig,
  destinationRoot: string,
  relativePath: string,
): ProjectManagedDirectoryRecord | undefined {
  return (project.managedProjectDirectories || [])
    .filter(
      (record) =>
        sameRoot(record.destinationRoot, destinationRoot) &&
        record.relativePath === relativePath,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

async function evaluateTarget(
  project: ProjectConfig,
  tasks: BackupTask[],
  input: ProjectDirectoryCleanupInput,
  destinationRoot: string,
  relativePath: string,
  dependencies: CleanupDependencies,
): Promise<ProjectDirectoryCleanupPreviewTarget> {
  const target = path.join(destinationRoot, relativePath),
    kept = (reason: string, proofId?: string) => ({
      destinationRoot,
      relativePath,
      path: target,
      status: "kept" as const,
      reason,
      proofId,
    });
  if (!scheduleDecisionExists(project, input))
    return kept("对应的未使用或休息决定已不存在");
  if (!isStrictChild(destinationRoot, target))
    return kept("目标不是备份根目录内的安全子目录");
  if (frameworkPathSharedOutsideDecision(project, input, relativePath))
    return kept(
      "该框架目录被其他日期、设备或机位共同使用，不能按当前决定整理",
    );
  const proof = proofFor(project, destinationRoot, relativePath);
  if (!proof) return kept("没有 Kocpy 创建证明，未知或旧目录会保留");
  if (
    !proof.workstationId ||
    proof.workstationId !== dependencies.workstationId
  )
    return kept(
      "创建证明不属于当前工作站，导入或旧记录不能授权本机删除",
      proof.id,
    );
  if (proof.removedAt)
    return kept("此前已按确认策略整理，目录不会被自动重建", proof.id);
  try {
    const destinationStat = await fs.lstat(destinationRoot);
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())
      return kept("备份目的地不是可确认的真实目录", proof.id);
    const destinationRealPath = await fs.realpath(destinationRoot);
    if (destinationRealPath !== proof.destinationRealPath)
      return kept("备份目的地真实路径与创建记录不一致", proof.id);
    const identity = await dependencies.identity(destinationRoot),
      comparison = compareVolumeIdentity(
        proof.volumeUuid,
        proof.volumeId,
        identity,
      );
    if (!new Set(["match", "legacy-match"]).has(comparison))
      return kept(
        comparison === "unavailable"
          ? "目的地磁盘身份暂时无法读取"
          : "目的地磁盘身份与创建记录不一致",
        proof.id,
      );
    const targetStat = await fs.lstat(target);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink())
      return kept("目标已不是普通目录，已安全保留", proof.id);
    const targetRealPath = await fs.realpath(target),
      expectedRealPath = path.join(
        proof.destinationRealPath,
        ...relativePath.split("/"),
      );
    if (targetRealPath !== expectedRealPath)
      return kept("目标真实路径与 Kocpy 创建记录不一致", proof.id);
    if (referencesTarget(project, tasks, target))
      return kept("仍有项目任务引用此路径", proof.id);
    const entries = await fs.readdir(target);
    if (entries.length)
      return kept(
        `目录包含 ${entries.length} 项（隐藏、零字节和临时文件也算内容）`,
        proof.id,
      );
    return {
      destinationRoot,
      relativePath,
      path: target,
      status: "eligible",
      reason: "有 Kocpy 创建证明，目的地身份一致且目录当前为空",
      proofId: proof.id,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT")
      return kept("目录或目的地当前不存在", proof.id);
    return kept(`检查失败：${error?.message || String(error)}`, proof.id);
  }
}

function scopedTargets(
  project: ProjectConfig,
  input: ProjectDirectoryCleanupInput,
) {
  const relatives = projectFrameworkPaths(
    project,
    input.date,
    input.scheduleKey,
  );
  return (project.destinationPaths || []).flatMap((destinationRoot) =>
    relatives.map((relativePath) => ({ destinationRoot, relativePath })),
  );
}

export async function previewProjectDirectoryCleanup(
  project: ProjectConfig,
  tasks: BackupTask[],
  input: ProjectDirectoryCleanupInput,
  overrides: Partial<CleanupDependencies> = {},
): Promise<ProjectDirectoryCleanupPreview> {
  const dependencies = { ...defaults, ...overrides },
    date = shootingDateKey(input.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("拍摄日期无效");
  const normalized = { ...input, date },
    targets = await Promise.all(
      scopedTargets(project, normalized).map(({ destinationRoot, relativePath }) =>
        evaluateTarget(
          project,
          tasks,
          normalized,
          destinationRoot,
          relativePath,
          dependencies,
        ),
      ),
    );
  return {
    id: dependencies.id(),
    projectId: project.id,
    date,
    scheduleKey: input.scheduleKey,
    createdAt: dependencies.now(),
    targets,
  };
}

export async function executeProjectDirectoryCleanup(
  project: ProjectConfig,
  tasks: BackupTask[],
  preview: ProjectDirectoryCleanupPreview,
  operator: string,
  overrides: Partial<CleanupDependencies> = {},
  journalCallbacks?: ProjectDirectoryCleanupJournalCallbacks,
): Promise<{ project: ProjectConfig; audit: ProjectDirectoryCleanupAudit }> {
  if (!operator.trim()) throw new Error("请填写空目录整理操作人");
  if (preview.projectId !== project.id) throw new Error("整理预览不属于当前项目");
  const dependencies = { ...defaults, ...overrides },
    startedAt = dependencies.now();
  if (startedAt - preview.createdAt > 10 * 60 * 1000)
    throw new Error("空目录整理预览已过期，请重新检查");
  const next = structuredClone(project),
    input = { date: preview.date, scheduleKey: preview.scheduleKey },
    currentTargets = new Map(
      (
        await Promise.all(
          scopedTargets(next, input).map(({ destinationRoot, relativePath }) =>
            evaluateTarget(
              next,
              tasks,
              input,
              destinationRoot,
              relativePath,
              dependencies,
            ),
          ),
        )
      ).map((target) => [
        targetKey(target.destinationRoot, target.relativePath),
        target,
      ]),
    ),
    auditId = dependencies.id(),
    journal: ProjectDirectoryCleanupJournal = {
      schemaVersion: 1,
      id: dependencies.id(),
      auditId,
      previewId: preview.id,
      projectId: project.id,
      workstationId: dependencies.workstationId,
      date: preview.date,
      scheduleKey: preview.scheduleKey,
      operator: operator.trim(),
      requestedAt: preview.createdAt,
      startedAt,
      targets: preview.targets.map((shown) => {
        const current = currentTargets.get(
            targetKey(shown.destinationRoot, shown.relativePath),
          ),
          authorized =
            shown.status === "eligible" && current?.status === "eligible";
        return {
          destinationRoot: current?.destinationRoot || shown.destinationRoot,
          relativePath: current?.relativePath || shown.relativePath,
          path: current?.path || shown.path,
          proofId: current?.proofId || shown.proofId,
          authorized,
          authorizationReason: authorized
            ? current!.reason
            : current?.reason || shown.reason || "项目目录策略已变化",
          result: authorized ? "pending" : "skipped",
          resultReason: authorized
            ? undefined
            : current?.reason || shown.reason || "项目目录策略已变化",
          checkedAt: authorized ? undefined : startedAt,
        };
      }),
    },
    targets: ProjectDirectoryCleanupAudit["targets"] = [];

  if (journal.targets.some((target) => target.authorized)) {
    if (!journalCallbacks)
      throw new Error("空目录整理缺少持久化恢复日志，已在写入前停止");
    await journalCallbacks.beforeMutation(structuredClone(journal));
  }

  for (const journalTarget of journal.targets) {
    if (!journalTarget.authorized) {
      targets.push({
        destinationRoot: journalTarget.destinationRoot,
        relativePath: journalTarget.relativePath,
        path: journalTarget.path,
        result: "skipped",
        reason: journalTarget.resultReason || journalTarget.authorizationReason,
        checkedAt: journalTarget.checkedAt || startedAt,
      });
      continue;
    }
    const checkedAt = dependencies.now(),
      current = await evaluateTarget(
        next,
        tasks,
        input,
        journalTarget.destinationRoot,
        journalTarget.relativePath,
        dependencies,
      );
    if (current.status !== "eligible") {
      journalTarget.result = "skipped";
      journalTarget.resultReason = current.reason;
      journalTarget.checkedAt = checkedAt;
      targets.push({
        destinationRoot: current.destinationRoot,
        relativePath: current.relativePath,
        path: current.path,
        result: "skipped",
        reason: current.reason,
        checkedAt,
      });
      await journalCallbacks!.checkpoint(structuredClone(journal));
      continue;
    }
    let target: ProjectDirectoryCleanupAudit["targets"][number];
    try {
      // rmdir is intentionally non-recursive. A file appearing after the last
      // check turns into ENOTEMPTY and is preserved rather than erased.
      await fs.rmdir(current.path);
      const proof = (next.managedProjectDirectories || []).find(
        (record) => record.id === current.proofId,
      );
      if (proof) {
        proof.removedAt = checkedAt;
        proof.cleanupAuditId = auditId;
      }
      target = {
        destinationRoot: current.destinationRoot,
        relativePath: current.relativePath,
        path: current.path,
        result: "removed",
        reason: "执行时复核为空，已使用非递归方式移除",
        checkedAt,
      };
    } catch (error: any) {
      target = {
        destinationRoot: current.destinationRoot,
        relativePath: current.relativePath,
        path: current.path,
        result: "skipped",
        reason:
          error?.code === "ENOTEMPTY" || error?.code === "EEXIST"
            ? "执行前目录出现内容，已安全保留"
            : `移除失败：${error?.message || String(error)}`,
        checkedAt,
      };
    }
    targets.push(target);
    journalTarget.result = target.result === "removed" ? "removed" : "skipped";
    journalTarget.resultReason = target.reason;
    journalTarget.checkedAt = target.checkedAt;
    // If this durable checkpoint fails after rmdir, the older on-disk journal
    // deliberately remains pending. Startup recovery then records the missing
    // path as unconfirmed instead of inventing a successful Kocpy deletion.
    await journalCallbacks!.checkpoint(structuredClone(journal));
  }
  const audit: ProjectDirectoryCleanupAudit = {
    id: auditId,
    previewId: preview.id,
    projectId: project.id,
    date: preview.date,
    scheduleKey: preview.scheduleKey,
    operator: operator.trim(),
    requestedAt: preview.createdAt,
    completedAt: dependencies.now(),
    targets,
  };
  next.directoryCleanupAudits = [
    ...(next.directoryCleanupAudits || []),
    audit,
  ];
  return { project: next, audit };
}
