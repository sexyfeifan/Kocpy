import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  ArchiveVerificationRun,
  BackupTask,
  ProjectConfig,
  ProjectTemplate,
  WorkstationIdentity,
  WorkstationImportAuditRecord,
  WorkspaceImportDecision,
  WorkspaceImportPreview,
  WorkspaceMergeConflict,
  WorkspaceMergeResult,
} from "./types";
import type { Storage } from "./storage";
import type { WorkspaceState, WorkspaceTombstone } from "./workspace-contract";
import { taskFingerprint, validateWorkspacePackage } from "./lifecycle";

const IDENTITY_FILE = "workstation-identity.json";
export const WORKSTATION_AUDIT_FILE = "workstation-import-audit.json";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const evidenceFields = [
  "dailyPlanDecisions",
  "ruleSnapshots",
  "templateApplications",
  "handoffNotes",
  "checklistRuns",
  "takeoverEvents",
  "workstationSources",
] as const;
type EvidenceField = (typeof evidenceFields)[number];

export type ValidatedWorkspacePackage = ReturnType<
  typeof validateWorkspacePackage
>;

export interface WorkspaceExchangeState {
  projects: ProjectConfig[];
  tasks: BackupTask[];
  templates: ProjectTemplate[];
  healthRecords: ArchiveHealthRecord[];
  archiveChanges: ArchiveChangeRecord[];
  archiveReminders: ArchiveReminder[];
  archiveRuns: ArchiveVerificationRun[];
  taskTombstones: WorkspaceTombstone[];
  projectTombstones: WorkspaceTombstone[];
}

export interface WorkspaceExchangeMerge {
  state: WorkspaceExchangeState;
  result: WorkspaceMergeResult;
  unresolvedConflictIds: string[];
}

export interface WorkstationImportRecoveryRecord {
  schema: 1;
  previewId: string;
  packageSha256: string;
  decisionsSha256: string;
  decisions: WorkspaceImportDecision[];
  expectedExchangeDigest: string;
  sourceWorkstationId?: string;
  sourceWorkstationName: string;
  exportId?: string;
  operator: string;
  previewedRevision: number;
  previewedDigest: string;
  previewedExchangeDigest: string;
  previousTemplates: ProjectTemplate[];
  previousTemplatesDigest: string;
  importedAt: number;
  result: WorkspaceMergeResult;
}

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => sha256(JSON.stringify(value));
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);
const clipped = (value: unknown) => {
  const text =
    value === undefined
      ? "未设置"
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
};
const conflictId = (
  kind: WorkspaceMergeConflict["kind"],
  entityId: string,
  field: string | undefined,
  local: unknown,
  incoming: unknown,
) =>
  `conflict-${sha256(
    JSON.stringify([kind, entityId, field, digest(local), digest(incoming)]),
  ).slice(0, 24)}`;
const conflict = (
  kind: WorkspaceMergeConflict["kind"],
  entityType: WorkspaceMergeConflict["entityType"],
  entityId: string,
  label: string,
  local: unknown,
  incoming: unknown,
  consequence: string,
  field?: string,
): WorkspaceMergeConflict => ({
  id: conflictId(kind, entityId, field, local, incoming),
  kind,
  entityType,
  entityId,
  label,
  field,
  localSummary: clipped(local),
  incomingSummary: clipped(incoming),
  defaultDecision: "local",
  consequence,
});

function validateIdentity(value: unknown): WorkstationIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    (value as WorkstationIdentity).schema !== 1 ||
    !UUID.test((value as WorkstationIdentity).id || "") ||
    typeof (value as WorkstationIdentity).displayName !== "string" ||
    !(value as WorkstationIdentity).displayName.trim() ||
    (value as WorkstationIdentity).displayName.length > 120 ||
    !Number.isFinite((value as WorkstationIdentity).createdAt)
  )
    throw new Error("稳定工作站身份记录无效");
  return value as WorkstationIdentity;
}

