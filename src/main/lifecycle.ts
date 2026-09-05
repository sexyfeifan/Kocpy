import { normalizePositions } from "../common/interaction";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  ArchiveVerificationRun,
  BackupTask,
  ProjectConfig,
  ProjectTemplate,
  WorkspaceMergeResult,
} from "./types";
import type { WorkspaceTombstone } from "./workspace-contract";
import { validateCompletionActionRecords } from "./completion-automation";

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
const unsettledTaskStatuses = new Set([
  "pending",
  "running",
  "paused",
  "verifying",
]);
const projectEvidenceFields = [
  "dailyPlanDecisions",
  "ruleSnapshots",
  "templateApplications",
  "handoffNotes",
  "checklistRuns",
  "takeoverEvents",
  "workstationSources",
] as const;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeText = (value: unknown, label: string, required = true) => {
  if (!required && value === undefined) return;
  if (typeof value !== "string" || value.length > 8192 || value.includes("\0"))
    throw new Error(`工作站配置中的${label}无效`);
};

/** Validate untrusted workstation JSON before it reaches the merge or persistence layer. */
export function validateWorkspacePackage(value: unknown) {
  if (
    !plainObject(value) ||
    value.application !== "Kocpy" ||
    ![1, 2, 3].includes(Number(value.schema))
  )
    throw new Error("不是受支持的 Kocpy 工作站配置包");
  if (Number(value.schema) >= 2 && typeof value.integrity !== "string")
    throw new Error("工作站配置包缺少完整性摘要");
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
    archiveChanges = value.archiveChanges ?? [],
    archiveReminders = value.archiveReminders ?? [],
    archiveRuns = value.archiveRuns ?? [];
  if (
    !Array.isArray(projects) ||
    !Array.isArray(tasks) ||
    !Array.isArray(templates) ||
    !Array.isArray(healthRecords) ||
    !Array.isArray(archiveChanges) ||
    !Array.isArray(archiveReminders) ||
    !Array.isArray(archiveRuns)
  )
    throw new Error("工作站配置的数据列表无效");
  if (
    projects.length > 10_000 ||
    tasks.length > 100_000 ||
    templates.length > 10_000 ||
    healthRecords.length > 10_000 ||
    archiveChanges.length > 100_000 ||
    archiveReminders.length > 10_000 ||
    archiveRuns.length > 10_000
  )
    throw new Error("工作站配置包含过多记录");
  const uniqueIds = (items: unknown[], label: string) => {
    const ids = items.map((item) =>
      plainObject(item) && typeof item.id === "string" ? item.id : "",
    );
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
      throw new Error(`工作站配置中的${label}标识重复或无效`);
  };
  const validateEvidenceIds = (items: unknown, label: string) => {
    if (items === undefined) return;
    if (!Array.isArray(items) || items.length > 100_000)
      throw new Error(`工作站配置中的${label}列表无效`);
    uniqueIds(items, label);
    for (const item of items) {
      if (!plainObject(item)) throw new Error(`工作站配置中的${label}记录无效`);
      safeText(item.id, `${label} ID`);
    }
  };
  const validateWorkstationSources = (items: unknown, label: string) => {
    validateEvidenceIds(items, label);
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const source of (items || []) as unknown[]) {
      if (
        !plainObject(source) ||
        typeof source.displayName !== "string" ||
        !source.displayName.trim() ||
        source.displayName.length > 120 ||
        typeof source.packageSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(source.packageSha256) ||
        !Number.isFinite(source.importedAt) ||
        (source.workstationId !== undefined &&
          (typeof source.workstationId !== "string" ||
            !uuid.test(source.workstationId))) ||
        (source.exportId !== undefined &&
          (typeof source.exportId !== "string" || !uuid.test(source.exportId)))
      )
        throw new Error(`工作站配置中的${label}记录无效`);
    }
  };
  const templateSegment = (input: unknown, label: string) => {
    if (
      typeof input !== "string" ||
      !input.trim() ||
      input.length > 120 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(input) ||
      input === "." ||
      input === ".."
    )
      throw new Error(`工作站配置中的模板${label}无效`);
  };
  const validateTemplateMap = (
    input: unknown,
    devices: Set<string>,
    label: string,
    values: (value: unknown, key: string) => void,
  ) => {
    if (input === undefined) return;
    if (!plainObject(input) || Object.keys(input).length > 10)
      throw new Error(`工作站配置中的模板${label}无效`);
    for (const [key, value] of Object.entries(input)) {
      if (!devices.has(key))
        throw new Error(`工作站配置中的模板${label}包含未知设备`);
      values(value, key);
    }
  };
  const validateTemplates = (items: unknown[]) => {
    const productions = new Set([
        "commercial",
        "documentary",
        "short",
        "variety",
        "feature",
        "custom",
      ]),
      actions = new Set(["report", "delivery", "proxy", "eject"]),
      roles = new Set([
        "DIT",
        "cinematographer",
        "data-manager",
        "assistant",
        "other",
      ]);
    for (const value of items) {
      if (!plainObject(value)) throw new Error("工作站配置中的模板记录无效");
      safeText(value.id, "模板 ID");
      safeText(value.name, "模板名称");
      safeText(value.description, "模板说明", false);
      if (
        String(value.id).length > 200 ||
        !String(value.name).trim() ||
        String(value.name).length > 200 ||
        (typeof value.description === "string" &&
          value.description.length > 4_096) ||
        (value.kind !== undefined &&
          !["builtin", "custom"].includes(String(value.kind))) ||
        (value.hidden !== undefined && typeof value.hidden !== "boolean") ||
        (value.productionType !== undefined &&
          !productions.has(String(value.productionType))) ||
        !Array.isArray(value.devices) ||
        value.devices.length < 1 ||
        value.devices.length > 10
      )
        throw new Error("工作站配置中的模板记录无效");
      const deviceList = value.devices as unknown[];
      for (const device of deviceList) templateSegment(device, "设备名称");
      const deviceNames = deviceList.map(String);
      if (new Set(deviceNames).size !== deviceNames.length)
        throw new Error("工作站配置中的模板设备名称重复");
      const deviceSet = new Set(deviceNames);
      templateSegment(value.volumePrefix, "卷名前缀");
      validateTemplateMap(
        value.volumePrefixByDevice,
        deviceSet,
        "设备卷名前缀",
        (prefix) => templateSegment(prefix, "设备卷名前缀"),
      );
      validateTemplateMap(
        value.devicePositions,
        deviceSet,
        "机位",
        (positions) => {
          if (!Array.isArray(positions))
            throw new Error("工作站配置中的模板机位无效");
          normalizePositions(positions.map(String));
        },
      );
      if (
        !Number.isSafeInteger(value.requiredCopies) ||
        Number(value.requiredCopies) < 1 ||
        Number(value.requiredCopies) > 4 ||
        typeof value.namingRule !== "string" ||
        !value.namingRule.includes("{card}") ||
        value.namingRule.length > 1_024 ||
        value.namingRule.includes("\0") ||
        !Array.isArray(value.completionActions) ||
        value.completionActions.length > actions.size ||
        value.completionActions.some(
          (action) => !actions.has(String(action)),
        ) ||
        new Set(value.completionActions.map(String)).size !==
          value.completionActions.length ||
        (value.expectedVolumes !== undefined &&
          (!Number.isSafeInteger(value.expectedVolumes) ||
            Number(value.expectedVolumes) < 1 ||
            Number(value.expectedVolumes) > 1_000_000)) ||
        !Number.isFinite(value.createdAt) ||
        Number(value.createdAt) < 0 ||
        !Number.isFinite(value.updatedAt) ||
        Number(value.updatedAt) < 0 ||
        (value.revision !== undefined &&
          (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1))
      )
        throw new Error("工作站配置中的模板字段无效");
      if (value.checklists !== undefined) {
        if (!Array.isArray(value.checklists) || value.checklists.length > 100)
          throw new Error("工作站配置中的模板检查表无效");
        uniqueIds(value.checklists, "模板检查项");
        for (const checklist of value.checklists) {
          if (
            !plainObject(checklist) ||
            !["start", "close"].includes(String(checklist.phase)) ||
            typeof checklist.label !== "string" ||
            !checklist.label.trim() ||
            checklist.label.length > 500 ||
            checklist.label.includes("\0") ||
            typeof checklist.required !== "boolean"
          )
            throw new Error("工作站配置中的模板检查项无效");
          safeText(checklist.id, "模板检查项 ID");
        }
      }
      if (value.crew !== undefined) {
        if (!Array.isArray(value.crew) || value.crew.length > 100)
          throw new Error("工作站配置中的模板成员无效");
        uniqueIds(value.crew, "模板成员");
        for (const member of value.crew) {
          if (
            !plainObject(member) ||
            typeof member.name !== "string" ||
            !member.name.trim() ||
            member.name.length > 200 ||
            member.name.includes("\0") ||
            !roles.has(String(member.role))
          )
            throw new Error("工作站配置中的模板成员记录无效");
          safeText(member.id, "模板成员 ID");
        }
      }
    }
  };
  uniqueIds(projects, "项目");
  uniqueIds(tasks, "任务");
  uniqueIds(templates, "模板");
  uniqueIds(healthRecords, "归档健康记录");
  uniqueIds(archiveChanges, "归档变化记录");
  uniqueIds(archiveReminders, "归档提醒");
  uniqueIds(archiveRuns, "归档核验运行");
  validateTemplates(templates);
  for (const item of projects) {
    if (
      !plainObject(item) ||
      !Array.isArray(item.devices) ||
      item.devices.length < 1 ||
      item.devices.length > 10
    )
      throw new Error("工作站配置中的项目记录无效");
    safeText(item.id, "项目 ID");
    safeText(item.name, "项目名称");
    safeText(item.volumePrefix, "卷名前缀");
    templateSegment(item.name, "项目名称");
    templateSegment(item.volumePrefix, "项目卷名前缀");
    const projectDevices = (item.devices as unknown[]).map((device) => {
      templateSegment(device, "项目设备名称");
      return String(device);
    });
    if (new Set(projectDevices).size !== projectDevices.length)
      throw new Error("工作站配置中的项目设备名称重复");
    const projectDeviceSet = new Set(projectDevices);
    if (item.projectFolderName !== undefined)
      templateSegment(item.projectFolderName, "项目文件夹名称");
    validateTemplateMap(
      item.volumePrefixByDevice,
      projectDeviceSet,
      "项目设备卷名前缀",
      (prefix) => templateSegment(prefix, "项目设备卷名前缀"),
    );
    validateTemplateMap(
      item.devicePositions,
      projectDeviceSet,
      "项目机位",
      (positions) => {
        if (!Array.isArray(positions))
          throw new Error("工作站配置中的项目机位无效");
        normalizePositions(positions.map(String));
      },
    );
    if (
      item.destinationPaths !== undefined &&
      (!Array.isArray(item.destinationPaths) ||
        item.destinationPaths.length > 4 ||
        item.destinationPaths.some(
          (destination) =>
            typeof destination !== "string" ||
            !path.isAbsolute(destination) ||
            destination.includes("\0"),
        ))
    )
      throw new Error("工作站配置中的项目目的地路径无效");
    if (
      (item.status !== undefined &&
        !["active", "archived"].includes(String(item.status))) ||
      (item.requiredCopies !== undefined &&
        (!Number.isSafeInteger(item.requiredCopies) ||
          Number(item.requiredCopies) < 1 ||
          Number(item.requiredCopies) > 4)) ||
      (item.namingRule !== undefined &&
        (typeof item.namingRule !== "string" ||
          !item.namingRule.includes("{card}") ||
          item.namingRule.length > 1_024 ||
          item.namingRule.includes("\0"))) ||
      (item.completionActions !== undefined &&
        (!Array.isArray(item.completionActions) ||
          item.completionActions.length > 4 ||
          item.completionActions.some(
            (action) =>
              !["report", "delivery", "proxy", "eject"].includes(
                String(action),
              ),
          ) ||
          new Set(item.completionActions.map(String)).size !==
            item.completionActions.length))
    )
      throw new Error("工作站配置中的项目字段无效");
    for (const field of projectEvidenceFields)
      validateEvidenceIds(item[field], `项目 ${String(item.id)} 的 ${field}`);
    validateWorkstationSources(
      item.workstationSources,
      `项目 ${String(item.id)} 的工作站来源`,
    );
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
    validateCompletionActionRecords(item as unknown as BackupTask);
    validateWorkstationSources(
      item.workstationSources,
      `任务 ${String(item.id)} 的工作站来源`,
    );
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
  let source:
      | {
          workstationId: string;
          displayName: string;
          exportId: string;
          exportedAt: number;
        }
      | undefined,
    workspace:
      | {
          revision: number;
          digest: string;
          exchangeDigest: string;
          taskTombstones: WorkspaceTombstone[];
          projectTombstones: WorkspaceTombstone[];
        }
      | undefined;
  if (Number(value.schema) === 3) {
    if (!plainObject(value.source) || !plainObject(value.workspace))
      throw new Error("工作站配置包缺少来源工作站或工作区依据");
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (
      typeof value.source.workstationId !== "string" ||
      !uuid.test(value.source.workstationId) ||
      typeof value.source.exportId !== "string" ||
      !uuid.test(value.source.exportId) ||
      typeof value.source.displayName !== "string" ||
      !value.source.displayName.trim() ||
      value.source.displayName.length > 120 ||
      !Number.isFinite(value.source.exportedAt)
    )
      throw new Error("工作站配置包的来源身份无效");
    const taskTombstones = value.workspace.taskTombstones,
      projectTombstones = value.workspace.projectTombstones;
    if (
      typeof value.workspace.revision !== "number" ||
      !Number.isSafeInteger(value.workspace.revision) ||
      value.workspace.revision < 1 ||
      typeof value.workspace.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.workspace.digest) ||
      typeof value.workspace.exchangeDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.workspace.exchangeDigest) ||
      !Array.isArray(taskTombstones) ||
      !Array.isArray(projectTombstones)
    )
      throw new Error("工作站配置包的工作区依据无效");
    if (
      tasks.some((item) =>
        unsettledTaskStatuses.has(String((item as BackupTask).status)),
      )
    )
      throw new Error("工作站配置包包含未结束的备份任务，已停止团队合并");
    const validateTombstones = (items: unknown[], label: string) => {
      const ids = new Set<string>();
      for (const item of items) {
        if (
          !plainObject(item) ||
          typeof item.id !== "string" ||
          !item.id ||
          ids.has(item.id) ||
          typeof item.revision !== "number" ||
          !Number.isSafeInteger(item.revision) ||
          item.revision < 1 ||
          !Number.isFinite(item.deletedAt)
        )
          throw new Error(`工作站配置包的${label}删除记录无效`);
        ids.add(item.id);
      }
    };
    validateTombstones(taskTombstones, "任务");
    validateTombstones(projectTombstones, "项目");
    const taskIds = new Set(tasks.map((item) => (item as BackupTask).id)),
      projectIds = new Set(projects.map((item) => (item as ProjectConfig).id));
    if (
      tasks.some(
        (item) =>
          typeof (item as BackupTask).projectId === "string" &&
          !projectIds.has((item as BackupTask).projectId!),
      )
    )
      throw new Error("工作站配置包包含找不到所属项目的任务记录");
    if (
      taskTombstones.some((item) => taskIds.has(String(item.id))) ||
      projectTombstones.some((item) => projectIds.has(String(item.id)))
    )
      throw new Error("工作站配置包同时包含记录和同 ID 删除墓碑");
    const actualExchangeDigest = createHash("sha256")
      .update(
        JSON.stringify({
          projects,
          tasks,
          templates,
          healthRecords,
          archiveChanges,
          archiveReminders,
          archiveRuns,
          taskTombstones,
          projectTombstones,
        }),
      )
      .digest("hex");
    if (actualExchangeDigest !== value.workspace.exchangeDigest)
      throw new Error("工作站配置包的交换数据摘要不匹配");
    source = value.source as typeof source;
    workspace = value.workspace as typeof workspace;
  }
  return value as unknown as {
    application: "Kocpy";
    schema: 1 | 2 | 3;
    version?: string;
    integrity?: string;
    workstation?: string;
    exportedAt?: number;
    source?: typeof source;
    workspace?: typeof workspace;
    projects: ProjectConfig[];
    tasks: BackupTask[];
    templates?: ProjectTemplate[];
    healthRecords?: ArchiveHealthRecord[];
    archiveChanges?: ArchiveChangeRecord[];
    archiveReminders?: ArchiveReminder[];
    archiveRuns?: ArchiveVerificationRun[];
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

const structureInventory = (
  files: Array<{ relativePath: string; size: number }>,
) =>
  files
    .map((file) => [file.relativePath, file.size] as const)
    .sort((left, right) =>
      left[0] === right[0]
        ? left[1] - right[1]
        : left[0].localeCompare(right[0]),
    );
const structureSignature = (
  files: Array<{ relativePath: string; size: number }>,
) =>
  createHash("sha256")
    .update(JSON.stringify(structureInventory(files)))
    .digest("hex");

export function sourceSuggestion(
  tasks: BackupTask[],
  input: {
    volumeId?: string;
    files: Array<{ relativePath: string; size: number }>;
  },
) {
  const normalizedFiles = structureInventory(input.files);
  const signature = structureSignature(input.files);
  const duplicate = normalizedFiles.length
    ? tasks.find((task) => structureSignature(task.fileRecords) === signature)
    : undefined;
  const history = tasks
    .filter(
      (task) =>
        input.volumeId &&
        (task.sourceVolumeUuid === input.volumeId ||
          task.sourceVolumeId === input.volumeId),
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const recent = duplicate || history[0];
  const relatedVolumes = recent
    ? tasks.filter(
        (task) =>
          task.projectId &&
          task.projectId === recent.projectId &&
          task.devices[0] === recent.devices[0],
      )
    : [];
  return {
    duplicateTaskId: duplicate?.id,
    duplicateTaskName: duplicate?.name,
    projectId: recent?.projectId,
    device: recent?.devices[0],
    cameraPosition: recent?.cameraPosition,
    nextVolume: recent
      ? Math.max(0, ...relatedVolumes.map((task) => task.volumeNumber || 0)) + 1
      : 1,
    basis: duplicate
      ? ("structure-match" as const)
      : history.length
        ? ("volume-history" as const)
        : ("none" as const),
    confidence: duplicate
      ? ("possible-duplicate" as const)
      : history.length
        ? ("historical-suggestion" as const)
        : ("none" as const),
    fingerprint: signature,
    fileCount: normalizedFiles.length,
    totalBytes: normalizedFiles.reduce((sum, item) => sum + item[1], 0),
    matchedTaskCreatedAt: recent?.createdAt,
    evidence: duplicate
      ? [
          `相对路径和字节数与历史任务 ${duplicate.name} 的 ${normalizedFiles.length} 个文件完全一致`,
          "尚未重新读取文件内容哈希，因此只判为疑似重复",
        ]
      : history.length
        ? [
            `当前卷身份与 ${history.length} 条历史接收记录一致`,
            "项目、设备、机位和下一卷号来自最近一次该卷记录",
          ]
        : ["没有找到相同目录结构或相同卷身份的历史记录"],
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
    description: `从项目“${project.name}”保存的自定义模板`,
    kind: "custom",
    productionType: project.productionType || "custom",
    devices: [...project.devices],
    volumePrefix: project.volumePrefix,
    volumePrefixByDevice: { ...(project.volumePrefixByDevice || {}) },
    devicePositions: Object.fromEntries(
      Object.entries(project.devicePositions || {}).map(([device, values]) => [
        device,
        [...values],
      ]),
    ),
    requiredCopies: project.requiredCopies || 2,
    namingRule:
      project.namingRule ||
      "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    completionActions: [...(project.completionActions || ["report"])],
    expectedVolumes: project.expectedVolumes,
    checklists: project.checklists?.map((item) => ({ ...item })),
    crew: project.crew?.map((item) => ({ ...item })),
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function normalizeProjectTemplate(
  template: ProjectTemplate,
): ProjectTemplate {
  const devices = [
    ...new Set(
      (template.devices || [])
        .filter((device): device is string => typeof device === "string")
        .map((device) => device.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
  if (!devices.length) devices.push("A Cam");
  return {
    ...template,
    name: template.name?.trim() || "未命名模板",
    description: template.description || "自定义项目制作流程",
    kind: template.id.startsWith("builtin-") ? "builtin" : "custom",
    productionType: template.productionType || "custom",
    devices,
    volumePrefix: template.volumePrefix || `${devices[0]}_`,
    volumePrefixByDevice: Object.fromEntries(
      devices.map((device) => [
        device,
        template.volumePrefixByDevice?.[device] ||
          (devices.length === 1 ? template.volumePrefix : `${device}_`),
      ]),
    ),
    devicePositions: Object.fromEntries(
      Object.entries(template.devicePositions || {}).map(([device, values]) => [
        device,
        normalizePositions(values),
      ]),
    ),
    requiredCopies: Math.max(1, Math.min(4, template.requiredCopies || 2)),
    namingRule:
      template.namingRule ||
      "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    completionActions: [...(template.completionActions || ["report"])],
    checklists: template.checklists?.map((item) => ({ ...item })),
    crew: template.crew?.map((item) => ({ ...item })),
    createdAt: template.createdAt || Date.now(),
    updatedAt: template.updatedAt || Date.now(),
    revision: Math.max(1, Math.floor(template.revision || 1)),
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
      const mergeEvidence = <T extends { id: string }>(
        left: T[] | undefined,
        right: T[] | undefined,
      ) =>
        [...(left || []), ...(right || [])].filter(
          (item, i, all) =>
            all.findIndex((other) => other.id === item.id) === i,
        );
      projects[index] = {
        ...projects[index],
        ...project,
        handoffNotes: mergeEvidence(
          projects[index].handoffNotes,
          project.handoffNotes,
        ),
        ruleSnapshots: mergeEvidence(
          projects[index].ruleSnapshots,
          project.ruleSnapshots,
        ),
        dailyPlanDecisions: mergeEvidence(
          projects[index].dailyPlanDecisions,
          project.dailyPlanDecisions,
        ),
        templateApplications: mergeEvidence(
          projects[index].templateApplications,
          project.templateApplications,
        ),
        checklistRuns: mergeEvidence(
          projects[index].checklistRuns,
          project.checklistRuns,
        ),
        takeoverEvents: mergeEvidence(
          projects[index].takeoverEvents,
          project.takeoverEvents,
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
