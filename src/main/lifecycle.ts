import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ArchiveChangeRecord,
  BackupTask,
  ProjectConfig,
  ProjectTemplate,
  WorkspaceMergeResult,
} from "./types";

const taskStatuses = new Set([
  "pending",
  "running",
  "paused",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "unverified",
]);
const hashes = new Set(["md5", "sha1", "sha256", "xxhash32"]);
const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown, label: string, required = true) => {
  if (
    (required && typeof value !== "string") ||
    (typeof value === "string" && (value.length > 8192 || value.includes("\0")))
  )
    throw new Error(`工作站配置中的${label}无效`);
};

/** Validate untrusted workstation JSON before it reaches the merge or persistence layer. */
export function validateWorkspacePackage(value: unknown) {
  if (
    !plainObject(value) ||
    value.application !== "Kocpy" ||
    ![1, 2].includes(Number(value.schema))
  )
    throw new Error("不是受支持的 Kocpy 工作站配置包");
  if (value.schema === 2 && typeof value.integrity !== "string")
    throw new Error("工作站配置包缺少完整性签名");
  if (typeof value.integrity === "string") {
    const actual = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(value).filter(([key]) => key !== "integrity"),
          ),
        ),
      )
      .digest("hex");
    if (actual !== value.integrity)
      throw new Error("工作站配置包完整性校验失败，文件可能已被修改");
  }
  const projects = value.projects ?? [],
    tasks = value.tasks ?? [],
    templates = value.templates ?? [],
    healthRecords = value.healthRecords ?? [],
    archiveChanges = value.archiveChanges ?? [];
  if (
    !Array.isArray(projects) ||
    !Array.isArray(tasks) ||
    !Array.isArray(templates) ||
    !Array.isArray(healthRecords) ||
    !Array.isArray(archiveChanges)
  )
    throw new Error("工作站配置的数据列表无效");
  if (
    projects.length > 10_000 ||
    tasks.length > 100_000 ||
    templates.length > 10_000 ||
    healthRecords.length > 10_000 ||
    archiveChanges.length > 100_000
  )
    throw new Error("工作站配置包含过多记录");
  for (const item of projects) {
    if (!plainObject(item) || !Array.isArray(item.devices))
      throw new Error("工作站配置中的项目记录无效");
    safeText(item.id, "项目 ID");
    safeText(item.name, "项目名称");
    safeText(item.volumePrefix, "卷名前缀");
    if (
      Array.isArray(item.destinationPaths) &&
      item.destinationPaths.some(
        (destination) =>
          typeof destination !== "string" || !path.isAbsolute(destination),
      )
    )
      throw new Error("工作站配置中的项目目的地路径无效");
  }
  for (const item of tasks) {
    if (
      !plainObject(item) ||
      !Array.isArray(item.devices) ||
      !Array.isArray(item.destinations) ||
      !Array.isArray(item.fileRecords) ||
      !Array.isArray(item.verifyLog)
    )
      throw new Error("工作站配置中的任务记录无效");
    safeText(item.id, "任务 ID");
    safeText(item.name, "任务名称");
    safeText(item.sourcePath, "素材路径");
    if (!path.isAbsolute(String(item.sourcePath)))
      throw new Error("工作站配置中的素材路径必须是绝对路径");
    if (
      !hashes.has(String(item.hashAlgorithm)) ||
      !taskStatuses.has(String(item.status))
    )
      throw new Error("工作站配置中的任务状态或哈希算法无效");
    if (item.destinations.length > 32 || item.fileRecords.length > 2_000_000)
      throw new Error("工作站配置中的任务规模超过限制");
    for (const destination of item.destinations) {
      if (!plainObject(destination))
        throw new Error("工作站配置中的目的地记录无效");
      safeText(destination.id, "目的地 ID");
      safeText(destination.path, "目的地路径");
      if (!path.isAbsolute(String(destination.path)))
        throw new Error("工作站配置中的目的地路径必须是绝对路径");
      if (
        typeof destination.resolvedPath === "string" &&
        !path.isAbsolute(destination.resolvedPath)
      )
        throw new Error("工作站配置中的已解析目的地路径无效");
    }
    for (const file of item.fileRecords) {
      if (!plainObject(file) || !Array.isArray(file.destinations))
        throw new Error("工作站配置中的文件记录无效");
      safeText(file.relativePath, "相对路径");
      const relativePath = String(file.relativePath).replaceAll("\\", "/");
      if (
        path.posix.isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith("../") ||
        relativePath.includes("/../")
      )
        throw new Error("工作站配置中的文件相对路径越界");
      if (
        typeof file.size !== "number" ||
        file.size < 0 ||
        !Number.isFinite(file.size)
      )
        throw new Error("工作站配置中的文件大小无效");
      safeText(file.srcChecksum, "源校验值");
      for (const copy of file.destinations) {
        if (!plainObject(copy))
          throw new Error("工作站配置中的文件副本记录无效");
        safeText(copy.path, "文件副本路径");
        if (!path.isAbsolute(String(copy.path)))
          throw new Error("工作站配置中的文件副本路径必须是绝对路径");
      }
    }
  }
  return value as unknown as {
    application: "Kocpy";
    schema: 1 | 2;
    projects: ProjectConfig[];
    tasks: BackupTask[];
    templates?: ProjectTemplate[];
    healthRecords?: unknown[];
    archiveChanges?: ArchiveChangeRecord[];
  };
}