/** A corrupt identity must never be silently replaced with a new workstation. */
export async function loadOrCreateWorkstationIdentity(
  storage: Storage,
  displayName = os.hostname(),
) {
  const file = path.join(storage.root, IDENTITY_FILE),
    backup = `${file}.bak`;
  let primaryExists = false,
    primaryError: unknown;
  try {
    primaryExists = true;
    const identity = validateIdentity(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
    if (identity.displayName !== displayName.trim()) {
      const updated = { ...identity, displayName: displayName.trim() };
      await storage.write(IDENTITY_FILE, updated);
      return updated;
    }
    return identity;
  } catch (error) {
    primaryError = error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      primaryExists = false;
  }
  try {
    const recovered = validateIdentity(
      JSON.parse(await fs.readFile(backup, "utf8")),
    );
    await storage.write(IDENTITY_FILE, {
      ...recovered,
      displayName: displayName.trim(),
    });
    return { ...recovered, displayName: displayName.trim() };
  } catch (backupError) {
    const backupMissing =
      (backupError as NodeJS.ErrnoException).code === "ENOENT";
    if (primaryExists || !backupMissing)
      throw new Error(
        `稳定工作站身份损坏，Kocpy 已停止生成新的身份。请保留应用数据并恢复 ${IDENTITY_FILE}：${
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError)
        }`,
      );
  }
  const created: WorkstationIdentity = {
    schema: 1,
    id: randomUUID(),
    displayName: displayName.trim() || "未命名工作站",
    createdAt: Date.now(),
  };
  await storage.write(IDENTITY_FILE, created);
  return created;
}

export function validateWorkstationImportAudits(
  value: unknown,
): WorkstationImportAuditRecord[] {
  if (!Array.isArray(value)) throw new Error("工作站导入审计不是有效列表");
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id !==
        workstationAuditId(item.packageSha256, item.decisionsSha256) ||
      ids.has(item.id) ||
      typeof item.sourceWorkstationName !== "string" ||
      !item.sourceWorkstationName.trim() ||
      (item.sourceWorkstationId !== undefined &&
        !UUID.test(item.sourceWorkstationId)) ||
      (item.exportId !== undefined && !UUID.test(item.exportId)) ||
      !/^[a-f0-9]{64}$/.test(item.packageSha256 || "") ||
      !/^[a-f0-9]{64}$/.test(item.decisionsSha256 || "") ||
      !Array.isArray(item.decisions) ||
      decisionsSha256(item.decisions) !== item.decisionsSha256 ||
      typeof item.operator !== "string" ||
      !item.operator.trim() ||
      !Number.isSafeInteger(item.previewedRevision) ||
      !/^[a-f0-9]{64}$/.test(item.previewedDigest || "") ||
      !/^[a-f0-9]{64}$/.test(item.previewedExchangeDigest || "") ||
      !Number.isSafeInteger(item.importedRevision) ||
      !/^[a-f0-9]{64}$/.test(item.importedDigest || "") ||
      !/^[a-f0-9]{64}$/.test(item.importedExchangeDigest || "") ||
      !Number.isFinite(item.importedAt) ||
      !item.result ||
      typeof item.result !== "object"
    )
      throw new Error("工作站导入审计包含无效或重复记录");
    ids.add(item.id);
  }
  return value as WorkstationImportAuditRecord[];
}

export async function loadWorkstationImportAudits(storage: Storage) {
  const file = path.join(storage.root, WORKSTATION_AUDIT_FILE),
    backup = `${file}.bak`;
  let anyFound = false,
    primaryError: unknown;
  for (const candidate of [file, backup]) {
    try {
      const audits = validateWorkstationImportAudits(
        JSON.parse(await fs.readFile(candidate, "utf8")),
      );
      if (candidate === backup)
        await storage.write(WORKSTATION_AUDIT_FILE, audits);
      return audits;
    } catch (error) {
      primaryError ||= error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") anyFound = true;
    }
  }
  if (anyFound)
    throw new Error(
      `工作站导入审计损坏，Kocpy 已停止团队合并：${
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError)
      }`,
    );
  return [];
}

export function workspacePackageIntegrity(value: Record<string, unknown>) {
  return digest(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "integrity"),
    ),
  );
}

export function createWorkspacePackage(input: {
  version: string;
  identity: WorkstationIdentity;
  workspace: WorkspaceState;
  templates: ProjectTemplate[];
}) {
  if (
    input.workspace.tasks.some((task) =>
      ["pending", "running", "paused", "verifying"].includes(task.status),
    )
  )
    throw new Error("仍有未结束的备份任务，不能导出工作站配置包");
  const exportedAt = Date.now(),
    exchangeBody = {
      projects: input.workspace.projects,
      tasks: input.workspace.tasks,
      templates: input.templates,
      healthRecords: input.workspace.archiveEvidence?.healthRecords || [],
      archiveChanges: input.workspace.archiveEvidence?.changes || [],
      archiveReminders: input.workspace.archiveEvidence?.reminders || [],
      archiveRuns: input.workspace.archiveEvidence?.runs || [],
      taskTombstones: input.workspace.taskTombstones,
      projectTombstones: input.workspace.projectTombstones,
    },
    base = {
      schema: 3 as const,
      application: "Kocpy" as const,
      version: input.version,
      source: {
        workstationId: input.identity.id,
        displayName: input.identity.displayName,
        exportId: randomUUID(),
        exportedAt,
      },
      workspace: {
        revision: input.workspace.revision,
        digest: input.workspace.digest,
        exchangeDigest: digest(exchangeBody),
        taskTombstones: input.workspace.taskTombstones,
        projectTombstones: input.workspace.projectTombstones,
      },
      projects: input.workspace.projects,
      tasks: input.workspace.tasks,
      templates: input.templates,
      healthRecords: input.workspace.archiveEvidence?.healthRecords || [],
      archiveChanges: input.workspace.archiveEvidence?.changes || [],
      archiveReminders: input.workspace.archiveEvidence?.reminders || [],
      archiveRuns: input.workspace.archiveEvidence?.runs || [],
    };
  return { ...base, integrity: workspacePackageIntegrity(base) };
}

