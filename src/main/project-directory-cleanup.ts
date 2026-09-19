import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { compareVolumeIdentity, type VolumeIdentity } from "../common/volume-identity";
import { shootingDateKey } from "../common/shooting-dates";
import { volumeIdentity } from "./system";
import { projectFrameworkPaths } from "./project-path";
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
    targets: ProjectDirectoryCleanupAudit["targets"] = [];

  for (const shown of preview.targets) {
    const checkedAt = dependencies.now(),
      current = currentTargets.get(
        targetKey(shown.destinationRoot, shown.relativePath),
      );
    if (shown.status !== "eligible") {
      targets.push({
        destinationRoot: shown.destinationRoot,
        relativePath: shown.relativePath,
        path: shown.path,
        result: "skipped",
        reason: current?.reason || shown.reason,
        checkedAt,
      });
      continue;
    }
    if (!current || current.status !== "eligible") {
      targets.push({
        destinationRoot: shown.destinationRoot,
        relativePath: shown.relativePath,
        path: shown.path,
        result: "skipped",
        reason: current?.reason || "项目目录策略已变化",
        checkedAt,
      });
      continue;
    }
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
      targets.push({
        destinationRoot: current.destinationRoot,
        relativePath: current.relativePath,
        path: current.path,
        result: "removed",
        reason: "执行时复核为空，已使用非递归方式移除",
        checkedAt,
      });
    } catch (error: any) {
      targets.push({
        destinationRoot: current.destinationRoot,
        relativePath: current.relativePath,
        path: current.path,
        result: "skipped",
        reason:
          error?.code === "ENOTEMPTY" || error?.code === "EEXIST"
            ? "执行前目录出现内容，已安全保留"
            : `移除失败：${error?.message || String(error)}`,
        checkedAt,
      });
    }
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
