import { createHash } from "node:crypto";
import { validateArchiveEvidence } from "./archive-evidence";
import type {
  ArchiveEvidenceState,
  BackupTask,
  ProjectConfig,
} from "./types";

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