export function packageSource(
  value: ValidatedWorkspacePackage,
  packageSha256: string,
) {
  return value.schema === 3 && value.source
    ? {
        workstationId: value.source.workstationId,
        displayName: value.source.displayName,
        exportId: value.source.exportId,
        exportedAt: value.source.exportedAt,
        legacy: false,
        packageSha256,
      }
    : {
        displayName: value.workstation
          ? `旧工作站 ${value.workstation}`
          : "旧版工作站（来源未记录）",
        exportedAt: value.exportedAt,
        legacy: true,
        packageSha256,
      };
}

function projectEvidence(
  project: ProjectConfig,
  field: EvidenceField,
): Array<{ id: string; [key: string]: unknown }> {
  const value = project[field];
  return Array.isArray(value)
    ? (value as Array<{ id: string; [key: string]: unknown }>)
    : [];
}

function packageState(
  value: ValidatedWorkspacePackage,
): WorkspaceExchangeState {
  return {
    projects: value.projects || [],
    tasks: value.tasks || [],
    templates: value.templates || [],
    healthRecords: value.healthRecords || [],
    archiveChanges: value.archiveChanges || [],
    archiveReminders: value.archiveReminders || [],
    archiveRuns: value.archiveRuns || [],
    taskTombstones: value.workspace?.taskTombstones || [],
    projectTombstones: value.workspace?.projectTombstones || [],
  };
}

function listConflictKind(
  key: keyof Pick<
    WorkspaceExchangeState,
    | "templates"
    | "healthRecords"
    | "archiveChanges"
    | "archiveReminders"
    | "archiveRuns"
  >,
): WorkspaceMergeConflict["kind"] {
  return (
    {
      templates: "template-id",
      healthRecords: "archive-health-id",
      archiveChanges: "archive-change-id",
      archiveReminders: "archive-reminder-id",
      archiveRuns: "archive-run-id",
    } as const
  )[key];
}

function listEntityType(
  key: keyof Pick<
    WorkspaceExchangeState,
    | "templates"
    | "healthRecords"
    | "archiveChanges"
    | "archiveReminders"
    | "archiveRuns"
  >,
): WorkspaceMergeConflict["entityType"] {
  return (
    {
      templates: "template",
      healthRecords: "archive-health",
      archiveChanges: "archive-change",
      archiveReminders: "archive-reminder",
      archiveRuns: "archive-run",
    } as const
  )[key];
}

const changeComparable = (value: ArchiveChangeRecord) => {
  const { previousDigest: _previous, digest: _digest, ...body } = value;
  return body;
};
const taskComparable = (value: BackupTask) => {
  const { workstationSources: _sources, ...body } = value;
  return body;
};
const mergeSources = <T extends { id: string }>(
  left: T[] = [],
  right: T[] = [],
) =>
  [...structuredClone(left), ...structuredClone(right)].filter(
    (item, index, all) =>
      all.findIndex((candidate) => candidate.id === item.id) === index,
  );
const sourceEvidence = (input: {
  sourceWorkstationId?: string;
  sourceWorkstationName?: string;
  exportId?: string;
  packageSha256?: string;
  importedAt: number;
}) =>
  input.sourceWorkstationName && input.packageSha256
    ? {
        id: `workstation-source-${sha256(
          JSON.stringify([
            input.sourceWorkstationId || "legacy",
            input.exportId || input.packageSha256,
          ]),
        ).slice(0, 24)}`,
        workstationId: input.sourceWorkstationId,
        displayName: input.sourceWorkstationName,
        exportId: input.exportId,
        packageSha256: input.packageSha256,
        importedAt: input.importedAt,
      }
    : undefined;

