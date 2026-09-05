import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ArchiveChangeRecord,
  ArchiveEvidenceState,
  ArchiveHealthRecord,
  ArchiveReminder,
  BackupTask,
  ProjectConfig,
} from "./types";
import { Storage } from "./storage";
import { CatalogDatabase } from "./catalog";
import {
  migrateLegacyArchiveEvidence,
  validateArchiveEvidence,
} from "./archive-evidence";
import {
  LEGACY_WORKSPACE_SCHEMA,
  WORKSPACE_SCHEMA,
  entityDigest,
  sealWorkspaceDocument,
  sealWorkspaceState,
  validateWorkspaceState,
  type WorkspaceMigration,
  type WorkspaceState,
  type WorkspaceTombstone,
} from "./workspace-contract";

const STATE_FILE = "workspace-state.json";
const COMPATIBILITY_FILE = "workspace-compatibility.json";

interface CompatibilityMarker {
  revision: number;
  tasksDigest: string;
  projectsDigest: string;
  archiveDigest?: string;
}

export interface WorkspaceLoadResult {
  state: WorkspaceState;
  source: "primary" | "backup" | "catalog" | "legacy";
  indexRebuilt: boolean;
}

export interface WorkspaceCommitResult {
  state: WorkspaceState;
  compatibilitySynchronized: boolean;
  compatibilityError?: string;
  indexSynchronized: boolean;
  indexError?: string;
}