export const taskFingerprint = (task: BackupTask) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        sourceVolume: task.sourceVolumeUuid || task.sourceVolumeId,
        files: task.fileRecords
          .map((file) => [file.relativePath, file.size, file.srcChecksum])
          .sort(),
      }),
    )
    .digest("hex");

export function sourceSuggestion(
  tasks: BackupTask[],
  input: {
    volumeId?: string;
    files: Array<{ relativePath: string; size: number }>;
  },
) {
  const signature = createHash("sha256")
    .update(
      JSON.stringify(
        input.files.map((file) => [file.relativePath, file.size]).sort(),
      ),
    )
    .digest("hex");
  const duplicate = tasks.find(
    (task) =>
      createHash("sha256")
        .update(
          JSON.stringify(
            task.fileRecords
              .map((file) => [file.relativePath, file.size])
              .sort(),
          ),
        )
        .digest("hex") === signature,
  );
  const history = tasks
    .filter(
      (task) =>
        input.volumeId &&
        (task.sourceVolumeUuid === input.volumeId ||
          task.sourceVolumeId === input.volumeId),
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const recent = duplicate || history[0];
  return {
    duplicateTaskId: duplicate?.id,
    duplicateTaskName: duplicate?.name,
    projectId: recent?.projectId,
    device: recent?.devices[0],
    cameraPosition: recent?.cameraPosition,
    nextVolume:
      Math.max(
        1,
        ...tasks
          .filter(
            (task) =>
              task.projectId &&
              task.projectId === recent?.projectId &&
              task.devices[0] === recent?.devices[0],
          )
          .map((task) => task.volumeNumber || 0),
      ) + 1,
  };
}

export function templateFromProject(
  project: ProjectConfig,
  name = project.name,
): ProjectTemplate {
  const now = Date.now();
  return {
    id: `template-${project.id}`,
    name,
    devices: [...project.devices],
    volumePrefix: project.volumePrefix,
    requiredCopies: project.requiredCopies || 2,
    namingRule:
      project.namingRule ||
      "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    completionActions: [...(project.completionActions || ["report"])],
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeWorkspace(
  current: { projects: ProjectConfig[]; tasks: BackupTask[] },
  incoming: { projects?: ProjectConfig[]; tasks?: BackupTask[] },
): {
  projects: ProjectConfig[];
  tasks: BackupTask[];
  result: WorkspaceMergeResult;
} {
  const projects = [...current.projects],
    tasks = [...current.tasks],
    conflicts: string[] = [];
  let projectsAdded = 0,
    projectsUpdated = 0,
    tasksAdded = 0,
    duplicates = 0;
  for (const project of incoming.projects || []) {
    const index = projects.findIndex((item) => item.id === project.id);
    if (index < 0) {
      projects.push(project);
      projectsAdded++;
    } else if (JSON.stringify(projects[index]) !== JSON.stringify(project)) {
      projects[index] = {
        ...projects[index],
        ...project,
        handoffNotes: [
          ...(projects[index].handoffNotes || []),
          ...(project.handoffNotes || []),
        ].filter(
          (note, i, all) =>
            all.findIndex((other) => other.id === note.id) === i,
        ),
      };
      projectsUpdated++;
      conflicts.push(`项目 ${project.name} 配置已合并`);
    }
  }
  const fingerprints = new Map(
    tasks.map((task) => [taskFingerprint(task), task]),
  );
  for (const task of incoming.tasks || []) {
    const fingerprint = taskFingerprint(task);
    if (
      tasks.some((item) => item.id === task.id) ||
      fingerprints.has(fingerprint)
    ) {
      duplicates++;
      continue;
    }
    if (
      tasks.some(
        (item) =>
          item.projectId === task.projectId &&
          item.name === task.name &&
          item.shootingDate === task.shootingDate,
      )
    )
      conflicts.push(`素材卷名称冲突：${task.name}`);
    tasks.push(task);
    fingerprints.set(fingerprint, task);
    tasksAdded++;
  }
  return {
    projects,
    tasks,
    result: {
      projectsAdded,
      projectsUpdated,
      tasksAdded,
      duplicates,
      conflicts,
      importedAt: Date.now(),
    },
  };
}