function analyzeMerge(
  current: WorkspaceExchangeState,
  incoming: WorkspaceExchangeState,
) {
  const conflicts: WorkspaceMergeConflict[] = [];
  let projectsAdded = 0,
    tasksAdded = 0,
    templatesAdded = 0,
    archiveRecordsAdded = 0,
    exactDuplicates = 0;
  const localProjectTombstones = new Map(
      current.projectTombstones.map((item) => [item.id, item]),
    ),
    localTaskTombstones = new Map(
      current.taskTombstones.map((item) => [item.id, item]),
    ),
    incomingProjectTombstones = new Map(
      incoming.projectTombstones.map((item) => [item.id, item]),
    ),
    incomingTaskTombstones = new Map(
      incoming.taskTombstones.map((item) => [item.id, item]),
    );

  for (const project of incoming.projects) {
    const deleted = localProjectTombstones.get(project.id),
      local = current.projects.find((item) => item.id === project.id);
    if (deleted) {
      conflicts.push(
        conflict(
          "project-local-deletion",
          "project",
          project.id,
          `已删除项目 ${project.name}`,
          deleted,
          project,
          "选择外部版本会明确恢复本机已经删除的项目。",
        ),
      );
      continue;
    }
    if (!local) {
      projectsAdded++;
      continue;
    }
    for (const key of Object.keys(project) as Array<keyof ProjectConfig>) {
      if (key === "id" || evidenceFields.includes(key as EvidenceField))
        continue;
      if (hasOwn(project, key) && !same(local[key], project[key]))
        conflicts.push(
          conflict(
            "project-field",
            "project",
            project.id,
            `${project.name} · ${String(key)}`,
            local[key],
            project[key],
            "默认保留本机字段；选择外部值只修改这一字段。",
            String(key),
          ),
        );
    }
    for (const field of evidenceFields) {
      const localItems = new Map(
        projectEvidence(local, field).map((item) => [item.id, item]),
      );
      for (const item of projectEvidence(project, field)) {
        const localItem = localItems.get(item.id);
        if (!localItem) continue;
        if (same(localItem, item)) exactDuplicates++;
        else
          conflicts.push(
            conflict(
              "project-evidence",
              "project-evidence",
              `${project.id}:${field}:${item.id}`,
              `${project.name} · ${field} · ${item.id}`,
              localItem,
              item,
              "同一证据 ID 内容不一致；默认保留本机证据。",
              field,
            ),
          );
      }
    }
  }
  for (const tombstone of incoming.projectTombstones) {
    const local = current.projects.find((item) => item.id === tombstone.id);
    if (local)
      conflicts.push(
        conflict(
          "project-remote-deletion",
          "project",
          tombstone.id,
          `外部工作站已删除项目 ${local.name}`,
          local,
          tombstone,
          "默认保留本机项目；选择外部删除会删除本机项目记录，但不会删除素材文件。",
        ),
      );
  }

  const fingerprints = new Map(
    current.tasks.map((task) => [taskFingerprint(task), task]),
  );
  for (const task of incoming.tasks) {
    const deleted = localTaskTombstones.get(task.id),
      sameId = current.tasks.find((item) => item.id === task.id);
    if (deleted) {
      conflicts.push(
        conflict(
          "task-local-deletion",
          "task",
          task.id,
          `已删除任务 ${task.name}`,
          deleted,
          task,
          "选择外部版本会明确恢复本机已经删除的任务记录，不会复制素材。",
        ),
      );
      continue;
    }
    if (sameId) {
      if (same(taskComparable(sameId), taskComparable(task))) exactDuplicates++;
      else
        conflicts.push(
          conflict(
            "task-id",
            "task",
            task.id,
            `任务 ID 冲突 · ${task.name}`,
            sameId,
            task,
            "默认保留本机任务；选择外部版本会替换这条元数据记录，不会写入素材。",
          ),
        );
      continue;
    }
    const duplicate = fingerprints.get(taskFingerprint(task));
    if (duplicate) {
      conflicts.push(
        conflict(
          "task-content-duplicate",
          "task",
          task.id,
          `疑似相同素材 · ${task.name}`,
          { id: duplicate.id, name: duplicate.name },
          { id: task.id, name: task.name },
          "目录、大小和记录哈希相同但任务 ID 不同；默认不新增，选择外部版本会作为独立记录导入。",
        ),
      );
      continue;
    }
    const nameCollision = current.tasks.find(
      (item) =>
        item.projectId === task.projectId &&
        item.name === task.name &&
        item.shootingDate === task.shootingDate,
    );
    if (nameCollision) {
      conflicts.push(
        conflict(
          "task-name-collision",
          "task",
          task.id,
          `同名素材卷 · ${task.name}`,
          { id: nameCollision.id, files: nameCollision.totalFiles },
          { id: task.id, files: task.totalFiles },
          "同一项目和拍摄日存在同名但内容不同的任务；默认不新增，选择外部版本会并列保留。",
        ),
      );
      continue;
    }
    tasksAdded++;
  }
  for (const tombstone of incoming.taskTombstones) {
    const local = current.tasks.find((item) => item.id === tombstone.id);
    if (local)
      conflicts.push(
        conflict(
          "task-remote-deletion",
          "task",
          tombstone.id,
          `外部工作站已删除任务 ${local.name}`,
          local,
          tombstone,
          "默认保留本机任务；选择外部删除只删除 Kocpy 记录，不会删除素材文件。",
        ),
      );
  }

  for (const key of [
    "templates",
    "healthRecords",
    "archiveChanges",
    "archiveReminders",
    "archiveRuns",
  ] as const) {
    const local = new Map(current[key].map((item) => [item.id, item]));
    for (const item of incoming[key]) {
      const localItem = local.get(item.id) as any;
      if (!localItem) {
        if (key === "templates") templatesAdded++;
        else archiveRecordsAdded++;
        continue;
      }
      const left =
          key === "archiveChanges"
            ? changeComparable(localItem as ArchiveChangeRecord)
            : localItem,
        right =
          key === "archiveChanges"
            ? changeComparable(item as ArchiveChangeRecord)
            : item;
      if (same(left, right)) exactDuplicates++;
      else
        conflicts.push(
          conflict(
            listConflictKind(key),
            listEntityType(key),
            item.id,
            `${listEntityType(key)} · ${item.id}`,
            left,
            right,
            "同一稳定 ID 内容不一致；默认保留本机记录。",
          ),
        );
    }
  }
  return {
    conflicts,
    summary: {
      projectsAdded,
      tasksAdded,
      templatesAdded,
      archiveRecordsAdded,
      exactDuplicates,
      conflicts: conflicts.length,
      remoteTaskTombstones: incomingTaskTombstones.size,
      remoteProjectTombstones: incomingProjectTombstones.size,
    },
  };
}