function updateTombstones<T extends { id: string }>(
  previous: T[],
  next: T[],
  current: WorkspaceTombstone[],
  revision: number,
  committedAt: number,
) {
  const nextIds = new Set(next.map((item) => item.id));
  const removed = previous.filter((item) => !nextIds.has(item.id));
  const tombstones = new Map(current.map((item) => [item.id, item]));
  for (const item of removed)
    tombstones.set(item.id, { id: item.id, revision, deletedAt: committedAt });
  for (const id of nextIds) tombstones.delete(id);
  return [...tombstones.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export class WorkspaceRepository {
  private state?: WorkspaceState;
  private writes: Promise<unknown> = Promise.resolve();
  private compatibilityDirty = false;
  private indexDirty = false;
  private tasksDigest?: string;
  private projectsDigest?: string;
  private archiveDigest?: string;

  constructor(
    private storage: Storage,
    private catalog: CatalogDatabase,
  ) {}

  get snapshot() {
    if (!this.state) throw new Error("工作区尚未初始化");
    return this.state;
  }

  getTasks() {
    return structuredClone(this.snapshot.tasks);
  }

  getProjects() {
    return structuredClone(this.snapshot.projects);
  }

  getArchiveEvidence() {
    const evidence = this.snapshot.archiveEvidence;
    if (!evidence) throw new Error("工作区尚未建立归档证据域");
    return structuredClone(validateArchiveEvidence(evidence));
  }

  async initialize(): Promise<WorkspaceLoadResult> {
    const candidates: Array<{
      source: "primary" | "backup" | "catalog";
      state: WorkspaceState;
    }> = [];
    for (const [source, suffix] of [
      ["primary", ""],
      ["backup", ".bak"],
    ] as const) {
      const value = await this.readStateFile(STATE_FILE + suffix);
      if (value) candidates.push({ source, state: value });
    }
    let catalogState: WorkspaceState | undefined;
    try {
      catalogState = await this.catalog.loadWorkspaceState();
    } catch {
      await this.catalog.recover().catch(() => undefined);
      catalogState = await this.catalog
        .loadWorkspaceState()
        .catch(() => undefined);
    }
    if (catalogState) {
      try {
        candidates.push({
          source: "catalog",
          state: validateWorkspaceState(catalogState),
        });
      } catch {
        catalogState = undefined;
      }
    }

    const highestRevision = Math.max(
        0,
        ...candidates.map((candidate) => candidate.state.revision),
      ),
      highestDigests = new Set(
        candidates
          .filter((candidate) => candidate.state.revision === highestRevision)
          .map((candidate) => candidate.state.digest),
      );
    if (highestDigests.size > 1)
      throw new Error(
        `检测到工作区修订 ${highestRevision} 存在多个互相冲突且摘要有效的版本。Kocpy 已停止自动选择，请保留应用数据并导出诊断信息。`,
      );
    const canonical = candidates.sort((left, right) => {
      const revision = right.state.revision - left.state.revision;
      if (revision) return revision;
      const priority = { primary: 0, backup: 1, catalog: 2 };
      return priority[left.source] - priority[right.source];
    })[0];

    if (canonical) {
      const state =
        canonical.state.schemaVersion === LEGACY_WORKSPACE_SCHEMA
          ? await this.upgradeLegacyState(canonical.state)
          : canonical.state;
      this.state = state;
      this.rememberDomainDigests(state);
      await this.repairCompatibilityMirrors(state);
      const indexRebuilt =
        !catalogState ||
        catalogState.revision !== state.revision ||
        catalogState.digest !== state.digest;
      await this.catalog.applyWorkspaceState(state);
      this.indexDirty = false;
      if (
        canonical.source !== "primary" ||
        canonical.state.schemaVersion !== WORKSPACE_SCHEMA
      )
        await this.publishCanonicalAndMirrors(state);
      return { state, source: canonical.source, indexRebuilt };
    }

    const compatibilityMarker = await this.readCompatibilityMarker();
    if (compatibilityMarker)
      throw new Error(
        "工作区权威状态及其备份都无法通过结构和摘要检查。Kocpy 已停止启动以避免从旧镜像猜测恢复，请保留应用数据并导出诊断信息。",
      );
    const jsonTasks = await this.readLegacyMirror<BackupTask[]>("tasks.json"),
      jsonProjects =
        await this.readLegacyMirror<ProjectConfig[]>("projects.json");
    let indexedTasks: BackupTask[] = [],
      indexedProjects: ProjectConfig[] = [];
    try {
      indexedTasks = await this.catalog.loadTasks();
      indexedProjects = await this.catalog.loadProjects();
    } catch {
      await this.catalog.recover().catch(() => undefined);
      indexedTasks = await this.catalog.loadTasks().catch(() => []);
      indexedProjects = await this.catalog.loadProjects().catch(() => []);
    }
    const migratedAt = Date.now(),
      archiveEvidence = await this.readLegacyArchiveEvidence(migratedAt);
    const migration: WorkspaceMigration = {
      from: "legacy-json-and-catalog",
      migratedAt,
      taskSources: {
        json: jsonTasks.value?.length || 0,
        catalog: indexedTasks.length,
      },
      projectSources: {
        json: jsonProjects.value?.length || 0,
        catalog: indexedProjects.length,
      },
      archiveSources: {
        health: archiveEvidence.healthRecords.length,
        changes: archiveEvidence.changes.length,
        reminders: archiveEvidence.reminders.length,
      },
    };
    const initial = sealWorkspaceState({
      schemaVersion: WORKSPACE_SCHEMA,
      revision: 1,
      committedAt: migratedAt,
      tasks: jsonTasks.found ? jsonTasks.value! : indexedTasks,
      projects: jsonProjects.found ? jsonProjects.value! : indexedProjects,
      taskTombstones: [],
      projectTombstones: [],
      archiveEvidence,
      migration,
    });
    this.state = initial;
    this.rememberDomainDigests(initial);
    await this.publishCanonicalAndMirrors(initial);
    await this.catalog.applyWorkspaceState(initial);
    this.indexDirty = false;
    await this.storage.write("workspace-migration.json", {
      schemaVersion: WORKSPACE_SCHEMA,
      revision: initial.revision,
      digest: initial.digest,
      ...migration,
    });
    return { state: initial, source: "legacy", indexRebuilt: true };
  }

  private async readLegacyArchiveEvidence(at: number) {
    const health = await this.readLegacyMirror<ArchiveHealthRecord[]>(
        "archive-health.json",
      ),
      changes = await this.readLegacyMirror<ArchiveChangeRecord[]>(
        "archive-changes.json",
      ),
      reminders = await this.readLegacyMirror<ArchiveReminder[]>(
        "archive-reminders.json",
      );
    return migrateLegacyArchiveEvidence(
      {
        healthRecords: health.value,
        changes: changes.value,
        reminders: reminders.value,
      },
      at,
    );
  }

  private async upgradeLegacyState(state: WorkspaceState) {
    const committedAt = Date.now(),
      archiveEvidence = await this.readLegacyArchiveEvidence(committedAt),
      migration: WorkspaceMigration = {
        from: state.migration?.from || "legacy-json-and-catalog",
        migratedAt: state.migration?.migratedAt || committedAt,
        taskSources: state.migration?.taskSources || {
          json: state.tasks.length,
          catalog: 0,
        },
        projectSources: state.migration?.projectSources || {
          json: state.projects.length,
          catalog: 0,
        },
        archiveSources: {
          health: archiveEvidence.healthRecords.length,
          changes: archiveEvidence.changes.length,
          reminders: archiveEvidence.reminders.length,
        },
      };
    return sealWorkspaceState({
      schemaVersion: WORKSPACE_SCHEMA,
      revision: state.revision + 1,
      committedAt,
      tasks: state.tasks,
      projects: state.projects,
      taskTombstones: state.taskTombstones,
      projectTombstones: state.projectTombstones,
      archiveEvidence,
      migration,
    });
  }

  commit(options: {
    tasks?: BackupTask[];
    projects?: ProjectConfig[];
    archiveEvidence?: ArchiveEvidenceState;
    /** Full desired tombstone sets used by an explicitly confirmed workstation merge. */
    taskTombstones?: WorkspaceTombstone[];
    projectTombstones?: WorkspaceTombstone[];
    syncCatalog?: boolean;
    syncCompatibility?: boolean;
  }): Promise<WorkspaceCommitResult> {
    const action = this.writes.then(async () => {
      const previous = this.snapshot,
        committedAt = Date.now(),
        revision = previous.revision + 1,
        inputTasks = options.tasks || previous.tasks,
        inputProjects = options.projects || previous.projects,
        inputArchive = options.archiveEvidence || previous.archiveEvidence,
        tasksDigest = options.tasks
          ? entityDigest(inputTasks)
          : this.tasksDigest || entityDigest(previous.tasks),
        projectsDigest = options.projects
          ? entityDigest(inputProjects)
          : this.projectsDigest || entityDigest(previous.projects),
        archiveDigest = options.archiveEvidence
          ? entityDigest(inputArchive)
          : this.archiveDigest || entityDigest(previous.archiveEvidence),
        tombstoneBody = (items: WorkspaceTombstone[]) =>
          items
            .map((item) => ({ id: item.id, deletedAt: item.deletedAt }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        taskTombstonesChanged = options.taskTombstones
          ? entityDigest(tombstoneBody(options.taskTombstones)) !==
            entityDigest(tombstoneBody(previous.taskTombstones))
          : false,
        projectTombstonesChanged = options.projectTombstones
          ? entityDigest(tombstoneBody(options.projectTombstones)) !==
            entityDigest(tombstoneBody(previous.projectTombstones))
          : false;
      if (!inputArchive)
        throw new Error("工作区尚未建立归档证据域，已停止提交");
      validateArchiveEvidence(inputArchive);
      if (
        tasksDigest === (this.tasksDigest || entityDigest(previous.tasks)) &&
        projectsDigest ===
          (this.projectsDigest || entityDigest(previous.projects)) &&
        archiveDigest ===
          (this.archiveDigest || entityDigest(previous.archiveEvidence)) &&
        !taskTombstonesChanged &&
        !projectTombstonesChanged
      ) {
        let compatibilityError: string | undefined;
        if (this.compatibilityDirty && options.syncCompatibility !== false)
          try {
            await this.writeCompatibilityMirrors(previous);
            this.compatibilityDirty = false;
          } catch (error) {
            compatibilityError =
              error instanceof Error ? error.message : String(error);
          }
        if (!options.syncCatalog)
          return {
            state: previous,
            compatibilitySynchronized: !this.compatibilityDirty,
            compatibilityError,
            indexSynchronized: !this.indexDirty,
          };
        try {
          await this.catalog.applyWorkspaceState(previous);
          this.indexDirty = false;
          return {
            state: previous,
            compatibilitySynchronized: !this.compatibilityDirty,
            compatibilityError,
            indexSynchronized: true,
          };
        } catch (error) {
          this.indexDirty = true;
          return {
            state: previous,
            compatibilitySynchronized: !this.compatibilityDirty,
            compatibilityError,
            indexSynchronized: false,
            indexError: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const tasks = options.tasks
          ? structuredClone(inputTasks)
          : previous.tasks,
        projects = options.projects
          ? structuredClone(inputProjects)
          : previous.projects,
        archiveEvidence = options.archiveEvidence
          ? structuredClone(inputArchive)
          : previous.archiveEvidence!,
        normalizeImportedTombstones = (
          items: WorkspaceTombstone[],
          previousItems: WorkspaceTombstone[],
        ) =>
          structuredClone(items)
            .map((item) => {
              const existing = previousItems.find(
                (candidate) =>
                  candidate.id === item.id &&
                  candidate.deletedAt === item.deletedAt,
              );
              return { ...item, revision: existing?.revision || revision };
            })
            .sort((left, right) => left.id.localeCompare(right.id));
      const document = sealWorkspaceDocument({
        schemaVersion: WORKSPACE_SCHEMA,
        revision,
        committedAt,
        tasks,
        projects,
        taskTombstones: options.taskTombstones
          ? normalizeImportedTombstones(
              options.taskTombstones,
              previous.taskTombstones,
            )
          : updateTombstones(
              previous.tasks,
              tasks,
              previous.taskTombstones,
              revision,
              committedAt,
            ),
        projectTombstones: options.projectTombstones
          ? normalizeImportedTombstones(
              options.projectTombstones,
              previous.projectTombstones,
            )
          : updateTombstones(
              previous.projects,
              projects,
              previous.projectTombstones,
              revision,
              committedAt,
            ),
        archiveEvidence,
        migration: previous.migration,
      });
      const next = document.state;
      await this.storage.writeSerialized(STATE_FILE, document.serialized);
      this.state = next;
      this.tasksDigest = tasksDigest;
      this.projectsDigest = projectsDigest;
      this.archiveDigest = archiveDigest;
      this.indexDirty = true;
      let compatibilitySynchronized = !this.compatibilityDirty,
        compatibilityError: string | undefined;
      if (options.syncCompatibility === false) {
        compatibilitySynchronized = false;
        this.compatibilityDirty = true;
      } else {
        try {
          await this.writeCompatibilityMirrors(next);
          compatibilitySynchronized = true;
          this.compatibilityDirty = false;
        } catch (error) {
          compatibilitySynchronized = false;
          this.compatibilityDirty = true;
          compatibilityError =
            error instanceof Error ? error.message : String(error);
        }
      }
      if (!options.syncCatalog)
        return {
          state: next,
          compatibilitySynchronized,
          compatibilityError,
          indexSynchronized: false,
        };
      try {
        await this.catalog.applyWorkspaceState(next);
        this.indexDirty = false;
        return {
          state: next,
          compatibilitySynchronized,
          compatibilityError,
          indexSynchronized: true,
        };
      } catch (error) {
        return {
          state: next,
          compatibilitySynchronized,
          compatibilityError,
          indexSynchronized: false,
          indexError: error instanceof Error ? error.message : String(error),
        };
      }
    });
    this.writes = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  }

  commitTasks(
    tasks: BackupTask[],
    syncCatalog = false,
    syncCompatibility = true,
  ) {
    return this.commit({ tasks, syncCatalog, syncCompatibility });
  }

  commitProjects(projects: ProjectConfig[], syncCatalog = true) {
    return this.commit({ projects, syncCatalog });
  }

  commitArchiveEvidence(
    archiveEvidence: ArchiveEvidenceState,
    tasks?: BackupTask[],
    syncCatalog = true,
  ) {
    return this.commit({ archiveEvidence, tasks, syncCatalog });
  }

  synchronizeIndex() {
    return this.catalog.applyWorkspaceState(this.snapshot).then((result) => {
      this.indexDirty = false;
      return result;
    });
  }

  flush() {
    return this.writes.then(() => undefined);
  }

  private async readStateFile(name: string) {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(this.storage.root, name), "utf8"),
      );
      if (
        raw &&
        typeof raw === "object" &&
        "schemaVersion" in raw &&
        ![LEGACY_WORKSPACE_SCHEMA, WORKSPACE_SCHEMA].includes(raw.schemaVersion)
      )
        throw new Error(
          `当前 Kocpy 不支持工作区格式版本 ${String(raw.schemaVersion)}，为避免破坏数据已停止启动。`,
        );
      return validateWorkspaceState(raw);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.message.startsWith("工作区状态"))
      )
        return undefined;
      throw error;
    }
  }

  private async readLegacyMirror<T extends unknown[]>(name: string) {
    for (const suffix of ["", ".bak"]) {
      try {
        const value = JSON.parse(
          await fs.readFile(
            path.join(this.storage.root, name + suffix),
            "utf8",
          ),
        );
        if (Array.isArray(value)) return { found: true, value: value as T };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
    return { found: false, value: undefined as T | undefined };
  }

  private async readCompatibilityMarker() {
    let markerFileExists = false;
    for (const suffix of ["", ".bak"])
      try {
        const text = await fs.readFile(
          path.join(this.storage.root, COMPATIBILITY_FILE + suffix),
          "utf8",
        );
        markerFileExists = true;
        const value = JSON.parse(text);
        if (value && Number.isSafeInteger(value.revision))
          return value as CompatibilityMarker;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        if (code !== "ENOENT") markerFileExists = true;
      }
    return markerFileExists
      ? { revision: -1, tasksDigest: "", projectsDigest: "" }
      : undefined;
  }

  private compatibilityMarker(state: WorkspaceState): CompatibilityMarker {
    return {
      revision: state.revision,
      tasksDigest: entityDigest(state.tasks),
      projectsDigest: entityDigest(state.projects),
      archiveDigest: entityDigest(state.archiveEvidence),
    };
  }

  private async publishCanonicalAndMirrors(state: WorkspaceState) {
    const { serialized } = sealWorkspaceDocument(
      (({ digest: _digest, ...body }) => body)(state),
    );
    await this.storage.writeSerialized(STATE_FILE, serialized);
    await this.writeCompatibilityMirrors(state);
  }

  private rememberDomainDigests(state: WorkspaceState) {
    this.tasksDigest = entityDigest(state.tasks);
    this.projectsDigest = entityDigest(state.projects);
    this.archiveDigest = entityDigest(state.archiveEvidence);
  }

  private async writeCompatibilityMirrors(state: WorkspaceState) {
    await this.storage.write("tasks.json", state.tasks);
    await this.storage.write("projects.json", state.projects);
    if (!state.archiveEvidence)
      throw new Error("工作区归档证据域缺失，无法同步兼容镜像");
    await this.storage.write(
      "archive-health.json",
      state.archiveEvidence.healthRecords,
    );
    await this.storage.write(
      "archive-changes.json",
      state.archiveEvidence.changes,
    );
    await this.storage.write(
      "archive-reminders.json",
      state.archiveEvidence.reminders,
    );
    await this.storage.write(
      COMPATIBILITY_FILE,
      this.compatibilityMarker(state),
    );
  }

  private async repairCompatibilityMirrors(state: WorkspaceState) {
    const marker = await this.storage.read<CompatibilityMarker | undefined>(
      COMPATIBILITY_FILE,
      undefined,
    );
    const tasks = await this.storage.read<BackupTask[]>("tasks.json", []),
      projects = await this.storage.read<ProjectConfig[]>("projects.json", []),
      healthRecords = await this.storage.read<ArchiveHealthRecord[]>(
        "archive-health.json",
        [],
      ),
      changes = await this.storage.read<ArchiveChangeRecord[]>(
        "archive-changes.json",
        [],
      ),
      reminders = await this.storage.read<ArchiveReminder[]>(
        "archive-reminders.json",
        [],
      ),
      expected = this.compatibilityMarker(state),
      mirrorMatches =
        entityDigest(tasks) === expected.tasksDigest &&
        entityDigest(projects) === expected.projectsDigest &&
        entityDigest(healthRecords) ===
          entityDigest(state.archiveEvidence?.healthRecords || []) &&
        entityDigest(changes) ===
          entityDigest(state.archiveEvidence?.changes || []) &&
        entityDigest(reminders) ===
          entityDigest(state.archiveEvidence?.reminders || []) &&
        (!expected.archiveDigest ||
          expected.archiveDigest === entityDigest(state.archiveEvidence));
    if (mirrorMatches) return;
    if (marker && marker.revision >= state.revision)
      throw new Error(
        marker.revision > state.revision
          ? "兼容镜像记录的修订高于当前可恢复的权威状态。Kocpy 已停止回退，避免用旧修订覆盖可能更新的数据；请保留应用数据并导出诊断包。"
          : "检测到旧版本或外部程序在当前工作区修订后改写了兼容数据。Kocpy 已保留两份状态并停止自动合并，请先导出诊断包再处理。",
      );
    await this.writeCompatibilityMirrors(state);
  }
}