export function buildWorkspaceImportPreview(input: {
  previewId?: string;
  fileName: string;
  packageSha256: string;
  value: ValidatedWorkspacePackage;
  current: WorkspaceExchangeState;
  localRevision: number;
  localDigest: string;
  localWorkstationId?: string;
  audits: WorkstationImportAuditRecord[];
}): WorkspaceImportPreview {
  const incoming = packageState(input.value),
    analysis = analyzeMerge(input.current, incoming),
    source = packageSource(input.value, input.packageSha256),
    alreadyImported = input.audits.some(
      (item) =>
        item.packageSha256 === input.packageSha256 &&
        (!source.exportId || item.exportId === source.exportId),
    );
  return {
    previewId: input.previewId || randomUUID(),
    fileName: input.fileName,
    packageSha256: input.packageSha256,
    source: {
      workstationId: source.workstationId,
      displayName: source.displayName,
      exportId: source.exportId,
      exportedAt: source.exportedAt,
      legacy: source.legacy,
    },
    localRevision: input.localRevision,
    localDigest: input.localDigest,
    localExchangeDigest: exchangeStateDigest(input.current),
    alreadyImported,
    summary: analysis.summary,
    conflicts: analysis.conflicts,
    warnings: [
      ...(source.legacy
        ? [
            "旧版工作站包没有稳定工作站 ID、导出 ID、权威修订或删除墓碑；可以预检，但来源与删除历史不完整。",
          ]
        : []),
      ...(alreadyImported
        ? ["这个导出包已经完成过导入；再次确认只会返回原审计结果。"]
        : []),
      ...(source.workstationId === input.localWorkstationId
        ? ["这个配置包来自当前工作站；通常只会产生重复项，请核对是否选错文件。"]
        : []),
      "工作站包只合并 Kocpy 元数据，不复制、移动、删除或重新校验原始素材。",
    ],
  };
}

const decisionMap = (decisions: WorkspaceImportDecision[]) => {
  const result = new Map<string, "local" | "incoming">();
  for (const item of decisions) {
    if (result.has(item.conflictId))
      throw new Error("工作站冲突决定包含重复项目");
    if (!["local", "incoming"].includes(item.decision))
      throw new Error("工作站冲突决定无效");
    result.set(item.conflictId, item.decision);
  }
  return result;
};

const mergeTombstones = (
  local: WorkspaceTombstone[],
  incoming: WorkspaceTombstone[],
  entities: Array<{ id: string }>,
) => {
  const entityIds = new Set(entities.map((item) => item.id)),
    merged = new Map(local.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (entityIds.has(item.id)) continue;
    const previous = merged.get(item.id);
    if (!previous || previous.deletedAt < item.deletedAt)
      merged.set(item.id, item);
  }
  for (const id of entityIds) merged.delete(id);
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
};

export function applyWorkspaceMerge(input: {
  current: WorkspaceExchangeState;
  value: ValidatedWorkspacePackage;
  decisions: WorkspaceImportDecision[];
  sourceWorkstationId?: string;
  sourceWorkstationName?: string;
  exportId?: string;
  packageSha256?: string;
  importedAt?: number;
}): WorkspaceExchangeMerge {
  const incoming = packageState(input.value),
    analysis = analyzeMerge(input.current, incoming),
    allowed = new Set(analysis.conflicts.map((item) => item.id)),
    choices = decisionMap(input.decisions);
  if (
    incoming.tasks.some((task) =>
      ["pending", "running", "paused", "verifying"].includes(task.status),
    )
  )
    throw new Error("工作站配置包包含未结束的备份任务，不能提交合并");
  if ([...choices.keys()].some((id) => !allowed.has(id)))
    throw new Error("工作站冲突决定不属于当前预检，请重新预检");
  const choice = (item: WorkspaceMergeConflict) =>
    choices.get(item.id) || item.defaultDecision;
  let projects = structuredClone(input.current.projects),
    tasks = structuredClone(input.current.tasks),
    projectsAdded = 0,
    projectsUpdated = 0,
    tasksAdded = 0,
    duplicates = 0;
  const origin = sourceEvidence({
    sourceWorkstationId: input.sourceWorkstationId,
    sourceWorkstationName: input.sourceWorkstationName,
    exportId: input.exportId,
    packageSha256: input.packageSha256,
    importedAt: input.importedAt || Date.now(),
  });
  const conflictBy = (
    kind: WorkspaceMergeConflict["kind"],
    entityId: string,
    field?: string,
  ) =>
    analysis.conflicts.find(
      (item) =>
        item.kind === kind &&
        item.entityId === entityId &&
        item.field === field,
    );

  for (const remote of incoming.projects) {
    const tombstoneConflict = conflictBy("project-local-deletion", remote.id);
    if (tombstoneConflict && choice(tombstoneConflict) === "local") continue;
    const index = projects.findIndex((item) => item.id === remote.id);
    if (index < 0) {
      const added = structuredClone(remote);
      if (origin)
        added.workstationSources = mergeSources(added.workstationSources, [
          origin,
        ]);
      projects.push(added);
      projectsAdded++;
      continue;
    }
    const local = projects[index],
      next = structuredClone(local) as ProjectConfig;
    for (const key of Object.keys(remote) as Array<keyof ProjectConfig>) {
      if (key === "id" || evidenceFields.includes(key as EvidenceField))
        continue;
      if (!hasOwn(remote, key) || same(local[key], remote[key])) continue;
      const item = conflictBy("project-field", remote.id, String(key));
      if (item && choice(item) === "incoming")
        (next as any)[key] = structuredClone(remote[key]);
    }
    for (const field of evidenceFields) {
      const merged = structuredClone(projectEvidence(local, field)),
        byId = new Map(merged.map((item, itemIndex) => [item.id, itemIndex]));
      for (const incomingItem of projectEvidence(remote, field)) {
        const existingIndex = byId.get(incomingItem.id);
        if (existingIndex === undefined) {
          merged.push(structuredClone(incomingItem));
          byId.set(incomingItem.id, merged.length - 1);
          continue;
        }
        if (same(merged[existingIndex], incomingItem)) {
          duplicates++;
          continue;
        }
        const item = conflictBy(
          "project-evidence",
          `${remote.id}:${field}:${incomingItem.id}`,
          field,
        );
        if (item && choice(item) === "incoming")
          merged[existingIndex] = structuredClone(incomingItem);
      }
      if (merged.length) (next as any)[field] = merged;
    }
    if (origin)
      next.workstationSources = mergeSources(next.workstationSources, [origin]);
    if (!same(local, next)) {
      projects[index] = next;
      projectsUpdated++;
    }
  }
  for (const tombstone of incoming.projectTombstones) {
    const item = conflictBy("project-remote-deletion", tombstone.id);
    if (item && choice(item) === "incoming")
      projects = projects.filter((project) => project.id !== tombstone.id);
  }

  const fingerprints = new Map(
    tasks.map((task) => [taskFingerprint(task), task]),
  );
  for (const remote of incoming.tasks) {
    const restored = conflictBy("task-local-deletion", remote.id);
    if (restored && choice(restored) === "local") continue;
    const index = tasks.findIndex((item) => item.id === remote.id);
    if (index >= 0) {
      if (same(taskComparable(tasks[index]), taskComparable(remote))) {
        const sources = mergeSources(
          tasks[index].workstationSources,
          remote.workstationSources,
        );
        tasks[index].workstationSources = origin
          ? mergeSources(sources, [origin])
          : sources;
        duplicates++;
      } else {
        const item = conflictBy("task-id", remote.id);
        if (item && choice(item) === "incoming") {
          const replacement = structuredClone(remote);
          if (origin)
            replacement.workstationSources = mergeSources(
              replacement.workstationSources,
              [origin],
            );
          tasks[index] = replacement;
        }
      }
      continue;
    }
    const content = conflictBy("task-content-duplicate", remote.id),
      name = conflictBy("task-name-collision", remote.id);
    if (
      (content && choice(content) === "local") ||
      (name && choice(name) === "local")
    ) {
      duplicates++;
      continue;
    }
    const added = structuredClone(remote);
    if (origin)
      added.workstationSources = mergeSources(added.workstationSources, [
        origin,
      ]);
    tasks.push(added);
    fingerprints.set(taskFingerprint(remote), remote);
    tasksAdded++;
  }
  for (const tombstone of incoming.taskTombstones) {
    const item = conflictBy("task-remote-deletion", tombstone.id);
    if (item && choice(item) === "incoming")
      tasks = tasks.filter((task) => task.id !== tombstone.id);
  }
  const projectIds = new Set(projects.map((project) => project.id)),
    orphan = tasks.find(
      (task) => task.projectId && !projectIds.has(task.projectId),
    );
  if (orphan)
    throw new Error(
      `冲突决定会使任务 ${orphan.name} 找不到所属项目；若要采用项目删除，请同时逐项采用其关联任务删除`,
    );

  const mergeList = <T extends { id: string }>(
    key:
      | "templates"
      | "healthRecords"
      | "archiveChanges"
      | "archiveReminders"
      | "archiveRuns",
    local: T[],
    remote: T[],
  ) => {
    const result = structuredClone(local),
      byId = new Map(result.map((item, index) => [item.id, index]));
    for (const incomingItem of remote) {
      const index = byId.get(incomingItem.id);
      if (index === undefined) {
        result.push(structuredClone(incomingItem));
        byId.set(incomingItem.id, result.length - 1);
        continue;
      }
      const left =
          key === "archiveChanges"
            ? changeComparable(result[index] as any)
            : result[index],
        right =
          key === "archiveChanges"
            ? changeComparable(incomingItem as any)
            : incomingItem;
      if (same(left, right)) {
        duplicates++;
        continue;
      }
      const item = analysis.conflicts.find(
        (entry) =>
          entry.kind === listConflictKind(key) &&
          entry.entityId === incomingItem.id,
      );
      if (item && choice(item) === "incoming")
        result[index] = structuredClone(incomingItem);
    }
    return result;
  };
  const templates = mergeList(
      "templates",
      input.current.templates,
      incoming.templates,
    ),
    healthRecords = mergeList(
      "healthRecords",
      input.current.healthRecords,
      incoming.healthRecords,
    ),
    archiveChanges = mergeList(
      "archiveChanges",
      input.current.archiveChanges,
      incoming.archiveChanges,
    ),
    archiveReminders = mergeList(
      "archiveReminders",
      input.current.archiveReminders,
      incoming.archiveReminders,
    ),
    archiveRuns = mergeList(
      "archiveRuns",
      input.current.archiveRuns,
      incoming.archiveRuns,
    ),
    taskTombstones = mergeTombstones(
      input.current.taskTombstones,
      incoming.taskTombstones,
      tasks,
    ),
    projectTombstones = mergeTombstones(
      input.current.projectTombstones,
      incoming.projectTombstones,
      projects,
    ),
    unresolvedConflictIds = analysis.conflicts
      .filter((item) => choice(item) === "local")
      .map((item) => item.id),
    importedAt = input.importedAt || Date.now();
  return {
    state: {
      projects,
      tasks,
      templates,
      healthRecords,
      archiveChanges,
      archiveReminders,
      archiveRuns,
      taskTombstones,
      projectTombstones,
    },
    unresolvedConflictIds,
    result: {
      projectsAdded,
      projectsUpdated,
      tasksAdded,
      duplicates,
      conflicts: unresolvedConflictIds,
      importedAt,
      sourceWorkstationId: input.sourceWorkstationId,
      sourceWorkstationName: input.sourceWorkstationName,
      exportId: input.exportId,
      packageSha256: input.packageSha256,
      unresolvedConflicts: unresolvedConflictIds.length,
    },
  };
}

export function decisionsSha256(decisions: WorkspaceImportDecision[]) {
  if (!Array.isArray(decisions)) throw new Error("工作站冲突决定不是有效列表");
  const ids = new Set<string>();
  for (const item of decisions) {
    if (
      !item ||
      typeof item.conflictId !== "string" ||
      !item.conflictId ||
      ids.has(item.conflictId) ||
      !["local", "incoming"].includes(item.decision)
    )
      throw new Error("工作站冲突决定包含无效或重复项目");
    ids.add(item.conflictId);
  }
  return digest(
    [...decisions]
      .map((item) => ({ conflictId: item.conflictId, decision: item.decision }))
      .sort((left, right) => left.conflictId.localeCompare(right.conflictId)),
  );
}

export function exchangeStateDigest(value: WorkspaceExchangeState) {
  return digest({
    ...value,
    archiveChanges: value.archiveChanges.map(changeComparable),
    taskTombstones: value.taskTombstones.map(({ id, deletedAt }) => ({
      id,
      deletedAt,
    })),
    projectTombstones: value.projectTombstones.map(({ id, deletedAt }) => ({
      id,
      deletedAt,
    })),
  });
}

export function workstationAuditId(
  packageSha256: string,
  decisionDigest: string,
) {
  return `workstation-import-${sha256(`${packageSha256}:${decisionDigest}`).slice(0, 32)}`;
}

/**
 * Publish a workstation import in a recoverable order. Before the authority
 * commit, a failure rolls the separately stored templates back and removes the
 * pending recovery marker. After the authority commit, recovery is deliberately
 * retained until the append-only audit succeeds so a restart can finalize the
 * same import without replaying it.
 */
export async function commitWorkstationImportTransaction<T>(input: {
  writeRecovery: () => Promise<unknown>;
  stageTemplates: () => Promise<unknown>;
  commitAuthority: () => Promise<T>;
  applyCommittedState: (value: T) => Promise<unknown> | unknown;
  writeAudit: (value: T) => Promise<unknown>;
  rollbackTemplates: () => Promise<unknown>;
  clearRecovery: () => Promise<unknown>;
}) {
  await input.writeRecovery();
  let templatesStaged = false,
    authorityCommitted = false;
  try {
    await input.stageTemplates();
    templatesStaged = true;
    const committed = await input.commitAuthority();
    authorityCommitted = true;
    await input.applyCommittedState(committed);
    await input.writeAudit(committed);
    await input.clearRecovery();
    return committed;
  } catch (error) {
    if (!authorityCommitted) {
      try {
        if (templatesStaged) await input.rollbackTemplates();
        await input.clearRecovery();
      } catch (rollbackError) {
        throw new Error(
          `工作站元数据尚未提交，但模板回退未能确认；恢复记录已保留，请停止继续导入并导出诊断信息。原错误：${
            error instanceof Error ? error.message : String(error)
          }；回退错误：${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }
    throw error;
  }
}

function validateWorkstationImportRecovery(
  value: unknown,
): WorkstationImportRecoveryRecord {
  const item = value as Partial<WorkstationImportRecoveryRecord>;
  if (
    !item ||
    item.schema !== 1 ||
    typeof item.previewId !== "string" ||
    !item.previewId ||
    !/^[a-f0-9]{64}$/.test(item.packageSha256 || "") ||
    !/^[a-f0-9]{64}$/.test(item.decisionsSha256 || "") ||
    !Array.isArray(item.decisions) ||
    decisionsSha256(item.decisions) !== item.decisionsSha256 ||
    !/^[a-f0-9]{64}$/.test(item.expectedExchangeDigest || "") ||
    typeof item.sourceWorkstationName !== "string" ||
    !item.sourceWorkstationName.trim() ||
    typeof item.operator !== "string" ||
    !item.operator.trim() ||
    !Number.isSafeInteger(item.previewedRevision) ||
    !/^[a-f0-9]{64}$/.test(item.previewedDigest || "") ||
    !/^[a-f0-9]{64}$/.test(item.previewedExchangeDigest || "") ||
    !Array.isArray(item.previousTemplates) ||
    item.previousTemplates.length > 10_000 ||
    !/^[a-f0-9]{64}$/.test(item.previousTemplatesDigest || "") ||
    digest(item.previousTemplates) !== item.previousTemplatesDigest ||
    !Number.isFinite(item.importedAt) ||
    !item.result ||
    typeof item.result !== "object"
  )
    throw new Error("工作站导入恢复记录无效");
  const templateIds = new Set<string>();
  for (const template of item.previousTemplates) {
    if (
      !template ||
      typeof template !== "object" ||
      typeof template.id !== "string" ||
      !template.id ||
      templateIds.has(template.id)
    )
      throw new Error("工作站导入恢复记录中的模板快照无效");
    templateIds.add(template.id);
  }
  if (
    item.sourceWorkstationId !== undefined &&
    !UUID.test(item.sourceWorkstationId)
  )
    throw new Error("工作站导入恢复记录中的来源身份无效");
  if (item.exportId !== undefined && !UUID.test(item.exportId))
    throw new Error("工作站导入恢复记录中的导出身份无效");
  return item as WorkstationImportRecoveryRecord;
}

export async function loadWorkstationImportRecovery(storage: Storage) {
  const file = path.join(storage.root, "workstation-import-recovery.json"),
    backup = `${file}.bak`;
  let anyFound = false,
    primaryError: unknown;
  for (const candidate of [file, backup]) {
    try {
      const recovery = validateWorkstationImportRecovery(
        JSON.parse(await fs.readFile(candidate, "utf8")),
      );
      if (candidate === backup)
        await storage.write("workstation-import-recovery.json", recovery);
      return recovery;
    } catch (error) {
      primaryError ||= error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") anyFound = true;
    }
  }
  if (anyFound)
    throw new Error(
      `工作站导入恢复记录损坏，Kocpy 已停止继续合并：${
        primaryError instanceof Error
          ? primaryError.message
          : String(primaryError)
      }`,
    );
  return undefined;
}

export function rollbackInterruptedWorkstationImport(input: {
  recovery: unknown;
  currentRevision: number;
  currentDigest: string;
}) {
  let value: WorkstationImportRecoveryRecord;
  try {
    value = validateWorkstationImportRecovery(input.recovery);
  } catch {
    return undefined;
  }
  return value.previewedRevision === input.currentRevision &&
    value.previewedDigest === input.currentDigest
    ? structuredClone(value.previousTemplates)
    : undefined;
}

export function recoverWorkstationImportAudit(input: {
  recovery: unknown;
  currentExchangeDigest: string;
  currentRevision: number;
  currentDigest: string;
  audits: WorkstationImportAuditRecord[];
}) {
  let value: WorkstationImportRecoveryRecord;
  try {
    value = validateWorkstationImportRecovery(input.recovery);
  } catch {
    return undefined;
  }
  if (value.expectedExchangeDigest !== input.currentExchangeDigest)
    return undefined;
  const id = workstationAuditId(value.packageSha256, value.decisionsSha256);
  return (input.audits.find((item) => item.id === id) || {
    id,
    sourceWorkstationId: value.sourceWorkstationId,
    sourceWorkstationName: value.sourceWorkstationName,
    exportId: value.exportId,
    packageSha256: value.packageSha256,
    decisionsSha256: value.decisionsSha256,
    decisions: structuredClone(value.decisions),
    operator: value.operator,
    previewedRevision: value.previewedRevision,
    previewedDigest: value.previewedDigest,
    previewedExchangeDigest: value.previewedExchangeDigest,
    importedRevision: input.currentRevision,
    importedDigest: input.currentDigest,
    importedExchangeDigest: input.currentExchangeDigest,
    importedAt: value.importedAt,
    result: {
      ...value.result,
      importedRevision: input.currentRevision,
      repeated: true,
    },
  }) as WorkstationImportAuditRecord;
}
