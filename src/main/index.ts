import {
  normalizePositions,
  validateArchiveScope,
  validateChecklist,
  type ArchiveScope,
} from "../common/interaction";
import { OperationRegistry } from "./operations";
import { inspectTaskRecovery } from "./recovery";
import { assertVolumeIdentity } from "../common/volume-identity";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  powerSaveBlocker,
  powerMonitor,
  Notification,
  nativeTheme,
  screen,
  type MessageBoxOptions,
} from "electron";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { BackupEngine, hashFile } from "./backup/BackupEngine";
import {
  scan,
  validatePaths,
  segment,
  inside,
  canonical,
  safeChild,
} from "./backup/safety";
import { Storage, defaultSettings } from "./storage";
import { listVolumes, driveInfo, ejectVolume, volumeIdentity } from "./system";
import { makeProxy } from "./proxy";
import { mainWindowLayout } from "./window-layout";
import { installMainWindowConstraints } from "./window-constraints";
import { inspectMedia, isThumbnailMedia, pruneMediaCache } from "./media";
import {
  generateReport,
  generateDailyReport,
  generateProjectReport,
} from "./backup/ReportGenerator";
import { generateMhl, generateAscMhl } from "./backup/ManifestGenerator";
import type {
  ArchiveChangeRecord,
  ArchiveEvidenceState,
  ArchiveHealthRecord,
  ArchiveReminder,
  ArchiveVerificationRun,
  ArchiveVerificationTaskResult,
  BackupTask,
  CompletionActionKind,
  CompletionActionRecord,
  ExistingAuditEvent,
  ExistingCandidateDecision,
  NasPreset,
  ProjectConfig,
  ProjectTemplate,
  ReliabilityValidationRecord,
  SavedProxyPreset,
  TaskConfig,
  ProxyJob,
} from "./types";
import {
  beginCompletionAction,
  ensureCompletionActionPlan,
  failCompletionAction,
  finishCompletionAction,
  publishNewArtifact,
  recoverInterruptedCompletionActions,
  sha256Bytes,
  skipCompletionAction,
} from "./completion-automation";
import {
  archiveResultDigest,
  archiveTaskBaselineDigest,
  dueArchiveReminders,
  migrateLegacyArchiveEvidence,
  projectArchiveReport,
  recordArchiveNotifications,
  recordProjectArchiveRun,
  replaceArchiveEvidence,
  updateArchiveEvidence,
} from "./archive-evidence";
import {
  taskArchiveBaseline,
  verifyArchiveTask,
} from "./archive-verification";
import { repairArchiveFile } from "./archive-repair";
import { compareVersions, selectMacAsset, type GitHubRelease } from "./update";
import {
  claimTimestampedVolume,
  createProjectStructure,
  formatVolumeTimestamp,
  inspectProjectStructure,
  makeProjectFolderName,
} from "./project-path";
import {
  manifestRequirementMet,
  projectCloseoutSummary,
  taskMeetsCopyRequirement,
  verifiedPhysicalCopyCount,
} from "./project-closeout";
import { taskTrustState } from "../common/task-trust";
import { projectDates, shootingDateKey } from "../common/shooting-dates";
import { groupLogicalVolumes } from "../common/logical-volumes";
import {
  benchmarkDirectory,
  buildDiagnosticSnapshot,
  type BenchmarkResult,
} from "./diagnostics";
import {
  generateDeliveryManifest,
  preflightProxyDelivery,
  publishProxyDeliveryPackage,
} from "./delivery";
import {
  captureProxyOutput,
  compareProxyMedia,
  validateProxyParameters,
  verifyProxySource,
} from "./proxy-evidence";
import {
  mergeWorkspace,
  normalizeProjectTemplate,
  sourceSuggestion,
  templateFromProject,
  validateWorkspacePackage,
} from "./lifecycle";
import { CatalogDatabase } from "./catalog";
import {
  claimBackupPriorityPause,
  mapWithConcurrency,
  resumeBackupPausedProxyJobs,
} from "./resource-policy";
import { WorkspaceRepository, type WorkspaceCommitResult } from "./workspace";
import {
  builtInProductionTemplates,
  importExistingBackup,
  inspectExternalManifest,
  previewExistingBackup,
  resolveExistingCandidates,
  projectCoverage,
  repairMissingManifestFiles,
  reviseMhlMissingEntries,
} from "./production-lifecycle";
import { LanProjectIndex, readLanProjectIndex } from "./lan-index";
import {
  consolidateExistingRecords,
  deduplicateBoundRoots,
  existingSourceKey,
} from "./existing-records";
import { ensureTaskMediaBreakdown } from "./media-kind";
import { buildProjectDeletionPreview } from "./project-deletion";
import {
  appendProjectRuleSnapshot,
  appendProjectHandoffEvidence,
  appendTemplateApplicationEvidence,
  attachTaskEvidence,
  recordDailyPlanDecision,
} from "./project-evidence";

app.setName("Kocpy");
const appDataRoot = app.getPath("appData");
const userDataPath =
  process.env.KOCPY_DATA_DIR || path.join(appDataRoot, "Kocpy");
app.setPath("userData", userDataPath);
if (!app.requestSingleInstanceLock()) app.exit(0);

const engine = new BackupEngine(
    path.join(app.getPath("userData"), "thumbnails"),
  ),
  store = new Storage(app.getPath("userData")),
  catalog = new CatalogDatabase(app.getPath("userData")),
  workspace = new WorkspaceRepository(store, catalog);
const normalizeProject = (project: ProjectConfig): ProjectConfig => {
  const shootingDateStart =
    project.shootingDateStart ||
    project.shootingDate ||
    new Date().toLocaleDateString("sv-SE");
  const devices = project.devices?.length
    ? project.devices.slice(0, 10)
    : ["FX3"];
  return {
    ...project,
    devices,
    shootingDateStart,
    shootingDateEnd: project.shootingDateEnd || shootingDateStart,
    projectFolderName:
      project.projectFolderName ||
      makeProjectFolderName(shootingDateStart, project.name),
    volumePrefixByDevice: Object.fromEntries(
      devices.map((device) => [
        device,
        project.volumePrefixByDevice?.[device] ||
          project.volumePrefix ||
          `${device}_`,
      ]),
    ),
    devicePositions: Object.fromEntries(
      devices.flatMap((device) => {
        const positions = normalizePositions(project.devicePositions?.[device]);
        return positions.length ? [[device, positions]] : [];
      }),
    ),
    restDays: [...new Set(project.restDays || [])],
    unusedDevicesByDate: Object.fromEntries(
      Object.entries(project.unusedDevicesByDate || {}).map(
        ([date, values]) => [
          date,
          [...new Set(values)].filter(
            (key) =>
              typeof key === "string" &&
              key.length <= 160 &&
              !/[\\/]/.test(key),
          ),
        ],
      ),
    ),
    expectedDevicesByDate: Object.fromEntries(
      Object.entries(project.expectedDevicesByDate || {}).map(
        ([date, values]) => [
          date,
          [...new Set(values)].filter(
            (key) =>
              typeof key === "string" &&
              key.length <= 160 &&
              !/[\\/]/.test(key),
          ),
        ],
      ),
    ),
    dailyPlanDecisions: (project.dailyPlanDecisions || []).filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.operator === "string" &&
        typeof item.at === "number",
    ),
    requiredCopies: Math.max(1, Math.min(4, project.requiredCopies || 2)),
  };
};
const hasProjectRuleEvidence = (project: ProjectConfig) =>
  Boolean(
    project.activeRuleSnapshotId &&
    project.ruleSnapshots?.some(
      (snapshot) => snapshot.id === project.activeRuleSnapshotId,
    ),
  );
const ensureProjectRuleEvidence = (project: ProjectConfig): ProjectConfig =>
  hasProjectRuleEvidence(project)
    ? project
    : appendProjectRuleSnapshot(project, project);

const sameManifestDifferences = (
  left: BackupTask["externalManifest"],
  right: BackupTask["externalManifest"],
) =>
  Boolean(
    left &&
    right &&
    JSON.stringify({
      missing: left.missing,
      extra: left.extra,
      sizeMismatches: left.sizeMismatches,
      checksumMismatches: left.checksumMismatches,
    }) ===
      JSON.stringify({
        missing: right.missing,
        extra: right.extra,
        sizeMismatches: right.sizeMismatches,
        checksumMismatches: right.checksumMismatches,
      }),
  );

const existingEvent = (
  input: Omit<ExistingAuditEvent, "id" | "at" | "operator"> & {
    at?: number;
    operator?: string;
  },
): ExistingAuditEvent => ({
  id: randomUUID(),
  at: input.at || Date.now(),
  operator: input.operator?.trim() || "本机用户",
  action: input.action,
  sourcePath: input.sourcePath,
  previousPath: input.previousPath,
  manifestPath: input.manifestPath,
  digest: input.digest,
  summary: input.summary,
  details: input.details,
});
const existingOperator = async () =>
  (await store.read("settings.json", defaultSettings)).operator?.trim() ||
  "本机用户";

const appendExistingTaskEvent = (
  task: BackupTask,
  event: ExistingAuditEvent,
) => {
  task.existingAuditTrail = [...(task.existingAuditTrail || []), event];
  return task;
};

const appendProjectTakeoverEvent = (
  project: ProjectConfig,
  event: ExistingAuditEvent,
) => {
  project.takeoverEvents = [...(project.takeoverEvents || []), event];
};

const attachExistingVolumeIdentity = async (task: BackupTask) => {
  const identity = await volumeIdentity(task.sourcePath);
  task.sourceVolumeId = identity.id;
  task.sourceVolumeUuid = identity.uuid;
  task.sourceVolumeName = identity.name;
  const destination = task.destinations[0];
  if (destination)
    Object.assign(destination, {
      volumeId: identity.id,
      volumeUuid: identity.uuid,
      volumeName: identity.name,
    });
  return task;
};

const consolidateProjectExistingRecords = (projectId: string) => {
  const imported = engine
    .getAllTasks()
    .filter(
      (task) =>
        task.projectId === projectId &&
        task.provenance &&
        task.provenance !== "kocpy-transfer",
    );
  const result = consolidateExistingRecords(imported);
  for (const duplicateId of [...result.duplicateIds, ...result.aggregateIds])
    engine.deleteTask(duplicateId);
  return result;
};
const snapshotExistingProjectRecords = (projectId: string) =>
  structuredClone(
    engine
      .getAllTasks()
      .filter(
        (task) =>
          task.projectId === projectId &&
          task.provenance &&
          task.provenance !== "kocpy-transfer",
      ),
  );
const restoreExistingProjectRecords = (
  projectId: string,
  snapshot: BackupTask[],
) => {
  for (const task of engine.getAllTasks())
    if (
      task.projectId === projectId &&
      task.provenance &&
      task.provenance !== "kocpy-transfer"
    )
      engine.deleteTask(task.id);
  for (const task of snapshot) engine.loadTask(structuredClone(task));
};
const prepareProject = (value: ProjectConfig): ProjectConfig => {
  const project = {
    ...value,
    devices: [...(value.devices || [])],
    destinationPaths: [...(value.destinationPaths || [])],
  };
  project.name = segment(project.name);
  if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
  if (
    project.shootingDateEnd &&
    project.shootingDateEnd < project.shootingDateStart
  )
    throw new Error("项目结束日期不能早于开始日期");
  project.devices = [...new Set(project.devices.map(segment))].slice(0, 10);
  if (!project.devices.length) throw new Error("请至少选择一个设备或机位");
  if (
    !project.destinationPaths?.length ||
    project.destinationPaths.length > 4 ||
    project.destinationPaths.some((pathValue) => !path.isAbsolute(pathValue))
  )
    throw new Error("请选择 1–4 个有效备份根目录");
  project.projectFolderName = makeProjectFolderName(
    project.shootingDateStart,
    project.name,
  );
  project.volumePrefixByDevice = Object.fromEntries(
    project.devices.map((device) => [
      device,
      segment(project.volumePrefixByDevice?.[device] || `${device}_`),
    ]),
  );
  project.devicePositions = Object.fromEntries(
    project.devices.flatMap((device) => {
      const positions = normalizePositions(project.devicePositions?.[device]);
      return positions.length ? [[device, positions]] : [];
    }),
  );
  project.restDays = [...new Set(project.restDays || [])];
  project.unusedDevicesByDate = Object.fromEntries(
    Object.entries(project.unusedDevicesByDate || {}).map(([date, values]) => [
      date,
      [...new Set(values)].filter(
        (key) =>
          typeof key === "string" && key.length <= 160 && !/[\\/]/.test(key),
      ),
    ]),
  );
  project.expectedDevicesByDate = Object.fromEntries(
    Object.entries(project.expectedDevicesByDate || {}).map(
      ([date, values]) => [
        date,
        [...new Set(values)].filter(
          (key) =>
            typeof key === "string" && key.length <= 160 && !/[\\/]/.test(key),
        ),
      ],
    ),
  );
  project.requiredCopies = Math.max(
    1,
    Math.min(4, project.requiredCopies || 2),
  );
  return normalizeProject(project);
};
let main: BrowserWindow | null = null,
  persistTimer: ReturnType<typeof setTimeout> | undefined,
  quitReady = false,
  blocker: number | undefined,
  proxyBusy = false,
  proxyController: AbortController | undefined,
  proxyPauseRequested: string | undefined,
  backupStartPending = 0,
  proxyJobs: ProxyJob[] = [];
const proxyIdleWaiters = new Set<() => void>();
let benchmarkHistory: BenchmarkResult[] = [];
let reliabilityValidations: ReliabilityValidationRecord[] = [];
let healthRecords: ArchiveHealthRecord[] = [],
  projectTemplates: ProjectTemplate[] = [],
  archiveChanges: ArchiveChangeRecord[] = [],
  archiveReminders: ArchiveReminder[] = [],
  archiveRuns: ArchiveVerificationRun[] = [],
  archiveEvidenceState: ArchiveEvidenceState | undefined,
  nasPresets: NasPreset[] = [],
  savedProxyPresets: SavedProxyPreset[] = [];
const operations = new OperationRegistry((records) =>
  store.write("operation-history.json", records),
);
const maintenanceLocks = new Set<string>();
const withMaintenanceLock = async <T>(
  key: string,
  operation: () => Promise<T>,
) => {
  if (engine.hasActive() || proxyBusy)
    throw new Error("请等待备份或代理任务结束后再维护素材记录");
  if (maintenanceLocks.has(key))
    throw new Error("同一素材卷已有维护操作进行中");
  maintenanceLocks.add(key);
  try {
    return await operation();
  } finally {
    maintenanceLocks.delete(key);
  }
};
const lanIndex = new LanProjectIndex(() => ({
  projects: [],
  tasks: engine.getAllTasks(),
}));
let lastWorkspaceAuxiliaryWarning = "";
let lastWorkspaceAuthorityFailure = "";
const reportWorkspaceAuthorityFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastWorkspaceAuthorityFailure) return;
  lastWorkspaceAuthorityFailure = message;
  for (const task of engine
    .getAllTasks()
    .filter((item) => ["running", "verifying"].includes(item.status)))
    try {
      engine.pauseTask(task.id);
      task.faultTimeline = [
        ...(task.faultTimeline || []),
        {
          at: Date.now(),
          phase: "workspace-persistence",
          level: "error",
          message: "权威任务记录写入失败，已请求暂停任务",
        },
      ];
    } catch {
      /* a task may already be settling */
    }
  dialog.showErrorBox(
    "权威记录保存失败",
    "Kocpy 无法确认最新任务或项目状态已经落盘，已请求暂停仍在运行的任务。素材文件未因此删除；请不要清卡，先确认系统盘空间和权限并导出诊断信息。\n" +
      message,
  );
};
const reportWorkspaceAuxiliaryState = (
  result: WorkspaceCommitResult,
  expectIndex: boolean,
) => {
  const messages = [
    result.compatibilityError,
    expectIndex ? result.indexError : undefined,
  ].filter(Boolean) as string[];
  const key = messages.join("\n");
  if (!key) {
    lastWorkspaceAuxiliaryWarning = "";
    return;
  }
  if (key === lastWorkspaceAuxiliaryWarning) return;
  lastWorkspaceAuxiliaryWarning = key;
  dialog.showErrorBox(
    "记录已保存，辅助数据待恢复",
    "权威任务和项目记录已经安全写入，素材文件未被删除。下次启动会自动修复兼容镜像或素材索引。\n" +
      key,
  );
};
const commitWorkspace = async (
  options: Parameters<WorkspaceRepository["commit"]>[0],
) => {
  try {
    const result = await workspace.commit(options);
    lastWorkspaceAuthorityFailure = "";
    reportWorkspaceAuxiliaryState(result, Boolean(options.syncCatalog));
    return result;
  } catch (error) {
    reportWorkspaceAuthorityFailure(error);
    throw error;
  }
};
const persist = (syncCatalog = false, syncCompatibility = true) =>
  workspace
    .commitTasks(
      engine.getAllTasks().slice().reverse(),
      syncCatalog,
      syncCompatibility,
    )
    .then((result) => {
      lastWorkspaceAuthorityFailure = "";
      reportWorkspaceAuxiliaryState(result, syncCatalog);
      return result;
    })
    .catch((error) => {
      reportWorkspaceAuthorityFailure(error);
      throw error;
    });
const readProjects = async () => workspace.getProjects();
const writeProjects = (projects: ProjectConfig[]) =>
  workspace
    .commitProjects(projects, true)
    .then((result) => {
      lastWorkspaceAuthorityFailure = "";
      reportWorkspaceAuxiliaryState(result, true);
      return result;
    })
    .catch((error) => {
      reportWorkspaceAuthorityFailure(error);
      throw error;
    });
const applyArchiveEvidence = (evidence: ArchiveEvidenceState) => {
  archiveEvidenceState = evidence;
  healthRecords = evidence.healthRecords;
  archiveChanges = evidence.changes;
  archiveReminders = evidence.reminders;
  archiveRuns = evidence.runs;
};
const currentArchiveEvidence = () => {
  if (!archiveEvidenceState)
    throw new Error("归档证据域尚未初始化，已停止维护操作");
  return archiveEvidenceState;
};
const commitArchiveEvidence = async (
  evidence: ArchiveEvidenceState,
  tasks = engine.getAllTasks().slice().reverse(),
  projects?: ProjectConfig[],
) => {
  try {
    const result = projects
        ? await workspace.commit({
            archiveEvidence: evidence,
            tasks,
            projects,
            syncCatalog: true,
          })
        : await workspace.commitArchiveEvidence(evidence, tasks, true),
      committed = result.state.archiveEvidence;
    if (!committed) throw new Error("权威工作区未返回归档证据状态");
    applyArchiveEvidence(committed);
    for (const task of result.state.tasks) {
      const live = engine.getTask(task.id);
      if (live) Object.assign(live, structuredClone(task));
    }
    lastWorkspaceAuthorityFailure = "";
    reportWorkspaceAuxiliaryState(result, true);
    return result;
  } catch (error) {
    reportWorkspaceAuthorityFailure(error);
    throw error;
  }
};
const sourceInventoryMatches = async (task: BackupTask) => {
  const identity = await volumeIdentity(task.sourcePath);
  if (task.sourceVolumeUuid && task.sourceVolumeUuid !== identity.uuid)
    return false;
  if (
    !task.sourceVolumeUuid &&
    task.sourceVolumeId &&
    identity.id !== task.sourceVolumeId
  )
    return false;
  const current = await scan(task.sourcePath, task.includeHidden),
    expected = new Map(
      task.fileRecords.map((file) => [file.relativePath, file.size]),
    );
  return (
    current.files.length === expected.size &&
    current.files.every((file) => expected.get(file.relativePath) === file.size)
  );
};
const manifestDestinationIndex = (task: BackupTask) =>
  task.destinations.findIndex((destination) => {
    const root = destination.resolvedPath || destination.path;
    return (
      destination.verified &&
      task.fileRecords.every((file) =>
        file.destinations.some(
          (copy) => copy.verified && inside(copy.path, root),
        ),
      )
    );
  });
app.on("second-instance", () => {
  if (main && !main.isDestroyed()) {
    main.show();
    main.focus();
  }
});
async function assertDiagnosticTarget(directory: string) {
  const volumes = await listVolumes();
  const volume = volumes
    .filter(
      (item) =>
        directory === item.path || directory.startsWith(item.path + "/"),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (
    volume?.deviceType === "source" ||
    engine
      .getAllTasks()
      .some(
        (task) =>
          ["pending", "running", "paused", "verifying"].includes(task.status) &&
          (inside(task.sourcePath, directory) ||
            inside(directory, task.sourcePath)),
      )
  )
    throw new Error(
      "素材介质或正在使用的来源禁止写入诊断，请使用专门的空白测试盘。",
    );
  if (
    !(await confirmOperation(
      "允许在此目录进行临时写入测试？",
      directory +
        "\n将创建独立临时目录，写入、回读约 64 MiB 数据（介质测试另含 1000 个小文件），随后清理。不改动已有素材；不代表拔盘、睡眠、断电或长期可靠性认证。",
    ))
  )
    return false;
  return true;
}
const maintenanceNames: Record<string, string> = {
  "existing:import": "接管素材",
  "existing:import-scope": "批量接管",
  "existing:reanalyze-project": "刷新接管记录",
  "existing:establish-baseline": "建立首次基线",
  "existing:repair-manifest-missing": "补回清单缺失文件",
  "existing:reverify-manifest": "核对外部清单",
  "existing:accept-manifest-extra": "修订额外文件清单",
  "existing:revise-manifest-missing": "修订缺失文件清单",
  "archive:verify-project": "复校验项目",
  "archive:verify-scope": "分级复校验",
  "archive:repair-copy": "修复归档副本",
  "archive:audit-untracked": "扫描未记录文件",
  "archive:move-copy": "更新副本位置",
  "workspace:cold-archive": "冷归档",
  "workspace:restore-cold": "恢复冷归档",
  "workspace:import": "合并工作站",
  "diagnostics:benchmark": "磁盘性能预检",
  "diagnostics:validate-volume": "有限介质测试",
  "nas:test": "NAS 读写检查",
  "proxy:export-package": "生成交付目录",
  "volumes:eject-completed": "安全推出设备",
};
const guardedCommands = new Set([
  "tasks:create",
  "tasks:start",
  "tasks:resume",
  "tasks:retry-failed",
  "tasks:recover",
  "tasks:reverify",
  "proxy:enqueue",
  "proxy:resume",
  "proxy:retry",
  "volumes:eject",
  "completion:run",
  "completion:skip",
]);
const changeChannels =
  /^(tasks:(create|delete|reverify|retry-failed)|completion:(run|skip)|projects:(save|delete$|claim-volume|sign-checklist|add-handoff|daily-plan)|existing:(import|reanalyze|establish|repair|reverify|accept|revise)|archive:(verify|repair|move|audit)|workspace:(import|cold-archive|restore-cold)|templates:(apply|save|delete|import|hide)|catalog:rebuild|library:relink)/;
const serialCreates = new Map<string, Promise<unknown>>();
let commandInFlight = 0;
async function confirmOperation(message: string, detail: string) {
  return (
    (
      await dialog.showMessageBox({
        type: "warning",
        title: "Kocpy · 确认操作",
        message,
        detail,
        buttons: ["取消", "确认继续"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1
  );
}
function emitExistingProgress(progress: any) {
  operations.progress(progress);
  if (main && !main.isDestroyed())
    main.webContents.send("existing:progress", progress);
}
function handle(name: string, fn: (...args: any[]) => any) {
  ipcMain.handle(name, async (_event, ...args) => {
    if (
      operations.active &&
      (guardedCommands.has(name) ||
        /^(tasks:(delete|cancel|pause)|projects:(save|delete|claim-volume)|templates:apply|library:relink|catalog:rebuild)$/.test(
          name,
        ))
    )
      throw new Error("后台维护仍在进行，请在操作中心查看结果后再开始传输。");
    const execute = async () => {
      const guarded = guardedCommands.has(name);
      if (guarded) commandInFlight++;
      try {
        if (maintenanceNames[name]) {
          if (engine.hasActive() || proxyBusy || commandInFlight)
            throw new Error("请先完成或取消传输和代理任务，再执行维护。");
          return await operations.run(maintenanceNames[name], () =>
            fn(...args),
          );
        }
        return await fn(...args);
      } finally {
        if (guarded) commandInFlight--;
        if (changeChannels.test(name) && main && !main.isDestroyed())
          main.webContents.send("workspace:changed");
        if (maintenanceNames[name]) void processProxyQueue();
      }
    };
    const key = name === "tasks:create" ? args[0]?.requestId : undefined;
    if (!key) return execute();
    if (serialCreates.has(key)) return serialCreates.get(key);
    const promise = execute();
    serialCreates.set(key, promise);
    try {
      return await promise;
    } finally {
      serialCreates.delete(key);
    }
  });
}
const persistProxyJobs = () => store.write("proxy-jobs.json", proxyJobs);
const workspaceIntegrity = (value: Record<string, unknown>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "integrity"),
        ),
      ),
    )
    .digest("hex");
const gzipAsync = promisify(gzip),
  gunzipAsync = promisify(gunzip);
const syncFileAndParent = async (file: string) => {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await fs.open(path.dirname(file), "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
  } finally {
    await directory.close();
  }
};
const emitProxyJobs = () => {
  if (main && !main.isDestroyed())
    main.webContents.send("proxy:jobs", proxyJobs);
};
async function refreshNasHealth() {
  for (const preset of nasPresets) {
    const started = Date.now();
    try {
      await driveInfo(preset.path);
      Object.assign(preset, {
        online: true,
        lastCheckedAt: Date.now(),
        lastLatencyMs: Date.now() - started,
        lastError: undefined,
      });
    } catch (error) {
      Object.assign(preset, {
        online: false,
        lastCheckedAt: Date.now(),
        lastLatencyMs: Date.now() - started,
        lastError: String(error),
      });
    }
  }
  await store.write("nas-presets.json", nasPresets);
}
async function syncReport(file: string) {
  const settings = await store.read("settings.json", defaultSettings);
  if (!settings.reportSyncPath) return;
  await fs.mkdir(settings.reportSyncPath, { recursive: true });
  const target = path.join(settings.reportSyncPath, path.basename(file));
  if (path.resolve(target) !== path.resolve(file))
    await fs.copyFile(file, target);
}
async function writeProjectJsonStream(
  file: string,
  project: ProjectConfig,
  tasks: BackupTask[],
) {
  const handle = await fs.open(file, "w");
  try {
    await handle.write(
      `{"generatedAt":${JSON.stringify(new Date().toISOString())},"project":${JSON.stringify(project)},"tasks":[`,
    );
    for (let index = 0; index < tasks.length; index++) {
      if (index) await handle.write(",");
      await handle.write(JSON.stringify(tasks[index]));
    }
    await handle.write("]}\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function htmlToPdf(html: Buffer | string) {
  const report = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await report.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(html.toString()),
    );
    return await report.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.35, bottom: 0.35, left: 0.3, right: 0.3 },
    });
  } finally {
    report.destroy();
  }
}
const completionActionLabel: Record<CompletionActionKind, string> = {
  report: "生成校验报告",
  delivery: "生成交付清单",
  proxy: "加入代理队列",
  eject: "安全推出源盘",
};
async function recoverPublishedCompletionArtifact(
  record: CompletionActionRecord,
) {
  if (record.outputPaths?.length !== 1 || !record.outputSha256) return false;
  const output = record.outputPaths[0],
    expected = record.outputSha256[output];
  if (!expected) return false;
  const actual = await hashFile(output, "sha256").catch(() => undefined);
  if (!actual) return false;
  if (actual !== expected)
    throw new Error(
      `上次计划产物已存在但摘要不一致，Kocpy 未覆盖：${output}`,
    );
  finishCompletionAction(record, {
    result: `已核对上次中断前发布的产物：${output}`,
    outputPaths: [output],
    outputSha256: { [output]: expected },
  });
  return true;
}
async function executeCompletionAction(
  task: BackupTask,
  action: CompletionActionKind,
  operator: string,
) {
  const project = (await readProjects()).find(
    (item) => item.id === task.projectId,
  );
  ensureCompletionActionPlan(task, project);
  const started = beginCompletionAction(task, action, operator),
    record = started.record;
  if (!started.shouldRun) return record;
  await persist(true);
  try {
    if (
      (action === "report" || action === "delivery") &&
      (await recoverPublishedCompletionArtifact(record))
    ) {
      await persist(true);
      return record;
    }
    const outputRoot = path.join(
      app.getPath("userData"),
      "completed-actions",
      segment(project?.projectFolderName || project?.name || "未归属项目"),
      segment(task.name),
    );
    if (action === "report" || action === "delivery") {
      const suffix = record.key.slice(0, 10),
        target = path.join(
          outputRoot,
          action === "report"
            ? `${segment(task.name)}_${suffix}_校验报告.pdf`
            : `${segment(task.name)}_${suffix}_交付清单.json`,
        ),
        value =
          action === "report"
            ? await htmlToPdf(
                await generateReport(task, { includeThumbnails: true }),
              )
            : Buffer.from(
                JSON.stringify(
                  {
                    schema: 1,
                    application: "Kocpy",
                    version: app.getVersion(),
                    generatedAt: new Date(
                      record.attempts.at(-1)!.authorizedAt,
                    ).toISOString(),
                    authorization: {
                      action,
                      key: record.key,
                      operator,
                      ruleSnapshotId: record.ruleSnapshotId,
                    },
                    task,
                  },
                  null,
                  2,
                ) + "\n",
                "utf8",
              ),
        digest = sha256Bytes(value);
      record.outputPaths = [target];
      record.outputSha256 = { [target]: digest };
      await persist(true);
      await publishNewArtifact(target, value);
      finishCompletionAction(record, {
        result: `${completionActionLabel[action]}完成：${target}`,
        outputPaths: [target],
        outputSha256: { [target]: digest },
      });
    } else if (action === "proxy") {
      const proxyOut = path.join(outputRoot, "Proxies"),
        video = /\.(mov|mp4|mxf|mts|m2ts|avi|mkv|r3d|braw)$/i,
        eligible = task.fileRecords.filter((item) => video.test(item.relativePath)),
        jobs: ProxyJob[] = [];
      for (const file of eligible) {
        const automationKey = `${record.key}:${file.relativePath}`;
        if (proxyJobs.some((job) => job.automationKey === automationKey)) continue;
        const copy = file.destinations.find((item) => item.verified);
        if (!copy) throw new Error(`代理源没有已校验副本：${file.relativePath}`);
        const checksum = copy.checksum || file.srcChecksum;
        if (!checksum) throw new Error(`代理源缺少哈希证据：${file.relativePath}`);
        const stat = await fs.stat(copy.path).catch(() => undefined);
        if (!stat?.isFile() || stat.size !== file.size)
          throw new Error(`代理源已离线或大小变化：${file.relativePath}`);
        const metadata = await inspectMedia(
          copy.path,
          path.join(app.getPath("userData"), "thumbnails"),
        ).catch(() => ({}) as any);
        const parameters = validateProxyParameters({
          purpose: "review",
          format: "h264",
          resolution: "1080p",
          container: "mp4",
          namingTemplate: "{name}_proxy_{resolution}",
        });
        jobs.push({
          id: randomUUID(),
          automationKey,
          input: copy.path,
          name: path.basename(copy.path),
          outputDir: proxyOut,
          format: "h264",
          resolution: "1080p",
          container: "mp4",
          preset: "review",
          namingTemplate: "{name}_proxy_{resolution}",
          sourceTaskId: task.id,
          sourceRelativePath: file.relativePath,
          status: "pending",
          stage: "queued",
          progress: 0,
          createdAt: Date.now(),
          timecode: metadata.timecode,
          sourceFrameRate: metadata.frameRate,
          sourceAudio: metadata.audio,
          sourceDuration: metadata.duration,
          sourceColorSpace: metadata.colorSpace,
          sourceEvidence: {
            taskId: task.id,
            relativePath: file.relativePath,
            path: copy.path,
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
            hashAlgorithm: task.hashAlgorithm,
            checksum,
            capturedAt: Date.now(),
            media: {
              duration: metadata.duration,
              frameRate: metadata.frameRate,
              timecode: metadata.timecode,
              audio: metadata.audio,
              audioTracks: metadata.audioTracks,
              rotation: metadata.rotation,
              colorSpace: metadata.colorSpace,
              resolution: metadata.resolution,
            },
          },
          parameterSnapshot: parameters,
        });
      }
      proxyJobs.push(...jobs);
      await persistProxyJobs();
      emitProxyJobs();
      const total = proxyJobs.filter((job) =>
        job.automationKey?.startsWith(`${record.key}:`),
      ).length;
      finishCompletionAction(record, {
        result: eligible.length
          ? `代理计划共 ${total} 项，本次新增 ${jobs.length} 项；重复触发未重复入队`
          : "没有可代理的视频文件，未创建队列项",
      });
      void processProxyQueue();
    } else {
      const frozenRules = project?.ruleSnapshots?.find(
          (snapshot) => snapshot.id === task.projectRuleSnapshotId,
        )?.rules,
        requiredCopies = frozenRules?.requiredCopies || project?.requiredCopies || 2;
      if (
        !task.destinations.length ||
        !task.destinations.every((item) => item.verified) ||
        !manifestRequirementMet(task) ||
        !taskMeetsCopyRequirement(task, requiredCopies)
      )
        throw new Error(
          `任务尚未满足清单、全部目标校验或 ${requiredCopies} 份物理独立副本要求，不能推出源盘`,
        );
      const volume = (await listVolumes()).find(
        (item) => item.canEject && inside(task.sourcePath, item.path),
      );
      if (!volume) throw new Error("源盘当前不在线或不可推出；没有按成功处理");
      assertVolumeIdentity(
        task.sourceVolumeUuid,
        task.sourceVolumeId,
        await volumeIdentity(volume.path),
        "源",
      );
      const inUse = engine.getAllTasks().some(
        (item) =>
          item.id !== task.id &&
          ["pending", "running", "paused", "verifying"].includes(item.status) &&
          (inside(item.sourcePath, volume.path) ||
            item.destinations.some((destination) => inside(destination.path, volume.path))),
      );
      if (inUse) throw new Error("源盘仍被其他任务使用，已停止推出");
      if (
        proxyJobs.some(
          (job) =>
            ["pending", "running", "paused"].includes(job.status) &&
            (inside(job.input, volume.path) || inside(job.outputDir, volume.path)),
        )
      )
        throw new Error("源盘仍被代理任务使用，已停止推出");
      await ejectVolume(volume.path);
      finishCompletionAction(record, {
        result: `${volume.name} 已由 ${operator} 确认并安全推出`,
      });
    }
    await persist(true);
    if (main && !main.isDestroyed()) main.webContents.send("workspace:changed");
    return record;
  } catch (error) {
    failCompletionAction(record, error);
    task.faultTimeline = [
      ...(task.faultTimeline || []),
      {
        at: Date.now(),
        phase: `completion-action:${action}`,
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
    await persist(true);
    if (main && !main.isDestroyed()) main.webContents.send("workspace:changed");
    throw error;
  }
}
async function processProxyQueue() {
  if (
    proxyBusy ||
    operations.active ||
    backupStartPending > 0 ||
    engine.hasActive()
  )
    return;
  let dependencyChanged = false;
  for (const queued of proxyJobs.filter((item) => item.status === "pending")) {
    const failed = (queued.dependsOn || []).find((id) =>
      ["failed", "cancelled"].includes(
        proxyJobs.find((item) => item.id === id)?.status || "",
      ),
    );
    if (failed) {
      queued.status = "failed";
      queued.error = `依赖任务 ${failed} 未完成`;
      queued.completedAt = Date.now();
      dependencyChanged = true;
    }
  }
  const job = proxyJobs.find(
    (j) =>
      j.status === "pending" &&
      (j.dependsOn || []).every(
        (id) =>
          proxyJobs.find((item) => item.id === id)?.status === "completed",
      ),
  );
  if (!job) {
    if (dependencyChanged) {
      await persistProxyJobs();
      emitProxyJobs();
    }
    return;
  }
  proxyBusy = true;
  proxyController = new AbortController();
  Object.assign(job, {
    status: "running",
    stage: "validating-source",
    progress: 0,
    startedAt: Date.now(),
    error: undefined,
  });
  emitProxyJobs();
  await persistProxyJobs();
  const lock = powerSaveBlocker.start("prevent-app-suspension");
  let unpublishedProxyOutput: string | undefined;
  try {
    const parameters = job.parameterSnapshot;
    if (!parameters)
      throw new Error("旧代理任务缺少参数快照，请从素材库重新加入队列");
    validateProxyParameters(parameters);
    await verifyProxySource(job, proxyController.signal);
    job.stage = "transcoding";
    emitProxyJobs();
    await persistProxyJobs();
    const result = await makeProxy(
      job.input,
      job.outputDir,
      parameters.format,
      parameters.resolution,
      {
        signal: proxyController.signal,
        namingTemplate: parameters.namingTemplate,
        bitrateMbps: parameters.bitrateMbps,
        container: parameters.container,
        onProgress: (progress) => {
          job.progress = progress;
          emitProxyJobs();
        },
      },
    );
    unpublishedProxyOutput = result.outputPath;
    job.stage = "validating-output";
    emitProxyJobs();
    const outputMetadata = await inspectMedia(
      result.outputPath,
      path.join(app.getPath("userData"), "thumbnails"),
    ).catch(() => ({}) as any);
    const outputEvidence = await captureProxyOutput(result.outputPath, {
        duration: outputMetadata.duration,
        frameRate: outputMetadata.frameRate,
        timecode: outputMetadata.timecode,
        audio: outputMetadata.audio,
        audioTracks: outputMetadata.audioTracks,
        rotation: outputMetadata.rotation,
        colorSpace: outputMetadata.colorSpace,
        resolution: outputMetadata.resolution,
      }, proxyController.signal),
      validation = compareProxyMedia(
        job.sourceEvidence!.media,
        outputEvidence,
      );
    Object.assign(job, {
      status: "completed",
      stage: "ready",
      progress: 100,
      outputPath: result.outputPath,
      outputEvidence,
      completedAt: Date.now(),
      validation,
    });
    unpublishedProxyOutput = undefined;
  } catch (e: any) {
    if (unpublishedProxyOutput)
      await fs.unlink(unpublishedProxyOutput).catch(() => {});
    const paused = proxyPauseRequested === job.id;
    Object.assign(job, {
      status: paused
        ? "paused"
        : proxyController.signal.aborted
          ? "cancelled"
          : "failed",
      error: paused ? undefined : e.message || String(e),
      pauseReason: paused ? job.pauseReason || "user" : undefined,
      stage: paused ? "queued" : job.stage,
      completedAt: paused ? undefined : Date.now(),
    });
  } finally {
    proxyBusy = false;
    proxyController = undefined;
    proxyPauseRequested = undefined;
    for (const resolve of proxyIdleWaiters) resolve();
    proxyIdleWaiters.clear();
    powerSaveBlocker.stop(lock);
    await persistProxyJobs();
    emitProxyJobs();
    void processProxyQueue();
  }
}

async function waitForProxyIdle() {
  if (!proxyBusy) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proxyIdleWaiters.delete(done);
      reject(new Error("代理任务未能及时让出资源，请先手动暂停后重试"));
    }, 15_000);
    const done = () => {
      clearTimeout(timeout);
      resolve();
    };
    proxyIdleWaiters.add(done);
    if (!proxyBusy) {
      proxyIdleWaiters.delete(done);
      done();
    }
  });
}

async function withBackupPriority<T>(operation: () => Promise<T>) {
  backupStartPending++;
  try {
    const running = proxyJobs.find((job) => job.status === "running");
    if (proxyBusy && running) {
      // A user pause already in flight remains a user decision. The backup
      // waits for the same safe boundary but must not make it auto-resumable.
      if (claimBackupPriorityPause(running, Boolean(proxyPauseRequested))) {
        proxyPauseRequested = running.id;
        proxyController?.abort(new Error("备份任务优先，代理已安全暂停"));
      }
      await waitForProxyIdle();
    }
    return await operation();
  } finally {
    backupStartPending--;
    if (!engine.hasActive()) void processProxyQueue();
  }
}
function createWindow() {
  const layout = mainWindowLayout(screen.getPrimaryDisplay().workAreaSize);
  main = new BrowserWindow({
    ...layout,
    center: true,
    title: "Kocpy",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 23 },
    backgroundColor: "#111215",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  main.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  installMainWindowConstraints(main, screen);
  main.webContents.on("will-navigate", (event) => event.preventDefault());
  main.once("ready-to-show", () => main?.show());
  main.on("close", (event) => {
    if ((engine.hasActive() || proxyBusy || operations.active) && !quitReady) {
      event.preventDefault();
      main?.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL)
    main.loadURL(process.env.ELECTRON_RENDERER_URL);
  else main.loadFile(path.join(__dirname, "../renderer/index.html"));
}
app.whenReady().then(async () => {
  let workspaceLoad;
  try {
    workspaceLoad = await workspace.initialize();
  } catch (error) {
    const reportPath = path.join(
        app.getPath("userData"),
        "workspace-startup-error.json",
      ),
      files = await Promise.all(
        [
          "workspace-state.json",
          "workspace-state.json.bak",
          "workspace-compatibility.json",
          "tasks.json",
          "tasks.json.bak",
          "projects.json",
          "projects.json.bak",
          "catalog.sqlite",
          "catalog.sqlite.bak",
          "catalog.sqlite.bak2",
          "catalog.sqlite.bak3",
        ].map(async (name) => {
          const stat = await fs
            .stat(path.join(app.getPath("userData"), name))
            .catch(() => undefined);
          return {
            name,
            present: Boolean(stat),
            bytes: stat?.size,
            modifiedAt: stat?.mtime.toISOString(),
          };
        }),
      ),
      reportSaved = await fs
        .writeFile(
          reportPath,
          JSON.stringify(
            {
              schema: 1,
              generatedAt: new Date().toISOString(),
              version: app.getVersion(),
              error: error instanceof Error ? error.message : String(error),
              files,
              privacy: "不包含任务、项目、素材内容、完整素材路径或文件清单。",
            },
            null,
            2,
          ),
          "utf8",
        )
        .then(
          () => true,
          () => false,
        );
    dialog.showErrorBox(
      "工作区记录需要处理",
      `${error instanceof Error ? error.message : String(error)}\n\nKocpy 没有改写素材文件。请保留 Kocpy 应用数据目录，不要用旧版继续写入，也不要删除记录文件。${reportSaved ? `\n已生成脱敏启动报告：${reportPath}` : "\n启动报告无法写入，请同时检查系统盘空间和应用数据目录权限。"}`,
    );
    app.exit(1);
    return;
  }
  operations.restore(await store.read("operation-history.json", []));
  const initialSettings = await store.read("settings.json", defaultSettings);
  nativeTheme.themeSource =
    initialSettings.theme === "light" ? "light" : "dark";
  await pruneMediaCache(
    path.join(app.getPath("userData"), "thumbnails"),
    Math.max(1, Math.min(100, initialSettings.thumbnailCacheGiB || 2)) *
      1024 ** 3,
  ).catch(() => {});
  proxyJobs = await store.read<ProxyJob[]>("proxy-jobs.json", []);
  benchmarkHistory = await store.read<BenchmarkResult[]>("benchmarks.json", []);
  reliabilityValidations = await store.read<ReliabilityValidationRecord[]>(
    "reliability-validations.json",
    [],
  );
  applyArchiveEvidence(workspace.getArchiveEvidence());
  const interruptedRepair = await store.read<
    | {
        operationId: string;
        taskId: string;
        projectId?: string;
        operator?: string;
        target?: string;
        status?: string;
        events?: Array<Record<string, unknown>>;
      }
    | undefined
  >("archive-repair-recovery.json", undefined);
  if (
    interruptedRepair?.operationId &&
    !archiveChanges.some(
      (item) => item.id === `repair-recovery:${interruptedRepair.operationId}`,
    )
  ) {
    const recoveryEvents = (interruptedRepair.events || [])
        .slice(-1_000)
        .map((event) => ({
          at:
            typeof event.at === "number" && Number.isFinite(event.at)
              ? event.at
              : Date.now(),
          relativePath:
            typeof event.relativePath === "string"
              ? event.relativePath
              : undefined,
          action:
            typeof event.action === "string" && event.action
              ? event.action
              : "unknown-recovery-event",
          path: typeof event.path === "string" ? event.path : undefined,
          checksum:
            typeof event.checksum === "string" ? event.checksum : undefined,
          error: typeof event.error === "string" ? event.error : undefined,
          repaired:
            typeof event.repaired === "number" &&
            Number.isFinite(event.repaired) &&
            event.repaired >= 0
              ? event.repaired
              : undefined,
        })),
      preservedPath = [...recoveryEvents]
        .reverse()
        .find((event) => event.action === "preserved-damaged-original")?.path;
    const recoveryEvidence = updateArchiveEvidence(currentArchiveEvidence(), {
      changes: [
        {
          id: `repair-recovery:${interruptedRepair.operationId}`,
          projectId: interruptedRepair.projectId || "",
          taskId: interruptedRepair.taskId,
          runId: interruptedRepair.operationId,
          operator: interruptedRepair.operator || "上次运行未记录",
          at: Date.now(),
          kind: "repaired",
          path: interruptedRepair.target,
          preservedPath,
          recoveryEvents,
          outcome: "partial",
          note: `检测到上次归档修复在权威结算前中断；已将 ${recoveryEvents.length} 条恢复事件写入追加式审计，必须重新核对目标后再继续。`,
        },
      ],
    });
    await commitArchiveEvidence(recoveryEvidence, workspace.getTasks());
    await fs
      .unlink(path.join(store.root, "archive-repair-recovery.json"))
      .catch(() => undefined);
    await fs
      .unlink(path.join(store.root, "archive-repair-recovery.json.bak"))
      .catch(() => undefined);
  }
  projectTemplates = (
    await store.read<ProjectTemplate[]>("project-templates.json", [])
  ).map(normalizeProjectTemplate);
  nasPresets = await store.read<NasPreset[]>("nas-presets.json", []);
  savedProxyPresets = await store.read<SavedProxyPreset[]>(
    "proxy-presets.json",
    [],
  );
  void refreshNasHealth();
  setInterval(() => void refreshNasHealth(), 60_000);
  const notifyDueArchiveReminders = async () => {
    const now = Date.now(),
      due = dueArchiveReminders(archiveReminders, now);
    if (!due.length) return;
    const projects = await readProjects(),
      reminders = recordArchiveNotifications(
        archiveReminders,
        due.map((item) => item.id),
        now,
      );
    for (const reminder of due) {
      const project = projects.find(
          (item) => item.id === reminder.projectId,
        ),
        state =
          reminder.lastTargetState === "offline"
            ? "上次目标离线"
            : reminder.lastTargetState === "identity-unknown"
              ? "上次身份未知"
              : reminder.lastRisk === "critical"
                ? "上次存在严重风险"
                : reminder.lastRisk === "attention"
                  ? "上次需要处理"
                  : "等待用户复校验";
      if (Notification.isSupported())
        new Notification({
          title: "归档复校验到期",
          body: `${project?.name || "项目"} · ${state}。这只是提醒，不代表已经执行核验。`,
          silent: !initialSettings.notificationSound,
        }).show();
    }
    await commitArchiveEvidence(
      updateArchiveEvidence(currentArchiveEvidence(), { reminders }),
      workspace.getTasks(),
    );
  };
  await notifyDueArchiveReminders();
  setInterval(
    () => void notifyDueArchiveReminders().catch(() => undefined),
    3_600_000,
  );
  for (const template of builtInProductionTemplates()) {
    const index = projectTemplates.findIndex((item) => item.id === template.id);
    if (index < 0) projectTemplates.push(template);
    else
      projectTemplates[index] = {
        ...template,
        hidden: projectTemplates[index].hidden,
      };
  }
  for (const job of proxyJobs)
    if (job.status === "running") {
      job.status = "failed";
      job.error = "上次转码被中断，可点击重试";
      job.pauseReason = undefined;
    } else if (
      job.status === "paused" &&
      job.pauseReason === "backup-priority"
    ) {
      job.status = "pending";
      job.pauseReason = undefined;
      job.error = undefined;
    }
  const saved = structuredClone(workspaceLoad.state.tasks);
  let startupRecordsChanged = false;
  for (const task of saved) {
    if (ensureTaskMediaBreakdown(task)) startupRecordsChanged = true;
    if (recoverInterruptedCompletionActions(task)) startupRecordsChanged = true;
    if (["pending", "running", "paused", "verifying"].includes(task.status)) {
      task.status = "failed";
      task.errorMessage = "上次运行中断。可重新执行并重新校验已有文件。";
      startupRecordsChanged = true;
    }
    engine.loadTask(task);
  }
  const initialProjects = structuredClone(workspaceLoad.state.projects).map(
    normalizeProject,
  );
  startupRecordsChanged ||= initialProjects.some(
    (project, index) =>
      JSON.stringify(project) !==
      JSON.stringify(workspaceLoad.state.projects[index]),
  );
  if (startupRecordsChanged)
    await commitWorkspace({
      tasks: engine.getAllTasks().slice().reverse(),
      projects: initialProjects,
      syncCatalog: true,
    });
  handle("dialog:directory", async (defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath:
        defaultPath && path.isAbsolute(defaultPath) ? defaultPath : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("dialog:validate-directories", async (paths: string[]) => {
    if (!Array.isArray(paths) || !paths.length || paths.length > 64)
      throw new Error("请拖入 1–64 个文件夹");
    return Promise.all(
      [...new Set(paths)].map(async (location) => {
        if (
          typeof location !== "string" ||
          !path.isAbsolute(location) ||
          location.includes("\0")
        )
          throw new Error("拖入的文件夹路径无效");
        const real = await fs.realpath(location);
        if (!(await fs.stat(real)).isDirectory())
          throw new Error(
            `请选择文件夹，不是单个文件：${path.basename(location)}`,
          );
        return real;
      }),
    );
  });
  handle("tasks:list", () =>
    engine.getAllTasks().map((task) => ({ ...task, fileRecords: [] })),
  );
  handle("tasks:get", (id: string) => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    return task;
  });
  handle("catalog:stats", () => catalog.stats());
  handle(
    "catalog:files",
    async (options: {
      projectId?: string;
      query?: string;
      kind?: string;
      cursor?: string;
      limit?: number;
    }) => {
      const page = await catalog.pageFileBatch(options || {}),
        probes = page.rows.flatMap((row: any, rowIndex) =>
          (row.destinations || []).map((copy: any, copyIndex: number) => ({
            rowIndex,
            copyIndex,
            path: copy.path,
          })),
        ),
        online = await mapWithConcurrency(probes, 16, (probe) =>
          fs.access(probe.path).then(
            () => true,
            () => false,
          ),
        ),
        rows: any[] = [];
      let probeIndex = 0;
      for (const row of page.rows as any[])
        rows.push({
          ...row,
          destinations: (row.destinations || []).map((copy: any) => ({
            ...copy,
            online: online[probeIndex++] || false,
          })),
        });
      return { ...page, rows };
    },
  );
  handle("catalog:rebuild", async () => {
    if (engine.hasActive() || proxyBusy)
      throw new Error("请等待当前任务结束后再重建素材索引");
    await workspace.synchronizeIndex();
    return catalog.stats();
  });
  handle("tasks:create", async (config: TaskConfig) => {
    if (operations.active)
      throw new Error("维护操作正在执行，请完成后再创建备份");
    if (config.requestId) {
      const existing = engine
        .getAllTasks()
        .find((task) => task.requestId === config.requestId);
      if (existing) {
        await persist(true);
        return existing;
      }
    }
    const speedFor = (destination: string) =>
      benchmarkHistory
        .filter(
          (item) =>
            inside(destination, item.path) || inside(item.path, destination),
        )
        .sort((a, b) => b.completedAt - a.completedAt)[0]?.writeBps || 0;
    config = {
      ...config,
      destinationPaths: [...config.destinationPaths].sort(
        (a, b) => speedFor(b) - speedFor(a),
      ),
    };
    await validatePaths(config.sourcePath, config.destinationPaths);
    const sourceIdentity = await volumeIdentity(config.sourcePath);
    const destinationIdentities = await Promise.all(
      config.destinationPaths.map((destination) => volumeIdentity(destination)),
    );
    let taskProject: ProjectConfig | undefined;
    if (config.projectId) {
      const projects = (await readProjects()).map(normalizeProject),
        projectIndex = projects.findIndex(
          (item) => item.id === config.projectId,
        );
      let project = projects[projectIndex];
      if (!project) throw new Error("拍摄项目不存在");
      if (!hasProjectRuleEvidence(project)) {
        project = ensureProjectRuleEvidence(project);
        projects[projectIndex] = project;
        await writeProjects(projects);
      }
      taskProject = project;
      const required = project.requiredCopies || 2;
      if (
        destinationIdentities.length < required ||
        new Set(
          destinationIdentities.map((identity) => identity.uuid || identity.id),
        ).size < required
      )
        throw new Error(
          `项目要求 ${required} 份独立副本，请先选择至少 ${required} 个不同卷的目的地；卷 UUID 不同仍不代表物理独立，收工时按存储关系核对`,
        );
    }
    const task = attachTaskEvidence(engine.createTask(config), taskProject);
    task.requestId = config.requestId;
    task.sourceVolumeId = sourceIdentity.id;
    task.sourceVolumeUuid = sourceIdentity.uuid;
    task.sourceVolumeName = sourceIdentity.name;
    task.faultTimeline?.push({
      at: Date.now(),
      phase: "strategy",
      level: "info",
      message: benchmarkHistory.some((item) =>
        config.destinationPaths.some(
          (destination) =>
            inside(destination, item.path) || inside(item.path, destination),
        ),
      )
        ? "已根据历史性能预检结果安排目的地顺序"
        : "未发现目的地性能历史，使用自适应并行复制策略",
    });
    await Promise.all(
      task.destinations.map(async (destination, index) => {
        const identity = destinationIdentities[index];
        destination.volumeId = identity.id;
        destination.volumeUuid = identity.uuid;
        destination.volumeName = identity.name;
      }),
    );
    try {
      await persist(true);
    } catch (error) {
      engine.deleteTask(task.id);
      throw error;
    }
    return task;
  });
  handle("tasks:start", async (id: string) => {
    if (operations.active)
      throw new Error("维护操作正在执行，请完成后再开始备份");
    if (
      ["running", "verifying", "paused", "completed"].includes(
        engine.getTask(id)?.status || "",
      )
    )
      return true;
    return withBackupPriority(async () => {
      engine.startTask(id);
      await persist();
      return true;
    });
  });
  handle("tasks:cancel", (id: string) => {
    engine.cancelTask(id);
    return persist();
  });
  handle("tasks:pause", async (id: string) => {
    engine.pauseTask(id);
    await persist();
    return true;
  });
  handle("tasks:resume", async (id: string) => {
    return withBackupPriority(async () => {
      engine.resumeTask(id);
      await persist();
      return true;
    });
  });
  handle("tasks:reverify", async (id: string) => {
    return withBackupPriority(async () => {
      const result = await engine.reverifyTask(id);
      await persist();
      return result;
    });
  });
  handle("tasks:retry-failed", async (id: string) => {
    return withBackupPriority(async () => {
      engine.retryFailedDestinations(id);
      await persist();
      return true;
    });
  });
  handle("tasks:inspect-recovery", async (id: string) => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    return inspectTaskRecovery(task);
  });
  handle("tasks:recover", async (id: string) => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    const report = await inspectTaskRecovery(task);
    if (!report.canRetry)
      throw new Error("当前尚不满足安全重试条件，请重新检查并处理标出的项目。");
    return withBackupPriority(async () => {
      engine.retryFailedDestinations(id);
      await persist();
      return true;
    });
  });
  handle("tasks:delete", async (id: string) => {
    const task = engine.getTask(id);
    if (!task) return true;
    engine.deleteTask(id);
    try {
      await persist(true);
    } catch (error) {
      engine.loadTask(task);
      throw error;
    }
    return true;
  });
  handle("tasks:priority", async (id: string, value: boolean) => {
    engine.setPriority(id, value);
    await persist();
  });
  handle("completion:plan", async (id: string) => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    const project = (await readProjects()).find(
      (item) => item.id === task.projectId,
    );
    if (!operations.active && ensureCompletionActionPlan(task, project))
      await persist(true);
    return task.completionActionRecords || [];
  });
  handle(
    "completion:run",
    async (id: string, action: CompletionActionKind, operator: string) => {
      if (!["report", "delivery", "proxy", "eject"].includes(action))
        throw new Error("未知完成动作");
      const task = engine.getTask(id);
      if (!task) throw new Error("任务不存在");
      if (typeof operator !== "string" || !operator.trim())
        throw new Error("请填写本次完成动作的操作人");
      const label = completionActionLabel[action];
      const detail =
        action === "eject"
          ? `${task.name}\n将再次核对任务状态、当前源盘身份和占用情况，然后尝试推出源盘。推出失败不会按成功处理；此操作不会删除素材或修改 MHL。`
          : `${task.name}\n将以“${operator?.trim() || "未填写"}”记录本次授权。动作产物不会覆盖已有文件，重复触发不会重复入队；此操作不会修改素材、MHL 或备份校验结论。`;
      if (!(await confirmOperation(`确认${label}？`, detail))) return null;
      return executeCompletionAction(task, action, operator);
    },
  );
  handle(
    "completion:skip",
    async (id: string, action: CompletionActionKind, operator: string) => {
      if (!["report", "delivery", "proxy", "eject"].includes(action))
        throw new Error("未知完成动作");
      const task = engine.getTask(id);
      if (!task) throw new Error("任务不存在");
      if (typeof operator !== "string" || !operator.trim())
        throw new Error("请填写跳过动作的操作人");
      if (
        !(await confirmOperation(
          `本任务不执行“${completionActionLabel[action]}”？`,
          `${task.name}\n这只关闭本任务的建议并保留操作人和时间，不改变备份、校验、素材或 MHL。`,
        ))
      )
        return null;
      const record = skipCompletionAction(task, action, operator);
      await persist(true);
      return record;
    },
  );
  handle("source:scan", async (source: string, includeHidden = true) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          "扫描等待超时。若为 iCloud 或网络目录，请先在 Finder 确认文件已下载并可读取，再重试。",
        );
        controller.abort(error);
        reject(error);
      }, 60000);
    });
    const r = await Promise.race([
      scan(source, includeHidden, controller.signal),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const breakdown = Object.fromEntries(
      (["video", "photo", "audio", "other"] as const).map((kind) => [
        kind,
        { files: 0, bytes: 0 },
      ]),
    ) as Record<
      "video" | "photo" | "audio" | "other",
      { files: number; bytes: number }
    >;
    for (const file of r.files) {
      const kind = /\.(mov|mp4|mxf|mkv|avi|m4v|r3d|braw)$/i.test(file.name)
        ? "video"
        : /\.(jpg|jpeg|png|heic|tif|tiff|dng|arw|cr2|cr3|nef|raf)$/i.test(
              file.name,
            )
          ? "photo"
          : /\.(wav|mp3|aac|flac|aif|aiff)$/i.test(file.name)
            ? "audio"
            : "other";
      breakdown[kind].files++;
      breakdown[kind].bytes += file.size;
    }
    return {
      totalFiles: r.files.length,
      totalBytes: r.totalBytes,
      skipped: r.skipped,
      sample: r.files.slice(0, 6).map((f) => f.relativePath),
      breakdown,
      suggestion: sourceSuggestion(engine.getAllTasks(), {
        volumeId: await volumeIdentity(source).then(
          (identity) => identity.uuid || identity.id,
          () => undefined,
        ),
        files: r.files.map((file) => ({
          relativePath: file.relativePath,
          size: file.size,
        })),
      }),
    };
  });
  handle("volumes:list", listVolumes);
  handle("volumes:info", driveInfo);
  handle("volumes:eject", async (volume: string) => {
    if (
      engine
        .getAllTasks()
        .some(
          (t) =>
            ["running", "paused", "verifying", "pending"].includes(t.status) &&
            (inside(t.sourcePath, volume) ||
              t.destinations.some((d) => inside(d.path, volume))),
        )
    )
      throw new Error("该磁盘有进行中或等待中的任务，请先取消任务");
    if (
      proxyJobs.some(
        (job) =>
          ["pending", "running", "paused"].includes(job.status) &&
          (inside(job.input, volume) || inside(job.outputDir, volume)),
      )
    )
      throw new Error("该磁盘有等待中或进行中的代理任务，请先取消任务");
    return ejectVolume(volume);
  });
  handle(
    "volumes:eject-completed",
    async (previewOnly = false, selectedPaths?: string[]) => {
      const volumes = await listVolumes(),
        results: Array<{ path: string; ok: boolean; error?: string }> = [];
      for (const volume of volumes.filter(
        (item) =>
          item.canEject && (previewOnly || selectedPaths?.includes(item.path)),
      )) {
        const unsafe = engine
          .getAllTasks()
          .some(
            (task) =>
              ["running", "paused", "verifying", "pending"].includes(
                task.status,
              ) &&
              (inside(task.sourcePath, volume.path) ||
                task.destinations.some((destination) =>
                  inside(destination.path, volume.path),
                )),
          );
        if (unsafe) {
          results.push({
            path: volume.path,
            ok: false,
            error: "仍有进行中任务",
          });
          continue;
        }
        if (
          proxyJobs.some(
            (job) =>
              ["pending", "running", "paused"].includes(job.status) &&
              (inside(job.input, volume.path) ||
                inside(job.outputDir, volume.path)),
          )
        ) {
          results.push({
            path: volume.path,
            ok: false,
            error: "仍有代理任务正在使用",
          });
          continue;
        }
        const related = engine
          .getAllTasks()
          .filter(
            (task) =>
              inside(task.sourcePath, volume.path) ||
              task.destinations.some((destination) =>
                inside(destination.path, volume.path),
              ),
          );
        const complete = related.filter(
          (task) =>
            task.status === "completed" &&
            task.destinations.every((destination) => destination.verified) &&
            manifestRequirementMet(task),
        );
        const uncovered = related
          .filter((task) => ["failed", "cancelled"].includes(task.status))
          .some(
            (task) =>
              !complete.some(
                (candidate) =>
                  (candidate.createdAt || 0) >= (task.createdAt || 0) &&
                  ((candidate.sourceVolumeUuid &&
                    candidate.sourceVolumeUuid === task.sourceVolumeUuid) ||
                    candidate.sourcePath === task.sourcePath),
              ),
          );
        if (!related.length || !complete.length || uncovered) {
          results.push({
            path: volume.path,
            ok: false,
            error: uncovered
              ? "存在尚未被后续成功备份覆盖的失败任务"
              : "没有完整且通过校验的备份记录",
          });
          continue;
        }
        const sourceTasks = complete.filter((task) =>
          inside(task.sourcePath, volume.path),
        );
        if (sourceTasks.length) {
          const latest = sourceTasks.sort(
            (left, right) => (right.completedAt || 0) - (left.completedAt || 0),
          )[0];
          if (!(await sourceInventoryMatches(latest).catch(() => false))) {
            results.push({
              path: volume.path,
              ok: false,
              error: "当前素材卡身份或文件清单与已完成任务不一致",
            });
            continue;
          }
        }
        try {
          if (!previewOnly) await ejectVolume(volume.path);
          results.push({ path: volume.path, ok: true });
        } catch (error: any) {
          results.push({
            path: volume.path,
            ok: false,
            error: error.message || String(error),
          });
        }
      }
      return results;
    },
  );
  const diagnosticSnapshot = async () => ({
    ...(await buildDiagnosticSnapshot({
      version: app.getVersion(),
      tasks: engine.getAllTasks(),
      volumes: await listVolumes(),
      benchmarks: benchmarkHistory,
    })),
    reliabilityValidations: reliabilityValidations.map(
      ({ path: _path, ...record }) => record,
    ),
    archiveHealth: healthRecords.slice(-20),
    workspace: {
      schemaVersion: workspace.snapshot.schemaVersion,
      revision: workspace.snapshot.revision,
      committedAt: workspace.snapshot.committedAt,
      digest: workspace.snapshot.digest.slice(0, 16),
      tasks: workspace.snapshot.tasks.length,
      projects: workspace.snapshot.projects.length,
      taskTombstones: workspace.snapshot.taskTombstones.length,
      projectTombstones: workspace.snapshot.projectTombstones.length,
      catalog: await catalog.stats(),
    },
  });
  handle("diagnostics:benchmark", async (directory: string, sizeMiB = 64) => {
    if (!(await assertDiagnosticTarget(directory))) return null;
    if (!path.isAbsolute(directory))
      throw new Error("请选择有效的性能预检目录");
    if (engine.hasActive() || proxyBusy)
      throw new Error("请在没有备份或代理任务运行时执行性能预检");
    const result = await benchmarkDirectory(directory, sizeMiB);
    benchmarkHistory = [...benchmarkHistory.slice(-19), result];
    await store.write("benchmarks.json", benchmarkHistory);
    return result;
  });
  handle("diagnostics:reliability-list", () => reliabilityValidations);
  handle("diagnostics:validate-volume", async (directory: string) => {
    if (!(await assertDiagnosticTarget(directory))) return null;
    if (!path.isAbsolute(directory)) throw new Error("请选择有效的验收目录");
    if (engine.hasActive() || proxyBusy)
      throw new Error("请在没有任务运行时执行可靠性验收");
    const started = Date.now(),
      identity = await volumeIdentity(directory),
      root = path.join(directory, `.kocpy-reliability-${randomUUID()}`),
      largeBytes = 64 * 1024 * 1024,
      smallFiles = 1000;
    let record: ReliabilityValidationRecord;
    try {
      await fs.mkdir(path.join(root, "small"), { recursive: true });
      const block = Buffer.alloc(largeBytes, 0xa5),
        large = path.join(root, "large-video.bin"),
        writeStarted = Date.now();
      const largeHandle = await fs.open(large, "wx");
      try {
        await largeHandle.writeFile(block);
        await largeHandle.sync();
      } finally {
        await largeHandle.close();
      }
      for (let offset = 0; offset < smallFiles; offset += 100)
        await Promise.all(
          Array.from(
            { length: Math.min(100, smallFiles - offset) },
            async (_, index) => {
              const smallPath = path.join(
                  root,
                  "small",
                  `clip-${String(offset + index).padStart(5, "0")}.dat`,
                ),
                handle = await fs.open(smallPath, "wx");
              try {
                await handle.writeFile(`kocpy-${offset + index}`);
                await handle.sync();
              } finally {
                await handle.close();
              }
            },
          ),
        );
      await syncFileAndParent(large);
      const writeMs = Math.max(1, Date.now() - writeStarted),
        readStarted = Date.now(),
        actual = await hashFile(large, "sha256"),
        expected = createHash("sha256").update(block).digest("hex");
      if (actual !== expected) throw new Error("大文件回读哈希不一致");
      const entries = await fs.readdir(path.join(root, "small"));
      if (entries.length !== smallFiles)
        throw new Error(`小文件数量不一致：${entries.length}/${smallFiles}`);
      for (const name of entries)
        await fs.readFile(path.join(root, "small", name));
      const readMs = Math.max(1, Date.now() - readStarted);
      record = {
        id: randomUUID(),
        path: directory,
        volumeName: identity.name,
        fileSystem: identity.fileSystem || "network/unknown",
        checkedAt: Date.now(),
        status: "passed",
        largeFileBytes: largeBytes,
        smallFiles,
        writeBps: Math.round((largeBytes + smallFiles * 10) / (writeMs / 1000)),
        readBps: Math.round((largeBytes + smallFiles * 10) / (readMs / 1000)),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      record = {
        id: randomUUID(),
        path: directory,
        volumeName: identity.name,
        fileSystem: identity.fileSystem || "network/unknown",
        checkedAt: Date.now(),
        status: "failed",
        largeFileBytes: largeBytes,
        smallFiles,
        durationMs: Date.now() - started,
        error: String(error),
      };
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
    reliabilityValidations = [...reliabilityValidations.slice(-99), record!];
    await store.write("reliability-validations.json", reliabilityValidations);
    if (record!.status === "failed")
      throw new Error(record!.error || "可靠性验收失败");
    return record!;
  });
  handle("diagnostics:get", diagnosticSnapshot);
  handle("diagnostics:export", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_诊断包_${new Date().toLocaleDateString("sv-SE")}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    await fs.writeFile(
      result.filePath,
      JSON.stringify(await diagnosticSnapshot(), null, 2),
      "utf8",
    );
    return result.filePath;
  });
  handle("archive:health-list", () => healthRecords);
  handle("archive:changes", (projectId?: string) =>
    projectId
      ? archiveChanges.filter((item) => item.projectId === projectId)
      : archiveChanges,
  );
  handle("archive:runs", (projectId?: string) =>
    projectId
      ? archiveRuns.filter((item) => item.projectId === projectId)
      : archiveRuns,
  );
  handle("archive:reminders", () => archiveReminders);
  handle("archive:delete-reminder", async (id: string) => {
    const reminders = archiveReminders.filter((item) => item.id !== id);
    await commitArchiveEvidence(
      updateArchiveEvidence(currentArchiveEvidence(), { reminders }),
    );
    return true;
  });
  handle("operations:list", () => operations.list());
  handle("archive:save-reminder", async (value: ArchiveReminder) => {
    const reminder = {
      ...value,
      id: value.id || randomUUID(),
      intervalDays: Math.max(1, Math.min(3650, value.intervalDays || 180)),
      nextAt:
        value.nextAt ||
        Date.now() + Math.max(1, value.intervalDays || 180) * 86_400_000,
    };
    const reminders = [
      ...archiveReminders.filter((item) => item.id !== reminder.id),
      reminder,
    ];
    await commitArchiveEvidence(
      updateArchiveEvidence(currentArchiveEvidence(), { reminders }),
    );
    return reminders;
  });
  const verifyArchiveScopeOperation = async (
    input: ArchiveScope,
    operator: string,
  ) => {
    const scope = validateArchiveScope(input),
      actualOperator = operator?.trim();
    if (!actualOperator) throw new Error("请填写本次归档复校验操作人");
    if (engine.hasActive() || proxyBusy) throw new Error("请等待当前任务结束");
    const started = Date.now(),
      runId = randomUUID(),
      workspaceTasks = workspace.getTasks();
    let tasks = workspaceTasks;
    if (scope.projectId)
      tasks = tasks.filter((task) => task.projectId === scope.projectId);
    if (scope.shootingDate)
      tasks = tasks.filter(
        (task) =>
          shootingDateKey(task.shootingDate) ===
          shootingDateKey(scope.shootingDate),
      );
    if (scope.taskId) tasks = tasks.filter((task) => task.id === scope.taskId);
    if (scope.volumePath)
      tasks = tasks.filter((task) =>
        task.destinations.some(
          (item) =>
            inside(item.resolvedPath || item.path, scope.volumePath!) ||
            inside(scope.volumePath!, item.resolvedPath || item.path),
        ),
      );
    if (!tasks.length) throw new Error("范围内没有素材记录");
    const taskResults: ArchiveVerificationTaskResult[] = [],
      changes: Array<Omit<ArchiveChangeRecord, "previousDigest" | "digest">> = [],
      updatedTasks = new Map<string, BackupTask>();
    for (const task of tasks)
      try {
        const result = await verifyArchiveTask(
          task,
          scope,
          {
            runId,
            operator: actualOperator,
            projectId: task.projectId || scope.projectId || "",
          },
          (progress) => operations.progress(progress),
        );
        taskResults.push(result.result);
        changes.push(...result.changes);
        updatedTasks.set(task.id, result.task);
      } catch (error) {
        const note = error instanceof Error ? error.message : String(error),
          body = {
            taskId: task.id,
            taskName: task.name,
            baselineDigest: archiveTaskBaselineDigest(taskArchiveBaseline(task)),
            status: "failed" as const,
            checkedCopies: 0,
            verifiedCopies: 0,
            missingFiles: 0,
            damagedFiles: 0,
            offlineCopies: 0,
            identityUnknownCopies: 0,
            bytesVerified: 0,
            issues: [note],
          };
        taskResults.push({ ...body, evidenceDigest: archiveResultDigest(body) });
        changes.push({
          id: randomUUID(),
          projectId: task.projectId || scope.projectId || "",
          taskId: task.id,
          runId,
          operator: actualOperator,
          at: Date.now(),
          kind: "damaged",
          hashAlgorithm: task.hashAlgorithm,
          outcome: "failed",
          note,
        });
      }
    const completedAt = Date.now(),
      bytesVerified = taskResults.reduce(
        (sum, item) => sum + item.bytesVerified,
        0,
      ),
      healthyTasks = taskResults.filter((item) => item.status === "healthy").length,
      failedTasks = taskResults.length - healthyTasks,
      missingCopies = taskResults.reduce(
        (sum, item) =>
          sum + item.missingFiles + item.damagedFiles + item.offlineCopies + item.identityUnknownCopies,
        0,
      ),
      offlineCopies = taskResults.reduce((sum, item) => sum + item.offlineCopies, 0),
      identityUnknownCopies = taskResults.reduce(
        (sum, item) => sum + item.identityUnknownCopies,
        0,
      ),
      runProjectId = scope.projectId || `disk:${scope.volumePath || "all"}`,
      run: ArchiveVerificationRun = {
        id: runId,
        projectId: runProjectId,
        scope: scope.kind,
        scopeLabel:
          scope.kind === "disk"
            ? scope.volumePath || "归档盘"
            : scope.kind === "day"
              ? scope.shootingDate || "拍摄日"
              : scope.kind === "card"
                ? tasks[0]?.name || "素材卷"
                : scope.kind === "file"
                  ? scope.relativePath || "单文件"
                  : runProjectId,
        operator: actualOperator,
        startedAt: started,
        completedAt,
        status:
          healthyTasks === taskResults.length
            ? "completed"
            : healthyTasks
              ? "partial"
              : "failed",
        taskResults,
        baselineDigest: archiveTaskBaselineDigest(
          tasks.map((task) => taskArchiveBaseline(task)),
        ),
        resultDigest: archiveResultDigest(taskResults),
        notes: taskResults.flatMap((item) => item.issues),
      },
      durationMs = Math.max(1, completedAt - started),
      record: ArchiveHealthRecord = {
        id: randomUUID(),
        projectId: runProjectId,
        runId,
        operator: actualOperator,
        checkedAt: completedAt,
        taskCount: taskResults.length,
        healthyTasks,
        failedTasks,
        missingCopies,
        durationMs,
        bytesVerified,
        averageReadBps: Math.round(bytesVerified / (durationMs / 1000)),
        risk:
          missingCopies || failedTasks
            ? missingCopies > 1 || failedTasks > 1
              ? "critical"
              : "attention"
            : "healthy",
        scope: scope.kind,
        offlineCopies,
        identityUnknownCopies,
        evidenceDigest: archiveResultDigest(run),
        notes: run.notes,
      };
    const reminders = recordProjectArchiveRun(
        archiveReminders,
        run,
        record.risk,
      ),
      evidence = updateArchiveEvidence(currentArchiveEvidence(), {
        healthRecords: [...healthRecords, record],
        changes,
        reminders,
        runs: [...archiveRuns, run],
      }),
      committedTasks = workspaceTasks.map(
        (task) => updatedTasks.get(task.id) || task,
      );
    await commitArchiveEvidence(evidence, committedTasks);
    return { changes: evidence.changes.slice(-changes.length), record, run };
  };
  handle("archive:verify-scope", verifyArchiveScopeOperation);
  handle(
    "archive:audit-untracked",
    async (projectId: string, root: string, operator: string) => {
    if (!path.isAbsolute(root)) throw new Error("请选择有效的归档根目录");
    if (!operator?.trim()) throw new Error("请填写扫描操作人");
    const expected = new Set(
      engine
        .getAllTasks()
        .filter((task) => task.projectId === projectId)
        .flatMap((task) =>
          task.fileRecords.flatMap((file) =>
            file.destinations.map((copy) => path.resolve(copy.path)),
          ),
        ),
    );
    const additions: Array<
      Omit<ArchiveChangeRecord, "previousDigest" | "digest">
    > = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of await fs
        .readdir(dir, { withFileTypes: true })
        .catch(() => [])) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(file);
        else if (
          !expected.has(path.resolve(file)) &&
          !entry.name.startsWith(".kocpy")
        )
          additions.push({
            id: randomUUID(),
            projectId,
            operator: operator.trim(),
            at: Date.now(),
            kind: "added",
            path: file,
            outcome: "pending-verification",
            note: `发现未记录文件：${path.relative(root, file)}`,
          });
        if (additions.length >= 10000) break;
      }
    }
    const evidence = updateArchiveEvidence(currentArchiveEvidence(), {
      changes: additions,
    });
    await commitArchiveEvidence(evidence);
    return evidence.changes.slice(-additions.length);
  },
  );
  handle(
    "archive:move-copy",
    async (
      taskId: string,
      destinationId: string,
      newPath: string,
      operator: string,
    ) => {
      if (!operator?.trim()) throw new Error("请填写位置更新操作人");
      const tasks = workspace.getTasks(),
        task = tasks.find((item) => item.id === taskId),
        destination = task?.destinations.find(
          (item) => item.id === destinationId,
        );
      if (!task || !destination) throw new Error("副本记录不存在");
      if (!path.isAbsolute(newPath)) throw new Error("请选择有效的新位置");
      const from = destination.resolvedPath || destination.path,
        previousVolumeId = destination.volumeUuid || destination.volumeId,
        resolved = await canonical(newPath),
        identity = await volumeIdentity(resolved);
      for (const record of task.fileRecords) {
        for (const copy of record.destinations) {
          if (inside(copy.path, from)) {
            const relative = path.relative(from, copy.path),
              moved = await safeChild(resolved, relative);
            copy.path = moved;
            copy.verified = false;
          }
        }
      }
      destination.path = newPath;
      destination.resolvedPath = resolved;
      destination.volumeId = identity.id;
      destination.volumeUuid = identity.uuid;
      destination.volumeName = identity.name;
      destination.verified = false;
      const evidence = updateArchiveEvidence(currentArchiveEvidence(), {
        changes: [{
          id: randomUUID(),
          projectId: task.projectId || "",
          taskId,
          operator: operator.trim(),
          at: Date.now(),
          kind: "moved" as const,
          from,
          to: newPath,
          sourceVolumeId: previousVolumeId,
          targetVolumeId: identity.uuid || identity.id,
          outcome: "pending-verification",
          note: `副本位置由 ${from} 更新为 ${newPath}，等待重新校验`,
        }],
      });
      await commitArchiveEvidence(evidence, tasks);
      return task;
    },
  );
  handle("archive:export-changes", async (projectId: string) => {
    const project = (await readProjects()).find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_归档变化_${projectId}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    const report = projectArchiveReport(
        { id: project.id, name: project.name },
        currentArchiveEvidence(),
      ),
      partial = `${result.filePath}.kocpy-${randomUUID()}.partial`;
    try {
      await fs.writeFile(partial, JSON.stringify(report, null, 2), "utf8");
      await syncFileAndParent(partial);
      await fs.rename(partial, result.filePath);
      await syncFileAndParent(result.filePath);
    } catch (error) {
      await fs.unlink(partial).catch(() => undefined);
      throw error;
    }
    return result.filePath;
  });
  handle(
    "archive:verify-project",
    async (projectId: string, operator: string) =>
      (
        await verifyArchiveScopeOperation(
          { kind: "project", projectId },
          operator,
        )
      ).record,
  );
  handle("archive:repair-copy", async (
    taskId: string,
    destinationId: string,
    operator: string,
  ) =>
    withMaintenanceLock(`task:${taskId}`, async () => {
      if (engine.hasActive() || proxyBusy)
        throw new Error("请等待当前任务结束");
      const actualOperator = operator?.trim();
      if (!actualOperator) throw new Error("请填写修复操作人");
      const tasks = workspace.getTasks(),
        task = tasks.find((item) => item.id === taskId);
      if (!task) throw new Error("任务不存在");
      const target = task.destinations.find(
        (destination) => destination.id === destinationId,
      );
      if (!target) throw new Error("目标副本不存在");
      const repairFiles = task.fileRecords.filter((record) =>
        record.destinations.some(
          (copy) =>
            inside(copy.path, target.resolvedPath || target.path) &&
            !copy.verified,
        ),
      );
      const sourceRoots = task.destinations
        .filter((item) => item.id !== target.id && item.verified)
        .map((item) => item.resolvedPath || item.path);
      if (!repairFiles.length)
        throw new Error("该副本没有待修复文件，请刷新记录。");
      if (
        !(await confirmOperation(
          "从健康副本修复归档文件？",
          "素材卷：" +
            task.name +
            "\n目标：" +
            (target.resolvedPath || target.path) +
            "\n候选来源：" +
            (sourceRoots.join("\n") || "按逐文件校验记录查找") +
            "\n目标身份：" +
            (target.volumeUuid || target.volumeId || "待现场核验") +
            "\n待修复：" +
            repairFiles.length +
            " 个文件 / " +
            repairFiles.reduce((sum, file) => sum + file.size, 0) +
            " 字节\n写入前复核来源哈希，原损坏文件另名保留。中途失败可能已有部分文件修复，未完成项仍须处理。",
        ))
      )
        return null;
      const targetIdentity = await volumeIdentity(
        target.resolvedPath || target.path,
      );
      assertVolumeIdentity(
        target.volumeUuid,
        target.volumeId,
        targetIdentity,
        "修复目标 ",
      );
      const operationId = randomUUID(),
        recoveryFile = "archive-repair-recovery.json",
        recovery = {
          schemaVersion: 1,
          operationId,
          taskId,
          projectId: task.projectId || "",
          destinationId,
          operator: actualOperator,
          target: target.resolvedPath || target.path,
          startedAt: Date.now(),
          status: "running",
          events: [] as NonNullable<ArchiveChangeRecord["recoveryEvents"]>,
        },
        repairChanges: Array<
          Omit<ArchiveChangeRecord, "previousDigest" | "digest">
        > = [];
      await store.write(recoveryFile, recovery);
      let repaired = 0,
        preservedDamagedOriginals = 0,
        repairRecorded = false,
        activeRepair:
          | {
              relativePath: string;
              sourcePath: string;
              targetPath: string;
              expectedChecksum: string;
              preservedPath?: string;
            }
          | undefined;
      try {
        for (const record of task.fileRecords) {
          operations.progress({
            message: `修复中 · 已完成 ${repaired}/${repairFiles.length} 个文件`,
            currentFile: record.relativePath,
          });
          const targetRecord = record.destinations.find((entry) =>
            inside(entry.path, target.resolvedPath || target.path),
          );
          if (!targetRecord || targetRecord.verified) continue;
          const healthy = record.destinations.find(
            (entry) => entry.verified && entry.path !== targetRecord.path,
          );
          if (!healthy)
            throw new Error(`${record.relativePath} 没有可用于修复的健康副本`);
          activeRepair = {
            relativePath: record.relativePath,
            sourcePath: healthy.path,
            targetPath: targetRecord.path,
            expectedChecksum: record.srcChecksum,
          };
          const { publishedChecksum, preservedPath } = await repairArchiveFile({
            sourcePath: healthy.path,
            targetPath: targetRecord.path,
            expectedChecksum: record.srcChecksum,
            hashAlgorithm: task.hashAlgorithm,
            onPreserved: async (preserved) => {
              if (activeRepair) activeRepair.preservedPath = preserved;
              preservedDamagedOriginals++;
              recovery.events.push({
                at: Date.now(),
                relativePath: record.relativePath,
                action: "preserved-damaged-original",
                path: preserved,
              });
              await store.write(recoveryFile, recovery);
            },
          }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${record.relativePath}：${message}`);
          });
          targetRecord.verified = true;
          targetRecord.checksum = publishedChecksum;
          repaired++;
          repairChanges.push({
            id: randomUUID(),
            projectId: task.projectId || "",
            taskId: task.id,
            runId: operationId,
            operator: actualOperator,
            at: Date.now(),
            kind: "repaired",
            path: targetRecord.path,
            relativePath: record.relativePath,
            hashAlgorithm: task.hashAlgorithm,
            expectedChecksum: record.srcChecksum,
            actualChecksum: publishedChecksum,
            sourcePath: healthy.path,
            preservedPath,
            sourceVolumeId: (() => {
              const source = task.destinations.find((destination) =>
                inside(
                  healthy.path,
                  destination.resolvedPath || destination.path,
                ),
              );
              return source?.volumeUuid || source?.volumeId;
            })(),
            targetVolumeId: targetIdentity.uuid || targetIdentity.id,
            outcome: "completed",
            note: `${record.relativePath} 已从重新校验的健康副本修复并完成发布后回读`,
          });
          recovery.events.push({
            at: Date.now(),
            relativePath: record.relativePath,
            action: "published-and-verified",
            path: targetRecord.path,
            checksum: publishedChecksum,
          });
          await store.write(recoveryFile, recovery);
          activeRepair = undefined;
        }
        target.verified = false;
        target.error = "修复文件已回读通过，正在执行整卷复校验";
        task.status = "failed";
        task.errorMessage = "修复已发布，等待整卷复校验";
        const repairEvidence = updateArchiveEvidence(
          currentArchiveEvidence(),
          { changes: repairChanges },
        );
        recovery.status = "repair-recorded";
        await store.write(recoveryFile, recovery);
        await commitArchiveEvidence(repairEvidence, tasks);
        repairRecorded = true;
        await fs.unlink(path.join(store.root, recoveryFile)).catch(() => undefined);
        await fs
          .unlink(path.join(store.root, `${recoveryFile}.bak`))
          .catch(() => undefined);
        const verification = await verifyArchiveScopeOperation(
          {
            kind: "card",
            projectId: task.projectId || "",
            taskId: task.id,
          },
          actualOperator,
        );
        return {
          repaired,
          preservedDamagedOriginals,
          verificationRunId: verification.run.id,
        };
      } catch (error) {
        if (repairRecorded) throw error;
        target.verified = false;
        target.error =
          "修复未完成：" + repaired + " 个文件已修复；" + String(error);
        task.status = "failed";
        task.errorMessage = target.error;
        recovery.status = "failed";
        recovery.events.push({
          at: Date.now(),
          action: "failed",
          repaired,
          error: String(error),
        });
        await store.write(recoveryFile, recovery);
        repairChanges.push({
          id: randomUUID(),
          projectId: task.projectId || "",
          taskId: task.id,
          runId: operationId,
          operator: actualOperator,
          at: Date.now(),
          kind: "repaired",
          path: activeRepair?.targetPath || target.resolvedPath || target.path,
          relativePath: activeRepair?.relativePath,
          hashAlgorithm: task.hashAlgorithm,
          expectedChecksum: activeRepair?.expectedChecksum,
          sourcePath: activeRepair?.sourcePath,
          preservedPath: activeRepair?.preservedPath,
          targetVolumeId: targetIdentity.uuid || targetIdentity.id,
          recoveryEvents: recovery.events.slice(-1_000),
          outcome: repaired || activeRepair?.preservedPath ? "partial" : "failed",
          note: target.error,
        });
        try {
          await commitArchiveEvidence(
            updateArchiveEvidence(currentArchiveEvidence(), {
              changes: repairChanges,
            }),
            tasks,
          );
          await fs
            .unlink(path.join(store.root, recoveryFile))
            .catch(() => undefined);
          await fs
            .unlink(path.join(store.root, `${recoveryFile}.bak`))
            .catch(() => undefined);
        } catch (commitError) {
          throw new Error(
            `${target.error}；权威审计提交也失败，恢复记录已保留：${String(commitError)}`,
          );
        }
        throw new Error(target.error);
      }
    }),
  );
  handle("templates:list", () => projectTemplates);
  handle(
    "existing:preview",
    async (
      root: string,
      projectId?: string,
      scope: "card" | "day" | "project" | "auto" = "auto",
      selectedDate?: string,
    ) => {
      const project = projectId
        ? (await readProjects())
            .map(normalizeProject)
            .find((item) => item.id === projectId)
        : undefined;
      return previewExistingBackup(root, project, scope, selectedDate);
    },
  );
  handle(
    "existing:import",
    async (
      projectId: string,
      root: string,
      mode: "manifest-import" | "external-baseline" | "unverified-import",
      metadata: any,
    ) => {
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      if (!hasProjectRuleEvidence(project))
        Object.assign(project, ensureProjectRuleEvidence(project));
      const engineBefore = snapshotExistingProjectRecords(projectId);
      const preview = await previewExistingBackup(
          root,
          project,
          "card",
          metadata?.shootingDate,
        ),
        decisions = resolveExistingCandidates(preview, [
          {
            relativeRoot: ".",
            shootingDate: metadata?.shootingDate || preview.suggestedDate || "",
            device: metadata?.device || preview.suggestedDevice || "",
            cameraPosition: metadata?.cameraPosition,
            card: metadata?.card || preview.suggestedCard || "",
          },
        ]);
      root = preview.root;
      const task = await importExistingBackup(
        project,
        root,
        mode,
        decisions[0],
      );
      const finalPreview = await previewExistingBackup(
        root,
        project,
        "card",
        metadata?.shootingDate,
      );
      if (finalPreview.scanDigest !== preview.scanDigest)
        throw new Error(
          "接管期间目录内容或映射发生变化，未写入记录；请重新预览后再试",
        );
      await attachExistingVolumeIdentity(task);
      const event = existingEvent({
        operator: await existingOperator(),
        action: "import",
        sourcePath: root,
        digest: preview.scanDigest,
        summary: `接管 1 个素材卷；模式 ${mode}`,
        details: { scope: "card", candidates: 1, files: task.totalFiles },
      });
      appendExistingTaskEvent(task, event);
      appendProjectTakeoverEvent(project, event);
      engine.loadTask(task);
      const consolidated = consolidateProjectExistingRecords(projectId);
      project.boundRoots = deduplicateBoundRoots([
        ...(project.boundRoots || []),
        { id: randomUUID(), path: root, boundAt: Date.now(), provenance: mode },
      ]);
      project.managedSince ||= task.shootingDate;
      try {
        await commitWorkspace({
          tasks: engine.getAllTasks().slice().reverse(),
          projects,
          syncCatalog: true,
        });
      } catch (error) {
        restoreExistingProjectRecords(projectId, engineBefore);
        throw error;
      }
      return (
        consolidated.records.find(
          (record) =>
            existingSourceKey(record.sourcePath) === existingSourceKey(root),
        ) || task
      );
    },
  );
  handle(
    "existing:import-scope",
    async (
      projectId: string,
      root: string,
      mode: "manifest-import" | "external-baseline" | "unverified-import",
      scope: "card" | "day" | "project",
      selectedDate?: string,
      jobId = randomUUID(),
      previewDigest?: string,
      candidateDecisions: ExistingCandidateDecision[] = [],
      associateMatchingCopies = false,
    ) => {
      const startedAt = Date.now();
      let completedBytes = 0,
        completedFiles = 0,
        completedCandidates = 0,
        lastEmittedAt = 0;
      const emitImportProgress = (
        phase: "analyzing" | "hashing" | "finalizing" | "completed" | "failed",
        message: string,
        totals: {
          totalFiles?: number;
          totalBytes?: number;
          totalCandidates?: number;
          currentCandidate?: string;
          currentFile?: string;
          force?: boolean;
        } = {},
      ) => {
        const now = Date.now();
        if (!totals.force && now - lastEmittedAt < 120) return;
        lastEmittedAt = now;
        const elapsed = Math.max(0.001, (now - startedAt) / 1000),
          speedBps = completedBytes / elapsed,
          remaining = Math.max(0, (totals.totalBytes || 0) - completedBytes);
        if (main && !main.isDestroyed())
          emitExistingProgress({
            jobId,
            phase,
            message,
            totalFiles: totals.totalFiles || 0,
            completedFiles,
            totalBytes: totals.totalBytes || 0,
            completedBytes,
            totalCandidates: totals.totalCandidates || 0,
            completedCandidates,
            currentCandidate: totals.currentCandidate,
            currentFile: totals.currentFile,
            speedBps,
            eta: speedBps > 0 ? remaining / speedBps : 0,
          });
      };
      emitImportProgress("analyzing", "正在重新扫描并分析目录结构", {
        force: true,
      });
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      if (!associateMatchingCopies)
        throw new Error(
          "请确认相同完整哈希的目录应关联为同一逻辑素材卷；同一物理盘不会重复计数",
        );
      if (!hasProjectRuleEvidence(project))
        Object.assign(project, ensureProjectRuleEvidence(project));
      const engineBefore = snapshotExistingProjectRecords(projectId);
      const preview = await previewExistingBackup(
        root,
        project,
        scope,
        selectedDate,
      );
      root = preview.root;
      if (!/^[a-f0-9]{64}$/.test(previewDigest || ""))
        throw new Error("接管预览已失效，请重新检查目录映射后再接管");
      if (preview.scanDigest !== previewDigest)
        throw new Error("目录内容或识别映射已变化，请重新检查预览后再接管");
      const decisions = resolveExistingCandidates(preview, candidateDecisions),
        candidates = preview.candidates.map((candidate) => ({
          ...candidate,
          ...decisions.find(
            (decision) => decision.relativeRoot === candidate.relativeRoot,
          )!,
        }));
      if (!candidates.length)
        throw new Error(
          scope === "day"
            ? "所选拍摄日下未识别到素材卷"
            : "所选目录下未识别到可接管的素材卷",
        );
      const totalFiles = candidates.reduce((sum, item) => sum + item.files, 0),
        totalBytes = candidates.reduce((sum, item) => sum + item.bytes, 0),
        totalCandidates = candidates.length;
      const tasks = [];
      try {
        for (const candidate of candidates) {
          const candidateRoot =
            candidate.relativeRoot === "."
              ? root
              : path.join(root, candidate.relativeRoot);
          const currentCandidate =
            candidate.card || path.basename(candidateRoot);
          emitImportProgress(
            mode === "unverified-import" ? "finalizing" : "hashing",
            mode === "unverified-import"
              ? "正在导入目录结构"
              : "正在读取文件并建立可信校验记录",
            {
              totalFiles,
              totalBytes,
              totalCandidates,
              currentCandidate,
              force: true,
            },
          );
          tasks.push(
            await importExistingBackup(
              project,
              candidateRoot,
              mode,
              {
                shootingDate: candidate.shootingDate || selectedDate,
                device: candidate.device,
                cameraPosition: candidate.cameraPosition,
                card: currentCandidate,
              },
              {
                onBytes: (count, currentFile) => {
                  completedBytes += count;
                  emitImportProgress("hashing", "正在读取文件并计算哈希", {
                    totalFiles,
                    totalBytes,
                    totalCandidates,
                    currentCandidate,
                    currentFile,
                  });
                },
                onFile: (currentFile) => {
                  completedFiles++;
                  emitImportProgress(
                    mode === "unverified-import" ? "finalizing" : "hashing",
                    mode === "unverified-import"
                      ? "正在记录文件结构"
                      : "文件校验读取完成",
                    {
                      totalFiles,
                      totalBytes,
                      totalCandidates,
                      currentCandidate,
                      currentFile,
                    },
                  );
                },
              },
            ),
          );
          completedCandidates++;
          if (mode === "unverified-import") completedBytes += candidate.bytes;
          emitImportProgress(
            mode === "unverified-import" ? "finalizing" : "hashing",
            `${currentCandidate} 已处理完成`,
            {
              totalFiles,
              totalBytes,
              totalCandidates,
              currentCandidate,
              force: true,
            },
          );
        }
        const finalPreview = await previewExistingBackup(
          root,
          project,
          scope,
          selectedDate,
        );
        if (finalPreview.scanDigest !== preview.scanDigest)
          throw new Error(
            "接管期间目录内容或识别映射发生变化，未写入记录；请重新预览后再试",
          );
        await Promise.all(tasks.map(attachExistingVolumeIdentity));
      } catch (error) {
        emitImportProgress("failed", String(error), {
          totalFiles,
          totalBytes,
          totalCandidates,
          force: true,
        });
        throw error;
      }
      emitImportProgress("finalizing", "正在整理任务并更新项目索引", {
        totalFiles,
        totalBytes,
        totalCandidates,
        force: true,
      });
      const event = existingEvent({
        operator: await existingOperator(),
        action: "import",
        sourcePath: root,
        digest: preview.scanDigest,
        summary: `接管 ${tasks.length} 个素材卷；范围 ${scope}；模式 ${mode}`,
        details: {
          scope,
          mode,
          candidates: tasks.length,
          files: totalFiles,
          bytes: totalBytes,
          matchingCopiesAssociated: true,
        },
      });
      for (const task of tasks) {
        appendExistingTaskEvent(task, event);
        engine.loadTask(task);
      }
      appendProjectTakeoverEvent(project, event);
      const consolidated = consolidateProjectExistingRecords(projectId);
      project.boundRoots = deduplicateBoundRoots([
        ...(project.boundRoots || []),
        { id: randomUUID(), path: root, boundAt: Date.now(), provenance: mode },
      ]);
      project.managedSince ||= tasks
        .map((task) => task.shootingDate)
        .filter(Boolean)
        .sort()[0];
      try {
        await commitWorkspace({
          tasks: engine.getAllTasks().slice().reverse(),
          projects,
          syncCatalog: true,
        });
      } catch (error) {
        restoreExistingProjectRecords(projectId, engineBefore);
        throw error;
      }
      completedBytes = totalBytes;
      completedFiles = totalFiles;
      emitImportProgress("completed", "接管完成", {
        totalFiles,
        totalBytes,
        totalCandidates,
        force: true,
      });
      const affectedSources = new Set(
        tasks.map((task) => existingSourceKey(task.sourcePath)),
      );
      const directMatches = consolidated.records.filter((task) =>
        affectedSources.has(existingSourceKey(task.sourcePath)),
      );
      return directMatches.length
        ? directMatches
        : consolidated.records.filter((task) =>
            task.destinations.some((destination) =>
              affectedSources.has(
                existingSourceKey(destination.resolvedPath || destination.path),
              ),
            ),
          );
    },
  );
  handle(
    "existing:reanalyze-project",
    async (projectId: string, apply = false) => {
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      const importedTasks = engine
        .getAllTasks()
        .filter(
          (task) =>
            task.projectId === projectId &&
            task.provenance &&
            task.provenance !== "kocpy-transfer",
        );
      const engineBefore = apply
        ? snapshotExistingProjectRecords(projectId)
        : [];
      const workingTasks: BackupTask[] = apply
        ? importedTasks
        : structuredClone(importedTasks);
      let metadataUpdated = 0;
      const devicesDetected = new Set<string>(),
        unavailableSources = new Set<string>(),
        previewCache = new Map<
          string,
          ReturnType<typeof previewExistingBackup>
        >();
      for (const task of workingTasks) {
        const sourceKey = existingSourceKey(task.sourcePath);
        let request = previewCache.get(sourceKey);
        if (!request) {
          request = previewExistingBackup(
            task.sourcePath,
            project,
            "card",
            task.shootingDate,
          );
          previewCache.set(sourceKey, request);
        }
        try {
          const preview = await request,
            inferred = preview.candidates[0],
            nextDevice = inferred?.device || task.devices[0],
            nextPosition = inferred?.cameraPosition || task.cameraPosition,
            nextDate = inferred?.shootingDate || task.shootingDate,
            nextCard = inferred?.card || task.name;
          if (nextDevice) devicesDetected.add(nextDevice);
          const changed =
            nextDevice !== task.devices[0] ||
            nextPosition !== task.cameraPosition ||
            nextDate !== task.shootingDate ||
            nextCard !== task.name;
          if (changed) {
            metadataUpdated++;
            task.devices = [nextDevice || "未分类设备"];
            task.cameraPosition = nextPosition;
            task.shootingDate = nextDate;
            task.name = nextCard;
          }
        } catch {
          unavailableSources.add(sourceKey);
          if (task.devices[0]) devicesDetected.add(task.devices[0]);
        }
      }
      const consolidated = consolidateExistingRecords(workingTasks);
      let manifestsInspected = 0,
        manifestDifferences = 0;
      for (const task of consolidated.records) {
        if (unavailableSources.has(existingSourceKey(task.sourcePath)))
          continue;
        try {
          const previousComparison = task.externalManifest,
            comparison = await inspectExternalManifest(task.sourcePath);
          if (
            comparison &&
            previousComparison?.resolution &&
            sameManifestDifferences(previousComparison, comparison)
          )
            comparison.resolution = previousComparison.resolution;
          task.externalManifest = comparison;
          if (!comparison) continue;
          manifestsInspected++;
          if (comparison.status === "mismatch") {
            if (comparison.resolution?.type === "accepted-extra") {
              task.errorMessage = undefined;
              continue;
            }
            manifestDifferences++;
            const summary = [
              comparison.missing.length &&
                `缺少 ${comparison.missing.length} 个文件`,
              comparison.extra.length &&
                `额外 ${comparison.extra.length} 个文件`,
              comparison.sizeMismatches.length &&
                `${comparison.sizeMismatches.length} 个文件大小不同`,
            ]
              .filter(Boolean)
              .join("、");
            const samples = [
              ...comparison.missing.slice(0, 3).map((file) => `缺少：${file}`),
              ...comparison.extra.slice(0, 3).map((file) => `额外：${file}`),
              ...comparison.sizeMismatches
                .slice(0, 3)
                .map((file) => `大小不同：${file.relativePath}`),
            ];
            task.errorMessage = `外部清单差异：${summary}${samples.length ? `。${samples.join("；")}` : ""}`;
          } else if (task.errorMessage?.includes("外部清单")) {
            task.errorMessage = undefined;
          }
        } catch {
          unavailableSources.add(existingSourceKey(task.sourcePath));
        }
      }
      const rootsBefore = project.boundRoots || [],
        uniqueRoots = deduplicateBoundRoots(rootsBefore),
        rootsDeduplicated = rootsBefore.length - uniqueRoots.length;
      if (apply) {
        for (const duplicateId of [
          ...consolidated.duplicateIds,
          ...consolidated.aggregateIds,
        ])
          engine.deleteTask(duplicateId);
        project.boundRoots = uniqueRoots;
        appendProjectTakeoverEvent(
          project,
          existingEvent({
            operator: await existingOperator(),
            action: "refresh",
            sourcePath:
              project.boundRoots[0]?.path ||
              project.projectFolderName ||
              project.name,
            digest: createHash("sha256")
              .update(
                JSON.stringify({
                  importedTasks: importedTasks.length,
                  metadataUpdated,
                  duplicates: consolidated.duplicateIds,
                  aggregates: consolidated.aggregateIds,
                  unavailable: [...unavailableSources].sort(),
                  manifestsInspected,
                  manifestDifferences,
                }),
              )
              .digest("hex"),
            summary: `刷新接管信息：${importedTasks.length} 条记录，${unavailableSources.size} 个来源离线`,
            details: {
              importedTasks: importedTasks.length,
              metadataUpdated,
              duplicatesMerged: consolidated.duplicateIds.length,
              aggregateRecordsRemoved: consolidated.aggregateIds.length,
              unavailableSources: unavailableSources.size,
              manifestDifferences,
            },
          }),
        );
        try {
          await commitWorkspace({
            tasks: engine.getAllTasks().slice().reverse(),
            projects,
            syncCatalog: true,
          });
        } catch (error) {
          restoreExistingProjectRecords(projectId, engineBefore);
          throw error;
        }
      }
      return {
        importedTasks: importedTasks.length,
        metadataUpdated,
        baselinesNeeded: consolidated.records.filter(
          (task) => task.confidence === "unverified",
        ).length,
        duplicatesFound: consolidated.duplicateIds.length,
        duplicatesMerged: apply ? consolidated.duplicateIds.length : 0,
        aggregateRecordsFound: consolidated.aggregateIds.length,
        aggregateRecordsRemoved: apply ? consolidated.aggregateIds.length : 0,
        manifestDifferences,
        manifestsInspected,
        rootsDeduplicated,
        unavailableSources: unavailableSources.size,
        devicesDetected: [...devicesDetected].sort(),
        applied: apply,
      };
    },
  );
  handle(
    "existing:establish-baseline",
    async (taskId: string, jobId = randomUUID()) =>
      withMaintenanceLock(`task:${taskId}`, async () => {
        const task = engine.getTask(taskId);
        if (!task || !task.provenance || task.provenance === "kocpy-transfer")
          throw new Error("接管记录不存在");
        const totalFiles = task.fileRecords.reduce(
            (sum, record) => sum + Math.max(1, record.destinations.length),
            0,
          ),
          totalBytes = task.fileRecords.reduce(
            (sum, record) =>
              sum + record.size * Math.max(1, record.destinations.length),
            0,
          ),
          startedAt = Date.now();
        let completedFiles = 0,
          completedBytes = 0,
          lastEmittedAt = 0;
        const emit = (
          phase: "hashing" | "completed" | "failed",
          message: string,
          currentFile?: string,
          force = false,
        ) => {
          const now = Date.now();
          if (!force && now - lastEmittedAt < 120) return;
          lastEmittedAt = now;
          const speedBps =
              completedBytes / Math.max(0.001, (now - startedAt) / 1000),
            eta = speedBps
              ? Math.max(0, totalBytes - completedBytes) / speedBps
              : 0;
          if (main && !main.isDestroyed())
            emitExistingProgress({
              jobId,
              phase,
              message,
              totalFiles,
              completedFiles,
              totalBytes,
              completedBytes,
              totalCandidates: 1,
              completedCandidates: phase === "completed" ? 1 : 0,
              currentCandidate: task.name,
              currentFile,
              speedBps,
              eta,
            });
        };
        emit("hashing", "正在读取现存副本并建立首次哈希基线", undefined, true);
        try {
          for (const record of task.fileRecords) {
            const copies = record.destinations.length
              ? record.destinations
              : [
                  {
                    path: path.join(task.sourcePath, record.relativePath),
                    checksum: "",
                    verified: false,
                  },
                ];
            let baseline = "";
            for (const copy of copies) {
              const checksum = await hashFile(
                copy.path,
                task.hashAlgorithm,
                undefined,
                (count) => {
                  completedBytes += count;
                  emit(
                    "hashing",
                    "正在读取现存副本并计算哈希",
                    record.relativePath,
                  );
                },
              );
              baseline ||= checksum;
              copy.checksum = checksum;
              copy.verified = checksum === baseline;
              completedFiles++;
              emit("hashing", "现存副本读取完成", record.relativePath, true);
            }
            record.srcChecksum = baseline;
          }
          for (const destination of task.destinations) {
            const root = destination.resolvedPath || destination.path;
            const copies = task.fileRecords.flatMap((record) =>
              record.destinations.filter((copy) => inside(copy.path, root)),
            );
            destination.verified =
              copies.length > 0 && copies.every((copy) => copy.verified);
            destination.verifiedBytes = destination.verified
              ? task.totalBytes
              : copies
                  .filter((copy) => copy.verified)
                  .reduce((sum, copy) => {
                    const record = task.fileRecords.find((item) =>
                      item.destinations.includes(copy),
                    );
                    return sum + (record?.size || 0);
                  }, 0);
            destination.verifyProgress = 100;
          }
          if (task.destinations.some((destination) => !destination.verified))
            throw new Error("不同现存副本内容不一致，无法建立统一基线");
          task.provenance = "external-baseline";
          task.confidence = "baseline";
          task.status = "completed";
          task.verifiedBytes = task.totalBytes;
          task.verifyProgress = 100;
          task.lastVerifiedAt = Date.now();
          task.errorMessage = undefined;
          task.verifyLog = [
            ...task.verifyLog,
            "已重新读取全部现存文件并建立首次哈希基线；不代表原始现场接收校验",
          ].slice(-120);
          appendExistingTaskEvent(
            task,
            existingEvent({
              operator: await existingOperator(),
              action: "baseline",
              sourcePath: task.sourcePath,
              digest: createHash("sha256")
                .update(
                  JSON.stringify(
                    task.fileRecords.map((record) => [
                      record.relativePath,
                      record.size,
                      record.srcChecksum,
                    ]),
                  ),
                )
                .digest("hex"),
              summary: `建立首次哈希基线：${task.totalFiles} 个文件`,
              details: {
                files: task.totalFiles,
                bytes: task.totalBytes,
                algorithm: task.hashAlgorithm,
              },
            }),
          );
          await persist(true);
          completedBytes = totalBytes;
          completedFiles = totalFiles;
          emit("completed", "首次哈希基线建立完成", undefined, true);
          return task;
        } catch (error) {
          task.status = "failed";
          task.errorMessage = String(error).replace(/^Error: /, "");
          await persist(true);
          emit("failed", task.errorMessage, undefined, true);
          throw error;
        }
      }),
  );
  handle(
    "existing:repair-manifest-missing",
    async (taskId: string, jobId = randomUUID()) =>
      withMaintenanceLock(`task:${taskId}`, async () => {
        const task = engine.getTask(taskId),
          comparison = task?.externalManifest;
        if (!task || !comparison || comparison.status !== "mismatch")
          throw new Error("没有可修复的外部清单差异");
        if (!comparison.missing.length)
          throw new Error("这份素材卷没有缺失文件");
        const chosen = await dialog.showOpenDialog({
          title: "选择同一素材卷的健康副本根目录",
          defaultPath: path.dirname(task.sourcePath),
          properties: ["openDirectory"],
          message:
            "可选择素材卷根目录、对应素材子目录或它们的上级目录；Kocpy 只采用唯一且全量通过清单校验的路径映射",
        });
        if (chosen.canceled) return null;
        const healthyRoot = await canonical(chosen.filePaths[0]),
          targetRoot = await canonical(task.sourcePath),
          manifestDigest = await hashFile(comparison.path, "sha256"),
          operator = await existingOperator();
        if (healthyRoot === targetRoot)
          throw new Error("健康副本不能与待修复目录相同");

        let totalFiles = comparison.missing.length * 2,
          totalBytes = Math.max(1, task.totalBytes * 2);
        const startedAt = Date.now();
        let completedFiles = 0,
          completedBytes = 0,
          lastEmittedAt = 0;
        const emit = (
          phase: "hashing" | "finalizing" | "completed" | "failed",
          message: string,
          currentFile?: string,
          force = false,
        ) => {
          const now = Date.now();
          if (!force && now - lastEmittedAt < 120) return;
          lastEmittedAt = now;
          const speedBps =
              completedBytes / Math.max(0.001, (now - startedAt) / 1000),
            eta = speedBps
              ? Math.max(0, totalBytes - completedBytes) / speedBps
              : 0;
          if (main && !main.isDestroyed())
            emitExistingProgress({
              jobId,
              phase,
              message,
              totalFiles,
              completedFiles,
              totalBytes,
              completedBytes,
              totalCandidates: 1,
              completedCandidates: phase === "completed" ? 1 : 0,
              currentCandidate: task.name,
              currentFile,
              speedBps,
              eta,
            });
        };
        emit(
          "hashing",
          "正在预检健康副本，写入前逐文件核对清单",
          undefined,
          true,
        );
        try {
          const result = await repairMissingManifestFiles(
            targetRoot,
            healthyRoot,
            comparison.path,
            comparison.missing,
            {
              onPlan: (files, bytes, mapping) => {
                totalFiles = Math.max(1, files * 2);
                totalBytes = Math.max(1, bytes * 2);
                emit(
                  "hashing",
                  `已识别唯一映射：${mapping.sourceRoot} → ${mapping.manifestRoot || "."}；找到 ${files} 个文件，开始逐文件校验`,
                  undefined,
                  true,
                );
              },
              onBytes: (count, file) => {
                completedBytes += count;
                emit("hashing", "正在校验并安全补回缺失文件", file);
              },
              onFile: (file) => {
                completedFiles++;
                emit("finalizing", "文件阶段完成", file, true);
              },
            },
          );
          task.verifyLog = [
            ...task.verifyLog,
            `已从健康副本映射 ${result.sourceRoot} → ${result.manifestRoot} 补回 ${result.files} 个文件（${result.bytes} 字节）；随后必须完整重校验外部清单`,
          ].slice(-120);
          appendExistingTaskEvent(
            task,
            existingEvent({
              operator,
              action: "manifest-repair",
              sourcePath: task.sourcePath,
              manifestPath: comparison.path,
              digest: manifestDigest,
              summary: `从健康副本补回 ${result.files} 个文件，等待完整重校验`,
              details: {
                files: result.files,
                bytes: result.bytes,
                healthySourceRoot: result.sourceRoot,
                manifestRoot: result.manifestRoot,
              },
            }),
          );
          await persist(true);
          emit(
            "completed",
            `已补回 ${result.files} 个文件，准备完整重校验`,
            undefined,
            true,
          );
          return result;
        } catch (error) {
          emit(
            "failed",
            String(error).replace(/^Error: /, ""),
            undefined,
            true,
          );
          throw error;
        }
      }),
  );
  handle(
    "existing:reverify-manifest",
    async (taskId: string, jobId = randomUUID()) =>
      withMaintenanceLock(`task:${taskId}`, async () => {
        const task = engine.getTask(taskId);
        if (!task?.projectId || !task.externalManifest)
          throw new Error("接管素材卷或外部清单不存在");
        const projects = (await readProjects()).map(normalizeProject),
          project = projects.find((item) => item.id === task.projectId);
        if (!project) throw new Error("项目不存在");
        const manifestDigest = await hashFile(
            task.externalManifest.path,
            "sha256",
          ),
          operator = await existingOperator(),
          preview = await previewExistingBackup(
            task.sourcePath,
            project,
            "card",
            task.shootingDate,
          ),
          totalFiles = Math.max(1, preview.files),
          totalBytes = Math.max(1, preview.bytes),
          startedAt = Date.now();
        let completedFiles = 0,
          completedBytes = 0,
          lastEmittedAt = 0;
        const emit = (
          phase: "hashing" | "completed" | "failed",
          message: string,
          currentFile?: string,
          force = false,
        ) => {
          const now = Date.now();
          if (!force && now - lastEmittedAt < 120) return;
          lastEmittedAt = now;
          const speedBps =
              completedBytes / Math.max(0.001, (now - startedAt) / 1000),
            eta = speedBps
              ? Math.max(0, totalBytes - completedBytes) / speedBps
              : 0;
          if (main && !main.isDestroyed())
            emitExistingProgress({
              jobId,
              phase,
              message,
              totalFiles,
              completedFiles,
              totalBytes,
              completedBytes,
              totalCandidates: 1,
              completedCandidates: phase === "completed" ? 1 : 0,
              currentCandidate: task.name,
              currentFile,
              speedBps,
              eta,
            });
        };
        emit("hashing", "正在按外部清单完整重读并校验", undefined, true);
        const previousComparison = task.externalManifest;
        try {
          const verified = await importExistingBackup(
            project,
            task.sourcePath,
            "manifest-import",
            {
              shootingDate: task.shootingDate,
              device: task.devices[0],
              cameraPosition: task.cameraPosition,
              card: task.name,
            },
            {
              onBytes: (count, file) => {
                completedBytes += count;
                emit("hashing", "正在计算文件校验值", file);
              },
              onFile: (file) => {
                completedFiles++;
                emit("hashing", "文件校验完成", file, true);
              },
            },
          );
          if (
            verified.externalManifest &&
            previousComparison.resolution?.type === "revised-missing"
          )
            verified.externalManifest.resolution =
              previousComparison.resolution;
          if (verified.status !== "completed") {
            if (
              verified.externalManifest &&
              previousComparison.resolution &&
              sameManifestDifferences(
                previousComparison,
                verified.externalManifest,
              )
            )
              verified.externalManifest.resolution =
                previousComparison.resolution;
            const originalDestination = task.destinations[0],
              verifiedDestination = verified.destinations[0];
            verified.destinations[0] = {
              ...originalDestination,
              ...verifiedDestination,
              id: originalDestination?.id || verifiedDestination.id,
              volumeId: originalDestination?.volumeId,
              volumeUuid: originalDestination?.volumeUuid,
              volumeName: originalDestination?.volumeName,
            };
            const originalId = task.id,
              originalCreatedAt = task.createdAt,
              logicalVolumeId = task.logicalVolumeId || task.id,
              projectRuleSnapshotId =
                task.projectRuleSnapshotId || verified.projectRuleSnapshotId,
              operationAttempts = [
                ...(task.operationAttempts || []),
                {
                  id: verified.operationAttemptId || randomUUID(),
                  startedAt,
                  reason: "recovery" as const,
                  status: verified.status,
                  completedAt: Date.now(),
                },
              ],
              log = task.verifyLog,
              existingAuditTrail = task.existingAuditTrail,
              sourceVolumeId = task.sourceVolumeId,
              sourceVolumeUuid = task.sourceVolumeUuid,
              sourceVolumeName = task.sourceVolumeName;
            Object.assign(task, verified, {
              id: originalId,
              createdAt: originalCreatedAt,
              logicalVolumeId,
              projectRuleSnapshotId,
              operationAttemptId: operationAttempts.at(-1)!.id,
              operationAttempts,
              verifyLog: [...log, ...verified.verifyLog].slice(-120),
              existingAuditTrail,
              sourceVolumeId,
              sourceVolumeUuid,
              sourceVolumeName,
            });
            appendExistingTaskEvent(
              task,
              existingEvent({
                operator,
                action: "manifest-reverify",
                sourcePath: task.sourcePath,
                manifestPath: task.externalManifest?.path,
                digest: manifestDigest,
                summary: `外部清单完整重校验后仍有差异：${task.errorMessage || "需要处理"}`,
                details: { status: task.status },
              }),
            );
            await persist(true);
            completedBytes = totalBytes;
            completedFiles = totalFiles;
            emit(
              "completed",
              verified.errorMessage
                ? `完整核对完成，${verified.errorMessage}`
                : "完整核对完成，外部清单仍有差异",
              undefined,
              true,
            );
            return task;
          }
          const originalDestination = task.destinations[0],
            verifiedDestination = verified.destinations[0];
          verified.destinations[0] = {
            ...originalDestination,
            ...verifiedDestination,
            id: originalDestination?.id || verifiedDestination.id,
            volumeId: originalDestination?.volumeId,
            volumeUuid: originalDestination?.volumeUuid,
            volumeName: originalDestination?.volumeName,
          };
          const originalId = task.id,
            originalCreatedAt = task.createdAt,
            logicalVolumeId = task.logicalVolumeId || task.id,
            projectRuleSnapshotId =
              task.projectRuleSnapshotId || verified.projectRuleSnapshotId,
            operationAttempts = [
              ...(task.operationAttempts || []),
              {
                id: verified.operationAttemptId || randomUUID(),
                startedAt,
                reason: "recovery" as const,
                status: verified.status,
                completedAt: Date.now(),
              },
            ],
            log = task.verifyLog,
            existingAuditTrail = task.existingAuditTrail,
            sourceVolumeId = task.sourceVolumeId,
            sourceVolumeUuid = task.sourceVolumeUuid,
            sourceVolumeName = task.sourceVolumeName;
          Object.assign(task, verified, {
            id: originalId,
            createdAt: originalCreatedAt,
            logicalVolumeId,
            projectRuleSnapshotId,
            operationAttemptId: operationAttempts.at(-1)!.id,
            operationAttempts,
            verifyLog: [...log, ...verified.verifyLog].slice(-120),
            existingAuditTrail,
            sourceVolumeId,
            sourceVolumeUuid,
            sourceVolumeName,
          });
          appendExistingTaskEvent(
            task,
            existingEvent({
              operator,
              action: "manifest-reverify",
              sourcePath: task.sourcePath,
              manifestPath: task.externalManifest?.path,
              digest: manifestDigest,
              summary: "外部清单完整重校验通过",
              details: { status: task.status, files: task.totalFiles },
            }),
          );
          await persist(true);
          completedBytes = totalBytes;
          completedFiles = totalFiles;
          emit("completed", "外部清单完整校验通过", undefined, true);
          return task;
        } catch (error) {
          emit(
            "failed",
            String(error).replace(/^Error: /, ""),
            undefined,
            true,
          );
          throw error;
        }
      }),
  );
  handle("existing:accept-manifest-extra", async (taskId: string) =>
    withMaintenanceLock(`task:${taskId}`, async () => {
      const task = engine.getTask(taskId),
        comparison = task?.externalManifest;
      if (!task || !comparison || comparison.status !== "mismatch")
        throw new Error("没有可确认的外部清单差异");
      if (manifestRequirementMet(task)) throw new Error("这项差异已经确认");
      if (
        !comparison.extra.length ||
        comparison.missing.length ||
        comparison.sizeMismatches.length ||
        comparison.checksumMismatches.length
      )
        throw new Error("只有单纯的额外文件可以按当前基线确认");
      if (
        task.status !== "completed" ||
        task.confidence !== "baseline" ||
        !task.fileRecords.length ||
        task.fileRecords.some(
          (record) =>
            !record.srcChecksum ||
            !record.destinations.length ||
            record.destinations.some((destination) => !destination.verified),
        )
      )
        throw new Error("请先完整读取现存文件并建立可信哈希基线");
      const manifestDigest = await hashFile(comparison.path, "sha256"),
        operator = await existingOperator();
      comparison.resolution = {
        type: "accepted-extra",
        resolvedAt: Date.now(),
        note: "用户确认额外文件属于有效素材；保留外部清单差异，并以 Kocpy 首次哈希基线作为当前可信状态",
      };
      task.verifyLog = [...task.verifyLog, comparison.resolution.note].slice(
        -120,
      );
      task.errorMessage = undefined;
      appendExistingTaskEvent(
        task,
        existingEvent({
          operator,
          action: "manifest-accept-extra",
          sourcePath: task.sourcePath,
          manifestPath: comparison.path,
          digest: manifestDigest,
          summary: `确认保留 ${comparison.extra.length} 个额外文件；原清单差异保留`,
          details: { extra: [...comparison.extra] },
        }),
      );
      await persist(true);
      return task;
    }),
  );
  handle(
    "existing:revise-manifest-missing",
    async (taskId: string, note: string, confirmation: string) =>
      withMaintenanceLock(`task:${taskId}`, async () => {
        const task = engine.getTask(taskId),
          comparison = task?.externalManifest;
        if (!task || !comparison || comparison.status !== "mismatch")
          throw new Error("没有可修订的外部清单差异");
        if (
          !comparison.missing.length ||
          comparison.extra.length ||
          comparison.sizeMismatches.length ||
          comparison.checksumMismatches.length
        )
          throw new Error("只有单纯缺失、没有其他清单异常时才允许修订 MHL");
        if (confirmation.trim() !== "修改 MHL")
          throw new Error("请输入“修改 MHL”完成重要确认");
        note = note.trim();
        if (note.length < 2 || note.length > 500)
          throw new Error("请填写 2–500 个字符的素材剔除原因");
        const targetRoot = await canonical(task.sourcePath),
          manifestPath = await canonical(comparison.path);
        if (!inside(manifestPath, targetRoot))
          throw new Error("外部 MHL 不在当前素材卷目录内，拒绝修改");
        const result = await reviseMhlMissingEntries(
            manifestPath,
            comparison.missing,
            path.join(targetRoot, ".kocpy-manifest-history"),
          ),
          revised = await inspectExternalManifest(targetRoot);
        if (
          !revised ||
          revised.status === "mismatch" ||
          revised.status === "unsupported"
        )
          throw new Error(
            "MHL 已保存审计副本，但修订结果仍有差异，请重新完整核对",
          );
        revised.resolution = {
          type: "revised-missing",
          resolvedAt: Date.now(),
          note,
          excluded: result.excluded,
          originalManifestSha256: result.originalManifestSha256,
          revisedManifestSha256: result.revisedManifestSha256,
          auditPath: result.auditPath,
        };
        task.externalManifest = revised;
        task.errorMessage = "MHL 已按用户确认修订，等待完整重校验";
        task.verifyLog = [
          ...task.verifyLog,
          `用户经重要确认从 MHL 排除 ${result.excluded.length} 个缺失记录；原因：${note}；原始清单 SHA-256 ${result.originalManifestSha256}；审计副本 ${result.auditPath}`,
        ].slice(-120);
        appendExistingTaskEvent(
          task,
          existingEvent({
            operator: await existingOperator(),
            action: "manifest-revise",
            sourcePath: task.sourcePath,
            manifestPath,
            digest: result.revisedManifestSha256,
            summary: `经重要确认从 MHL 排除 ${result.excluded.length} 个记录`,
            details: {
              excluded: result.excluded,
              reason: note,
              originalManifestSha256: result.originalManifestSha256,
              revisedManifestSha256: result.revisedManifestSha256,
              auditPath: result.auditPath,
            },
          }),
        );
        await persist(true);
        return result;
      }),
  );
  handle(
    "existing:reveal-manifest-item",
    async (taskId: string, relativePath?: string) => {
      const task = engine.getTask(taskId);
      if (!task) throw new Error("素材卷记录不存在");
      const itemPath = relativePath
        ? await safeChild(task.sourcePath, relativePath)
        : task.sourcePath;
      if (
        await fs.access(itemPath).then(
          () => true,
          () => false,
        )
      )
        shell.showItemInFolder(itemPath);
      else shell.showItemInFolder(path.dirname(itemPath));
      return true;
    },
  );
  handle("existing:reveal-manifest-audit", async (taskId: string) => {
    const task = engine.getTask(taskId),
      resolution = task?.externalManifest?.resolution;
    if (!task || resolution?.type !== "revised-missing")
      throw new Error("这份素材卷没有 MHL 修订审计记录");
    await fs.access(resolution.auditPath);
    shell.showItemInFolder(resolution.auditPath);
    return true;
  });
  handle("library:relink", async (taskId: string, relativePath: string) => {
    const task = engine.getTask(taskId),
      record = task?.fileRecords.find(
        (item) => item.relativePath === relativePath,
      );
    if (!task || !record) throw new Error("素材记录不存在");
    const chosen = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (chosen.canceled) return null;
    const taskBefore = structuredClone(task),
      root = await canonical(chosen.filePaths[0]),
      availability = await Promise.all(
        task.destinations.map((item) =>
          fs.access(item.resolvedPath || item.path).then(
            () => true,
            () => false,
          ),
        ),
      ),
      unavailableIndex = availability.findIndex((value) => !value),
      associatingCopy = unavailableIndex < 0,
      targetIndex = associatingCopy
        ? task.destinations.length
        : unavailableIndex,
      destination = associatingCopy
        ? undefined
        : task.destinations[targetIndex],
      previousRoot = destination
        ? destination.resolvedPath || destination.path
        : "",
      previousSourcePath = task.sourcePath;
    if (
      task.destinations.some(
        (item, index) =>
          index !== targetIndex &&
          existingSourceKey(item.resolvedPath || item.path) ===
            existingSourceKey(root),
      )
    )
      throw new Error("所选目录已经是这份素材卷的已记录副本");
    let matched = "";
    for (const suffix of [relativePath, path.basename(relativePath)]) {
      const candidate = await safeChild(root, suffix);
      if (
        await fs.access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        matched = candidate;
        break;
      }
    }
    if (!matched) throw new Error("所选目录中没有找到对应素材文件");
    for (const item of task.fileRecords) {
      const candidate = await safeChild(root, item.relativePath);
      if (
        !(await fs.access(candidate).then(
          () => true,
          () => false,
        ))
      )
        throw new Error(`新位置缺少 ${item.relativePath}`);
      if ((await hashFile(candidate, task.hashAlgorithm)) !== item.srcChecksum)
        throw new Error(`${item.relativePath} 的哈希与原记录不一致`);
    }
    const confirmationOptions: MessageBoxOptions = {
      type: associatingCopy ? "question" : "warning",
      title: associatingCopy ? "确认关联健康副本" : "确认更新副本位置",
      message: associatingCopy
        ? "已完整核对全部文件，是否关联为同一逻辑素材卷的另一份健康副本？"
        : "已完整核对全部文件，是否更新这份离线副本的位置？",
      detail: associatingCopy
        ? `新位置：${root}\n文件：${task.totalFiles} 个\n确认后会再次完整读取哈希；若位于同一物理磁盘，仍只计一份独立副本。`
        : `旧位置：${previousRoot}\n新位置：${root}\n文件：${task.totalFiles} 个\n确认后会再次完整读取哈希，并保留旧路径审计。`,
      buttons: ["取消", associatingCopy ? "确认关联" : "确认更新位置"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const confirmation = await (main && !main.isDestroyed()
      ? dialog.showMessageBox(main, confirmationOptions)
      : dialog.showMessageBox(confirmationOptions));
    if (confirmation.response !== 1) return null;
    // The first pass is the user-visible preview. Repeat full hashes after the
    // confirmation so a file changed while the dialog was open cannot be
    // associated or relinked on stale evidence.
    for (const item of task.fileRecords) {
      const candidate = await safeChild(root, item.relativePath);
      if ((await hashFile(candidate, task.hashAlgorithm)) !== item.srcChecksum)
        throw new Error(
          `${item.relativePath} 在确认期间发生变化，未更新任何位置记录`,
        );
    }
    const existingCopies = associatingCopy
      ? []
      : task.fileRecords.map((item) =>
          item.destinations.find((entry) => inside(entry.path, previousRoot)),
        );
    if (!associatingCopy && existingCopies.some((copy) => !copy))
      throw new Error("原副本文件映射不完整，未更新任何位置记录");
    const identity = await volumeIdentity(root),
      operator = await existingOperator();
    for (const [index, item] of task.fileRecords.entries()) {
      const nextPath = await safeChild(root, item.relativePath);
      if (associatingCopy)
        item.destinations.push({
          path: nextPath,
          checksum: item.srcChecksum,
          verified: true,
        });
      else {
        const copy = existingCopies[index]!;
        copy.path = nextPath;
        copy.checksum = item.srcChecksum;
        copy.verified = true;
      }
    }
    const destinationValue = {
      id: destination?.id || randomUUID(),
      path: root,
      resolvedPath: root,
      label: path.basename(root),
      volumeId: identity.id,
      volumeUuid: identity.uuid,
      volumeName: identity.name,
      verified: true,
      available: true,
      bytesWritten: destination?.bytesWritten || 0,
      verifiedBytes: task.totalBytes,
      copyProgress: 100,
      verifyProgress: 100,
      error: undefined,
    };
    if (associatingCopy) task.destinations.push(destinationValue);
    else Object.assign(destination!, destinationValue);
    if (
      !associatingCopy &&
      existingSourceKey(previousSourcePath) === existingSourceKey(previousRoot)
    )
      task.sourcePath = root;
    const event = existingEvent({
      operator,
      action: associatingCopy ? "associate-copy" : "relink",
      sourcePath: root,
      previousPath: associatingCopy ? undefined : previousRoot,
      digest: createHash("sha256")
        .update(
          JSON.stringify(
            task.fileRecords.map((item) => [
              item.relativePath,
              item.size,
              item.srcChecksum,
            ]),
          ),
        )
        .digest("hex"),
      summary: associatingCopy
        ? `完整校验后关联另一份健康副本：${root}`
        : `完整校验后将副本位置由 ${previousRoot} 更新为 ${root}`,
      details: {
        files: task.totalFiles,
        volumeUuid: identity.uuid || "unknown",
        physicalCopyCountConservative: verifiedPhysicalCopyCount(task),
      },
    });
    appendExistingTaskEvent(task, event);
    const projects = (await readProjects()).map(normalizeProject),
      project = task.projectId
        ? projects.find((item) => item.id === task.projectId)
        : undefined;
    if (project) {
      project.boundRoots = deduplicateBoundRoots([
        ...(project.boundRoots || []).filter(
          (item) =>
            associatingCopy ||
            existingSourceKey(item.path) !== existingSourceKey(previousRoot),
        ),
        {
          id: randomUUID(),
          path: root,
          boundAt: Date.now(),
          provenance:
            task.provenance === "manifest-import" ||
            task.provenance === "external-baseline"
              ? task.provenance
              : "unverified-import",
        },
      ]);
      appendProjectTakeoverEvent(project, event);
    }
    try {
      await commitWorkspace({
        tasks: engine.getAllTasks().slice().reverse(),
        projects,
        syncCatalog: true,
      });
    } catch (error) {
      engine.loadTask(taskBefore);
      throw error;
    }
    return matched;
  });
  handle("system:open-path", async (file: string) => {
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });
  handle("projects:coverage", (projectId: string) =>
    readProjects().then((projects) => {
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      return projectCoverage(project, engine.getAllTasks());
    }),
  );
  handle("projects:sign-checklist", async (projectId: string, run: any) => {
    const projects = (await readProjects()).map(normalizeProject),
      project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    if (!hasProjectRuleEvidence(project))
      Object.assign(project, ensureProjectRuleEvidence(project));

    if (
      !["start", "close"].includes(run.phase) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(run.date || "")
    )
      throw new Error("请确认检查阶段与拍摄日期");
    run.completed = validateChecklist(
      (project.checklists || []).filter((item) => item.phase === run.phase),
      run.completed || [],
      run.operator || "",
    );
    if (run.phase === "close") {
      const related = engine
        .getAllTasks()
        .filter((task) => task.projectId === projectId);
      const status = projectCloseoutSummary(project, related, [run.date]);
      if (
        status.pending.length ||
        status.unconfirmed.length ||
        groupLogicalVolumes(
          related.filter(
            (task) =>
              shootingDateKey(task.shootingDate) === shootingDateKey(run.date),
          ),
          project.requiredCopies || 2,
        ).some((volume) => !volume.compliant)
      )
        throw new Error(
          "该拍摄日仍有未达标素材或未确认的设备使用状态，请在项目详情处理后再签署收工。",
        );
    }
    run.id = run.id || randomUUID();
    run.signedAt = Date.now();
    run.ruleSnapshotId = project.activeRuleSnapshotId;
    project.checklistRuns = [
      ...(project.checklistRuns || []).filter((item) => item.id !== run.id),
      run,
    ].slice(-1000);
    await writeProjects(projects);
    return project;
  });
  handle("nas:list", () => nasPresets);
  handle("nas:save", async (value: NasPreset) => {
    if (!path.isAbsolute(value.path))
      throw new Error("NAS 必须是已挂载的绝对路径");
    const preset = {
      ...value,
      id: value.id || randomUUID(),
      createdAt: value.createdAt || Date.now(),
    };
    nasPresets = [
      ...nasPresets.filter((item) => item.id !== preset.id),
      preset,
    ];
    await store.write("nas-presets.json", nasPresets);
    return nasPresets;
  });
  handle("nas:delete", async (id: string) => {
    if (
      !(await confirmOperation(
        "删除 NAS 预设？",
        "仅移除连接路径，不删除 NAS 上任何文件。",
      ))
    )
      return null;
    nasPresets = nasPresets.filter((item) => item.id !== id);
    await store.write("nas-presets.json", nasPresets);
    return nasPresets;
  });
  handle("nas:test", async (id: string) => {
    const candidate = nasPresets.find((item) => item.id === id);
    if (candidate && !(await assertDiagnosticTarget(candidate.path)))
      return null;
    const preset = nasPresets.find((item) => item.id === id);
    if (!preset) throw new Error("NAS 预设不存在");
    const started = Date.now();
    try {
      const identity = await volumeIdentity(preset.path),
        space = await driveInfo(preset.path),
        benchmark = await benchmarkDirectory(preset.path, 16),
        healthy =
          !preset.minimumWriteBps ||
          benchmark.writeBps >= preset.minimumWriteBps;
      Object.assign(preset, {
        online: true,
        lastCheckedAt: Date.now(),
        lastLatencyMs: Date.now() - started,
        lastWriteBps: benchmark.writeBps,
        lastError: healthy ? undefined : "写入速度低于预设下限",
      });
      await store.write("nas-presets.json", nasPresets);
      return { identity, space, benchmark, healthy };
    } catch (error) {
      Object.assign(preset, {
        online: false,
        lastCheckedAt: Date.now(),
        lastLatencyMs: Date.now() - started,
        lastError: String(error),
      });
      await store.write("nas-presets.json", nasPresets);
      throw error;
    }
  });
  handle("templates:from-project", async (projectId: string, name?: string) => {
    const project = (await readProjects()).find(
      (item) => item.id === projectId,
    );
    if (!project) throw new Error("项目不存在");
    const template = templateFromProject(project, name);
    const index = projectTemplates.findIndex((item) => item.id === template.id);
    if (index < 0) projectTemplates.push(template);
    else
      projectTemplates[index] = {
        ...template,
        createdAt: projectTemplates[index].createdAt,
        revision: (projectTemplates[index].revision || 1) + 1,
      };
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:save", async (input: ProjectTemplate) => {
    if (!input || typeof input !== "object") throw new Error("模板数据无效");
    if (!input.name?.trim()) throw new Error("请输入模板名称");
    if (!input.devices?.length) throw new Error("模板至少需要一个设备");
    if (input.devices.length > 10) throw new Error("模板最多保存 10 个设备");
    if (!input.namingRule?.includes("{card}"))
      throw new Error("模板命名规则必须包含 {card}");
    if (input.id?.startsWith("builtin-"))
      throw new Error("系统模板不可直接修改，请先复制为自定义模板");
    const existing = projectTemplates.find((item) => item.id === input.id),
      template = normalizeProjectTemplate({
        ...input,
        id: input.id || `template-${randomUUID()}`,
        kind: "custom",
        createdAt: existing?.createdAt || input.createdAt || Date.now(),
        updatedAt: Date.now(),
        revision: existing ? (existing.revision || 1) + 1 : 1,
      });
    const index = projectTemplates.findIndex((item) => item.id === template.id);
    if (index < 0) projectTemplates.push(template);
    else projectTemplates[index] = template;
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:delete", async (id: string) => {
    if (
      !(await confirmOperation(
        "删除自定义模板？",
        "仅删除模板配置，不改变已建立的项目和素材。",
      ))
    )
      return null;
    if (id.startsWith("builtin-"))
      throw new Error("系统模板不能删除，可以选择隐藏");
    projectTemplates = projectTemplates.filter((item) => item.id !== id);
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:hide", async (id: string, hidden: boolean) => {
    const template = projectTemplates.find((item) => item.id === id);
    if (!template?.id.startsWith("builtin-"))
      throw new Error("只有系统模板可以隐藏或恢复");
    template.hidden = Boolean(hidden);
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:export", async () => {
    const custom = projectTemplates.filter(
      (item) => !item.id.startsWith("builtin-"),
    );
    if (!custom.length) throw new Error("还没有可导出的自定义模板");
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_项目模板_${Date.now()}.json`,
      filters: [{ name: "Kocpy 项目模板", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    await fs.writeFile(
      result.filePath,
      JSON.stringify(
        {
          application: "Kocpy",
          schema: 1,
          exportedAt: Date.now(),
          templates: custom,
        },
        null,
        2,
      ),
      "utf8",
    );
    return result.filePath;
  });
  handle("templates:import", async () => {
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Kocpy 项目模板", extensions: ["json"] }],
    });
    if (chosen.canceled) return null;
    const importPath = chosen.filePaths[0],
      stat = await fs.stat(importPath);
    if (stat.size > 2 * 1024 * 1024)
      throw new Error("模板文件超过 2 MiB 安全限制");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(importPath, "utf8"));
    } catch {
      throw new Error("模板文件不是有效 JSON");
    }
    const raw = Array.isArray(parsed)
      ? parsed
      : (parsed as { templates?: unknown })?.templates;
    if (!Array.isArray(raw) || !raw.length || raw.length > 100)
      throw new Error("模板文件必须包含 1–100 个模板");
    const imported = raw.map((value, index) => {
      if (!value || typeof value !== "object")
        throw new Error(`第 ${index + 1} 个模板数据无效`);
      const candidate = value as ProjectTemplate;
      if (!candidate.name?.trim() || !candidate.devices?.length)
        throw new Error(`第 ${index + 1} 个模板缺少名称或设备`);
      if (candidate.devices.length > 10)
        throw new Error(`第 ${index + 1} 个模板超过 10 个设备`);
      if (!candidate.namingRule?.includes("{card}"))
        throw new Error(`第 ${index + 1} 个模板命名规则缺少 {card}`);
      return normalizeProjectTemplate({
        ...candidate,
        id: `template-${randomUUID()}`,
        kind: "custom",
        hidden: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    projectTemplates = [...projectTemplates, ...imported];
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle(
    "templates:preview-apply",
    async (templateId: string, projectId: string) => {
      const template = projectTemplates.find((item) => item.id === templateId),
        project = (await readProjects()).find((item) => item.id === projectId);
      if (!template) throw new Error("模板不存在");
      if (!project) throw new Error("项目不存在");
      const actionLabels: Record<string, string> = {
        report: "报告",
        delivery: "交付清单",
        proxy: "代理",
        eject: "安全推出",
      };
      return {
        templateId,
        projectId,
        changes: [
          {
            field: "devices",
            label: "设备、素材卷前缀与机位",
            before: project.devices
              .map(
                (device) =>
                  `${device} · 前缀 ${project.volumePrefixByDevice?.[device] || project.volumePrefix} · 机位 ${(project.devicePositions?.[device] || []).join(",") || "无"}`,
              )
              .join(" / "),
            after: template.devices
              .map(
                (device) =>
                  `${device} · 前缀 ${template.volumePrefixByDevice?.[device] || template.volumePrefix} · 机位 ${(template.devicePositions?.[device] || []).join(",") || "无"}`,
              )
              .join(" / "),
          },
          {
            field: "requiredCopies",
            label: "物理独立副本",
            before: `${project.requiredCopies || 2} 份`,
            after: `${template.requiredCopies} 份`,
          },
          {
            field: "namingRule",
            label: "目录命名规则",
            before: project.namingRule || "默认规则",
            after: template.namingRule,
          },
          {
            field: "completionActions",
            label: "完成动作",
            before: (project.completionActions || ["report"])
              .map((item) => actionLabels[item])
              .join(" / "),
            after: template.completionActions
              .map((item) => actionLabels[item])
              .join(" / "),
          },
          {
            field: "checklists",
            label: "开工与收工检查表",
            before: `${project.checklists?.length || 0} 项`,
            after: `${template.checklists?.length || 0} 项`,
          },
          {
            field: "crew",
            label: "制作人员与角色",
            before: `${project.crew?.length || 0} 人`,
            after: `${template.crew?.length || 0} 人`,
          },
          {
            field: "projectDefaults",
            label: "制作类型与预计素材卷",
            before: `${project.productionType || "custom"} / ${project.expectedVolumes || "未知"}`,
            after: `${template.productionType || "custom"} / ${template.expectedVolumes || "未知"}`,
          },
        ],
      };
    },
  );
  handle(
    "templates:apply",
    async (
      templateId: string,
      projectId: string,
      selectedFields?: string[],
      operator?: string,
    ) => {
      const template = projectTemplates.find((item) => item.id === templateId);
      if (!template) throw new Error("模板不存在");
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      const beforeProject = structuredClone(project);
      const allowedFields = [
        "devices",
        "requiredCopies",
        "namingRule",
        "completionActions",
        "checklists",
        "crew",
        "projectDefaults",
      ];
      if (selectedFields && !selectedFields.length)
        throw new Error("请至少选择一项要应用的模板配置");
      if (!operator?.trim()) throw new Error("请填写模板应用操作人");
      if (selectedFields?.some((field) => !allowedFields.includes(field)))
        throw new Error("模板包含不受支持的应用字段");
      const fields = new Set(selectedFields || allowedFields);
      if (
        fields.has("requiredCopies") &&
        (project.destinationPaths?.length || 0) < template.requiredCopies
      )
        throw new Error(
          `模板要求 ${template.requiredCopies} 份副本，当前项目目的地不足`,
        );
      if (fields.has("devices"))
        Object.assign(project, {
          devices: [...template.devices],
          volumePrefix: template.volumePrefix,
          volumePrefixByDevice: { ...(template.volumePrefixByDevice || {}) },
          devicePositions: Object.fromEntries(
            Object.entries(template.devicePositions || {}).map(
              ([device, positions]) => [device, [...positions]],
            ),
          ),
        });
      if (fields.has("requiredCopies"))
        project.requiredCopies = template.requiredCopies;
      if (fields.has("namingRule")) project.namingRule = template.namingRule;
      if (fields.has("completionActions"))
        project.completionActions = [...template.completionActions];
      if (fields.has("checklists"))
        project.checklists = template.checklists?.map((item) => ({ ...item }));
      if (fields.has("crew"))
        project.crew = template.crew?.map((item) => ({ ...item }));
      if (fields.has("projectDefaults")) {
        project.productionType = template.productionType || "custom";
        project.expectedVolumes = template.expectedVolumes;
      }
      const snapshotted = appendProjectRuleSnapshot(beforeProject, project, {
        reason: "template-applied",
        operator: operator.trim(),
      });
      const selected = [...fields];
      const labels: Record<string, string> = {
        devices: "设备、素材卷前缀与机位",
        requiredCopies: "物理独立副本",
        namingRule: "目录命名规则",
        completionActions: "完成动作",
        checklists: "开工与收工检查表",
        crew: "制作人员与角色",
        projectDefaults: "制作类型与预计素材卷",
      };
      const evidenceValue = (value: ProjectConfig, field: string) => {
        if (field === "devices")
          return {
            devices: value.devices,
            volumePrefix: value.volumePrefix,
            volumePrefixByDevice: value.volumePrefixByDevice,
            devicePositions: value.devicePositions,
          };
        if (field === "projectDefaults")
          return {
            productionType: value.productionType,
            expectedVolumes: value.expectedVolumes,
          };
        return (value as unknown as Record<string, unknown>)[field] ?? null;
      };
      const changes = selected.map((field) => ({
        field,
        label: labels[field] || field,
        before: JSON.stringify(evidenceValue(beforeProject, field)),
        after: JSON.stringify(evidenceValue(snapshotted, field)),
      }));
      const evidenced = appendTemplateApplicationEvidence(
        snapshotted,
        template,
        selected,
        changes,
        snapshotted.activeRuleSnapshotId!,
        operator.trim(),
      );
      Object.assign(project, evidenced);
      await writeProjects(projects);
      return projects;
    },
  );
  handle(
    "projects:daily-plan",
    async (
      projectId: string,
      input: Parameters<typeof recordDailyPlanDecision>[1],
    ) => {
      const projects = (await readProjects()).map(normalizeProject),
        index = projects.findIndex((item) => item.id === projectId);
      if (index < 0) throw new Error("项目不存在");
      const planDate = shootingDateKey(input.date),
        related = engine
          .getAllTasks()
          .filter((task) => task.projectId === projectId);
      if (!projectDates(projects[index], related).includes(planDate))
        throw new Error("每日计划日期不在当前项目拍摄周期内");
      projects[index] = recordDailyPlanDecision(
        ensureProjectRuleEvidence(projects[index]),
        input,
      );
      await writeProjects(projects);
      return projects;
    },
  );
  handle(
    "projects:add-handoff",
    async (
      projectId: string,
      operator: string,
      note: string,
      options?: {
        scope?: "day" | "project";
        shootingDate?: string;
        exceptions?: string[];
      },
    ) => {
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      if (!hasProjectRuleEvidence(project)) {
        Object.assign(project, ensureProjectRuleEvidence(project));
      }
      if (!note.trim()) throw new Error("请输入交接内容");
      if (!operator.trim()) throw new Error("请填写实际交接人姓名");
      const related = engine
        .getAllTasks()
        .filter((task) => task.projectId === projectId);
      Object.assign(
        project,
        appendProjectHandoffEvidence(project, related, {
          operator,
          note,
          scope: options?.scope,
          shootingDate: options?.shootingDate,
          exceptions: options?.exceptions,
        }),
      );
      await writeProjects(projects);
      return projects;
    },
  );
  handle("workspace:export", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_工作站配置_${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    const projects = await readProjects();
    const base = {
      schema: 2,
      application: "Kocpy",
      version: app.getVersion(),
      workstation: createHash("sha256")
        .update(os.hostname())
        .digest("hex")
        .slice(0, 12),
      exportedAt: Date.now(),
      projects,
      tasks: engine.getAllTasks(),
      templates: projectTemplates,
      healthRecords,
      archiveChanges,
      archiveReminders,
      archiveRuns,
      archiveEvidence: {
        schemaVersion: currentArchiveEvidence().schemaVersion,
        revision: currentArchiveEvidence().revision,
        digest: currentArchiveEvidence().digest,
      },
    };
    const payload = { ...base, integrity: workspaceIntegrity(base) };
    await fs.writeFile(
      result.filePath,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
    return result.filePath;
  });
  handle("workspace:import", async () => {
    if (engine.hasActive() || proxyBusy)
      throw new Error("请等待当前任务结束后再合并工作站记录");
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Kocpy 工作站配置", extensions: ["json"] }],
    });
    if (chosen.canceled) return null;
    const importPath = chosen.filePaths[0],
      stat = await fs.stat(importPath);
    if (stat.size > 256 * 1024 * 1024)
      throw new Error("工作站配置包超过 256 MiB 安全限制");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(importPath, "utf8"));
    } catch {
      throw new Error("工作站配置包不是有效 JSON");
    }
    const incoming = validateWorkspacePackage(parsed);
    const currentProjects = await readProjects(),
      currentTasks = engine.getAllTasks();
    const backupDir = path.join(app.getPath("userData"), "import-backups");
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(
      path.join(backupDir, `before-import-${Date.now()}.json`),
      JSON.stringify(
        {
          schema: 1,
          version: app.getVersion(),
          createdAt: Date.now(),
          tasks: currentTasks,
          projects: currentProjects,
          projectTemplates,
          healthRecords,
          archiveChanges,
        },
        null,
        2,
      ),
      "utf8",
    );
    const merged = mergeWorkspace(
        { projects: currentProjects, tasks: currentTasks },
        incoming,
      ),
      nextProjectTemplates = [
        ...projectTemplates,
        ...(incoming.templates || []).map(normalizeProjectTemplate),
      ].filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      ),
      nextHealthRecords = [
        ...healthRecords,
        ...((incoming.healthRecords || []) as typeof healthRecords),
      ]
        .filter(
          (item, index, all) =>
            all.findIndex((other) => other.id === item.id) === index,
        ),
      existingChangeIds = new Set(archiveChanges.map((item) => item.id)),
      incomingChanges = (incoming.archiveChanges || [])
        .filter((item) => !existingChangeIds.has(item.id))
        .map(({ previousDigest: _previous, digest: _digest, ...item }) => ({
          ...item,
          operator: item.operator || "外部工作站未记录",
          outcome: item.outcome || ("completed" as const),
        })),
      nextArchiveReminders = [
        ...archiveReminders,
        ...(incoming.archiveReminders || []),
      ].filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      ),
      nextArchiveRuns = [
        ...archiveRuns,
        ...(incoming.archiveRuns || []),
      ].filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      ),
      nextArchiveEvidence = updateArchiveEvidence(currentArchiveEvidence(), {
        healthRecords: nextHealthRecords,
        changes: incomingChanges,
        reminders: nextArchiveReminders,
        runs: nextArchiveRuns,
      });
    try {
      await store.write("project-templates.json", nextProjectTemplates);
      await commitArchiveEvidence(
        nextArchiveEvidence,
        merged.tasks,
        merged.projects,
      );
    } catch (error) {
      await store
        .write("project-templates.json", projectTemplates)
        .catch(() => undefined);
      throw error;
    }
    projectTemplates = nextProjectTemplates;
    for (const task of merged.tasks)
      if (!engine.getTask(task.id)) engine.loadTask(task);
    return merged.result;
  });
  handle("workspace:backup-data", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_本地数据备份_${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    await fs.writeFile(
      result.filePath,
      JSON.stringify(
        {
          schema: 2,
          version: app.getVersion(),
          createdAt: Date.now(),
          tasks: engine.getAllTasks(),
          projects: await readProjects(),
          workspace: {
            schemaVersion: workspace.snapshot.schemaVersion,
            revision: workspace.snapshot.revision,
            committedAt: workspace.snapshot.committedAt,
            digest: workspace.snapshot.digest,
            taskTombstones: workspace.snapshot.taskTombstones,
            projectTombstones: workspace.snapshot.projectTombstones,
          },
          settings: await store.read("settings.json", defaultSettings),
          proxyJobs,
          projectTemplates,
          healthRecords,
          benchmarkHistory,
          archiveChanges,
          archiveReminders,
          archiveRuns,
          archiveEvidence: {
            schemaVersion: currentArchiveEvidence().schemaVersion,
            revision: currentArchiveEvidence().revision,
            digest: currentArchiveEvidence().digest,
          },
          nasPresets,
        },
        null,
        2,
      ),
      "utf8",
    );
    return result.filePath;
  });
  handle("workspace:cold-archive", async (projectId: string) => {
    const selected = engine
      .getAllTasks()
      .filter((task) => task.projectId === projectId);
    if (
      !(await confirmOperation(
        "导出并卸载项目历史记录？",
        "范围：" +
          selected.length +
          " 个任务、" +
          selected.reduce((count, task) => count + task.fileRecords.length, 0) +
          " 条文件记录。\n先写入并回读校验归档包，成功后从热数据卸载。磁盘素材不变，请保存归档包以便恢复。",
      ))
    )
      return null;
    if (engine.hasActive() || proxyBusy) throw new Error("请等待当前任务结束");
    const projects = (await readProjects()).map(normalizeProject),
      project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const tasks = engine
        .getAllTasks()
        .filter((item) => item.projectId === projectId),
      chosen = await dialog.showSaveDialog({
        defaultPath: `Kocpy_${segment(project.name)}_冷归档_${Date.now()}.kocpy.gz`,
        filters: [{ name: "Kocpy 冷归档", extensions: ["gz"] }],
      });
    if (!chosen.filePath) return null;
    const base = {
        schema: 3,
        application: "Kocpy",
        kind: "cold-archive",
        version: app.getVersion(),
        createdAt: Date.now(),
        project,
        tasks,
        archiveEvidence: {
          sourceDigest: currentArchiveEvidence().digest,
          healthRecords: healthRecords.filter(
            (item) => item.projectId === projectId,
          ),
          changes: archiveChanges.filter(
            (item) => item.projectId === projectId,
          ),
          reminders: archiveReminders.filter(
            (item) => item.projectId === projectId,
          ),
          runs: archiveRuns.filter((item) => item.projectId === projectId),
        },
      },
      payload = { ...base, integrity: workspaceIntegrity(base) };
    const archiveBytes = await gzipAsync(Buffer.from(JSON.stringify(payload))),
      temporary = `${chosen.filePath}.partial-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, archiveBytes, { flag: "wx" });
      await syncFileAndParent(temporary);
      const check = JSON.parse(
        (await gunzipAsync(await fs.readFile(temporary))).toString("utf8"),
      );
      if (
        check.integrity !== payload.integrity ||
        workspaceIntegrity(
          Object.fromEntries(
            Object.entries(check).filter(([key]) => key !== "integrity"),
          ),
        ) !== check.integrity
      )
        throw new Error("冷归档写入后的完整性复核失败，项目记录未删除");
      await fs.rename(temporary, chosen.filePath);
      await syncFileAndParent(chosen.filePath);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    project.status = "archived";
    project.coldArchivedAt = Date.now();
    project.coldArchiveFile = chosen.filePath;
    for (const task of tasks) engine.deleteTask(task.id);
    try {
      await commitWorkspace({
        tasks: engine.getAllTasks().slice().reverse(),
        projects,
        syncCatalog: true,
      });
    } catch (error) {
      for (const task of tasks) engine.loadTask(task);
      throw error;
    }
    return chosen.filePath;
  });
  handle("workspace:restore-cold", async () => {
    if (engine.hasActive() || proxyBusy)
      throw new Error("请等待当前任务结束后再恢复冷归档");
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Kocpy 冷归档", extensions: ["gz"] }],
    });
    if (chosen.canceled) return null;
    const archiveStat = await fs.stat(chosen.filePaths[0]);
    if (archiveStat.size > 512 * 1024 * 1024)
      throw new Error("冷归档超过 512 MiB 安全限制");
    const parsed = JSON.parse(
      (
        await gunzipAsync(await fs.readFile(chosen.filePaths[0]), {
          maxOutputLength: 1024 * 1024 * 1024,
        } as any)
      ).toString("utf8"),
    );
    if (
      parsed.application !== "Kocpy" ||
      parsed.kind !== "cold-archive" ||
      !parsed.project ||
      !Array.isArray(parsed.tasks)
    )
      throw new Error("不是有效的 Kocpy 冷归档");
    const integrity = workspaceIntegrity(
      Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== "integrity"),
      ),
    );
    if (integrity !== parsed.integrity) throw new Error("冷归档完整性校验失败");
    validateWorkspacePackage({
      application: "Kocpy",
      schema: 1,
      projects: [parsed.project],
      tasks: parsed.tasks,
      templates: [],
      healthRecords: [],
      archiveChanges: [],
      archiveReminders: [],
      archiveRuns: [],
    });
    const projects = (await readProjects()).map(normalizeProject),
      project = {
        ...parsed.project,
        status: "active",
        coldArchivedAt: undefined,
        coldArchiveFile: chosen.filePaths[0],
      },
      index = projects.findIndex((item) => item.id === project.id);
    if (index < 0) projects.push(project);
    else projects[index] = project;
    const existingTasks = workspace.getTasks(),
      existingTaskIds = new Set(existingTasks.map((item) => item.id)),
      restoredTasks = (parsed.tasks as BackupTask[]).filter(
        (item) => !existingTaskIds.has(item.id),
      ),
      packageEvidence =
        parsed.archiveEvidence && typeof parsed.archiveEvidence === "object"
          ? parsed.archiveEvidence
          : {},
      validatedPackageEvidence = migrateLegacyArchiveEvidence(
        {
          healthRecords: Array.isArray(packageEvidence.healthRecords)
            ? packageEvidence.healthRecords
            : [],
          changes: Array.isArray(packageEvidence.changes)
            ? packageEvidence.changes
            : [],
          reminders: Array.isArray(packageEvidence.reminders)
            ? packageEvidence.reminders
            : [],
          runs: Array.isArray(packageEvidence.runs)
            ? packageEvidence.runs
            : [],
        },
        Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now(),
      ),
      existingChangeIds = new Set(archiveChanges.map((item) => item.id)),
      restoredChanges = validatedPackageEvidence.changes
        .filter(
          (item: ArchiveChangeRecord) => !existingChangeIds.has(item.id),
        )
        .map((item: ArchiveChangeRecord) => {
          const { previousDigest: _previous, digest: _digest, ...body } = item;
          return body;
        }),
      restoredHealth = [
        ...healthRecords,
        ...validatedPackageEvidence.healthRecords,
      ].filter(
        (item, position, all) =>
          all.findIndex((other) => other.id === item.id) === position,
      ),
      restoredReminders = [
        ...archiveReminders,
        ...validatedPackageEvidence.reminders,
      ].filter(
        (item, position, all) =>
          all.findIndex((other) => other.id === item.id) === position,
      ),
      restoredRuns = [
        ...archiveRuns,
        ...validatedPackageEvidence.runs,
      ].filter(
        (item, position, all) =>
          all.findIndex((other) => other.id === item.id) === position,
      ),
      restoredEvidence = updateArchiveEvidence(currentArchiveEvidence(), {
        healthRecords: restoredHealth,
        changes: restoredChanges,
        reminders: restoredReminders,
        runs: restoredRuns,
      });
    await commitArchiveEvidence(
      restoredEvidence,
      [...existingTasks, ...restoredTasks],
      projects,
    );
    for (const task of restoredTasks) engine.loadTask(task);
    return { project, tasks: parsed.tasks.length };
  });
  handle("lan:start", async () => {
    lanIndex.snapshot = async () => ({
      projects: await readProjects(),
      tasks: engine.getAllTasks(),
    });
    return lanIndex.start();
  });
  handle("lan:stop", () => lanIndex.stop());
  handle("lan:status", () => lanIndex.status());
  handle("lan:read", (address: string, token: string) =>
    readLanProjectIndex(address, token),
  );
  handle("system:reveal", (file: string) => shell.showItemInFolder(file));
  handle("updates:check", async () => {
    const response = await fetch(
      "https://api.github.com/repos/sexyfeifan/Kocpy/releases/latest",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Kocpy/${app.getVersion()}`,
        },
      },
    );
    if (!response.ok)
      throw new Error(`更新检查失败（HTTP ${response.status}）`);
    const release = (await response.json()) as GitHubRelease,
      latest = String(release.tag_name || "").replace(/^v/, ""),
      current = app.getVersion();
    if (!latest || !release.html_url)
      throw new Error("GitHub Release 没有可用版本");
    const asset = selectMacAsset(release, process.arch);
    return {
      current,
      latest,
      available: compareVersions(latest, current) > 0,
      releaseUrl: release.html_url,
      ...asset,
    };
  });
  handle("updates:open", (url: string) => {
    if (
      !/^https:\/\/github\.com\/sexyfeifan\/Kocpy\/releases(?:\/(?:tag|download)\/.*)?$/.test(
        url,
      )
    )
      throw new Error("无效更新地址");
    return shell.openExternal(url);
  });
  handle("system:open-author", (url: string) => {
    const allowed = new Set([
      "https://github.com/sexyfeifan",
      "https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97",
    ]);
    if (!allowed.has(url)) throw new Error("无效作者主页地址");
    return shell.openExternal(url);
  });
  handle("settings:preview-theme", (theme: "dark" | "light") => {
    if (!new Set(["dark", "light"]).has(theme)) throw new Error("无效界面主题");
    nativeTheme.themeSource = theme;
  });
  handle("settings:get", () => store.read("settings.json", defaultSettings));
  handle("settings:save", (settings: typeof defaultSettings) => {
    nativeTheme.themeSource = settings.theme === "light" ? "light" : "dark";
    return store.write("settings.json", settings);
  });
  handle("projects:list", async () =>
    (await readProjects()).map(normalizeProject),
  );
  handle("projects:inspect-structure", async (project: ProjectConfig) =>
    inspectProjectStructure(prepareProject(project)),
  );
  handle(
    "projects:save",
    async (value: ProjectConfig, createMissing = true, operator?: string) => {
      let project = prepareProject(value);
      if (
        (project.destinationPaths?.length || 0) < (project.requiredCopies || 2)
      )
        throw new Error(
          `项目要求 ${project.requiredCopies || 2} 份物理独立副本，请配置至少同等数量的目的地`,
        );
      const all = (await readProjects()).map(normalizeProject),
        idx = all.findIndex((p) => p.id === project.id);
      const previous = idx < 0 ? undefined : all[idx],
        previousRevisions = previous?.ruleSnapshots?.length || 0;
      project = appendProjectRuleSnapshot(previous, project, { operator });
      const addedRevisions =
        (project.ruleSnapshots?.length || 0) - previousRevisions;
      if (
        previous &&
        addedRevisions > (previous.activeRuleSnapshotId ? 0 : 1) &&
        !operator?.trim()
      )
        throw new Error("项目规则发生变化，请填写实际修改人后再保存");
      if (createMissing) await createProjectStructure(project);
      if (idx < 0) all.push(project);
      else all[idx] = project;
      await writeProjects(all);
      return all;
    },
  );
  handle("projects:delete-preview", async (projectId: string) => {
    const projects = (await readProjects()).map(normalizeProject),
      project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在或已经删除");
    return buildProjectDeletionPreview(
      project,
      engine.getAllTasks(),
      proxyJobs,
      healthRecords,
      archiveChanges,
      archiveReminders,
      archiveRuns,
    );
  });
  handle(
    "projects:delete",
    async (projectId: string, confirmationName: string) => {
      const projects = (await readProjects()).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在或已经删除");
      if (confirmationName !== project.name)
        throw new Error("项目名称确认不匹配，未删除任何记录");
      const relatedTasks = engine
        .getAllTasks()
        .filter((task) => task.projectId === projectId);
      const deletionPreview = buildProjectDeletionPreview(
        project,
        engine.getAllTasks(),
        proxyJobs,
        healthRecords,
        archiveChanges,
        archiveReminders,
        archiveRuns,
      );
      if (deletionPreview.blockingTasks)
        throw new Error("项目仍有未结束的任务，不能删除项目记录");
      const taskIds = new Set(relatedTasks.map((task) => task.id)),
        nextProjects = projects.filter((item) => item.id !== projectId),
        nextTasks = engine
          .getAllTasks()
          .filter((task) => task.projectId !== projectId)
          .slice()
          .reverse(),
        nextProxyJobs = proxyJobs.filter(
          (job) => !job.sourceTaskId || !taskIds.has(job.sourceTaskId),
        ),
        deletedProxyJobs = proxyJobs.length - nextProxyJobs.length,
        nextHealthRecords = healthRecords.filter(
          (item) => item.projectId !== projectId,
        ),
        nextArchiveChanges = archiveChanges.filter(
          (item) => item.projectId !== projectId,
        ),
        nextArchiveReminders = archiveReminders.filter(
          (item) => item.projectId !== projectId,
        ),
        nextArchiveRuns = archiveRuns.filter(
          (item) => item.projectId !== projectId,
        ),
        nextArchiveEvidence = replaceArchiveEvidence(
          currentArchiveEvidence(),
          {
            healthRecords: nextHealthRecords,
            changes: nextArchiveChanges,
            reminders: nextArchiveReminders,
            runs: nextArchiveRuns,
          },
        );
      if (deletionPreview.blockingProxyJobs)
        throw new Error("项目仍有关联的代理任务未结束，不能删除项目记录");
      try {
        await store.write("proxy-jobs.json", nextProxyJobs);
        await commitArchiveEvidence(
          nextArchiveEvidence,
          nextTasks,
          nextProjects,
        );
      } catch (error) {
        await store.write("proxy-jobs.json", proxyJobs).catch(() => undefined);
        throw error;
      }
      for (const task of relatedTasks) engine.deleteTask(task.id);
      proxyJobs = nextProxyJobs;
      return {
        projects: nextProjects,
        deletedTasks: relatedTasks.length,
        deletedProxyJobs,
      };
    },
  );
  handle(
    "projects:claim-volume",
    async (projectId: string, device: string, prefixOverride?: string) => {
      const all = (await readProjects()).map(normalizeProject),
        project = all.find((p) => p.id === projectId);
      if (!project) throw new Error("项目不存在");
      if (!project.devices.includes(device))
        throw new Error("所选设备不属于当前项目");
      const timestamp = formatVolumeTimestamp();
      project.lastVolumeTimestampByDevice ||= {};
      project.volumeTimestampCollisionByDevice ||= {};
      const configuredPrefix =
        project.volumePrefixByDevice?.[device] ||
        project.volumePrefix ||
        `${device}_`;
      const cleanOverride = prefixOverride?.trim()
        ? segment(prefixOverride)
        : "";
      const prefix = cleanOverride
        ? cleanOverride.endsWith("_")
          ? cleanOverride
          : `${cleanOverride}_`
        : configuredPrefix;
      const claimed = claimTimestampedVolume(
        prefix,
        timestamp,
        project.lastVolumeTimestampByDevice[device],
        project.volumeTimestampCollisionByDevice[device],
      );
      project.lastVolumeTimestampByDevice[device] = timestamp;
      project.volumeTimestampCollisionByDevice[device] = claimed.collision;
      await writeProjects(all);
      return { ...claimed, timestamp, prefix, project };
    },
  );
  handle("report:daily", async (shootingDate: string, projectId?: string) => {
    const tasks = engine
      .getAllTasks()
      .filter(
        (t) =>
          (!projectId || t.projectId === projectId) &&
          (t.shootingDate ||
            new Date(t.completedAt || t.createdAt || 0).toLocaleDateString(
              "sv-SE",
            )) === shootingDate,
      );
    if (!tasks.length) throw new Error("所选拍摄日没有可汇总的任务");
    const project = (await readProjects()).find((p) => p.id === projectId);
    const r = await dialog.showSaveDialog({
      defaultPath: `Kocpy_${project?.name || "全部项目"}_${shootingDate}_汇总.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!r.filePath) return null;
    const report = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    try {
      await report.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            (
              await generateDailyReport(tasks, shootingDate, project?.name)
            ).toString(),
          ),
      );
      const pdf = await report.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.35, bottom: 0.35, left: 0.3, right: 0.3 },
      });
      await fs.writeFile(r.filePath, pdf);
    } finally {
      report.destroy();
    }
    await syncReport(r.filePath);
    return r.filePath;
  });
  handle(
    "report:project",
    async (projectId: string, format: "pdf" | "json" | "csv" | "bundle") => {
      const project = (await readProjects())
        .map(normalizeProject)
        .find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      const tasks = engine
        .getAllTasks()
        .filter((task) => task.projectId === projectId);
      if (!tasks.length) throw new Error("当前项目还没有可导出的备份记录");
      const csv = () => {
        const cell = (value: unknown) =>
          `"${String(value ?? "").replace(/"/g, '""')}"`;
        return (
          "\ufeff" +
          [
            "拍摄日期,设备,机位,素材卷,文件数,素材大小,可信状态,有校验记录目标,可计数副本,项目要求副本",
            ...tasks.map((task) =>
              [
                task.shootingDate,
                task.devices.join("/"),
                task.cameraPosition,
                task.name,
                task.totalFiles,
                task.totalBytes,
                taskTrustState(task).label,
                task.destinations.filter((destination) => destination.verified)
                  .length,
                taskTrustState(task).countableCopies,
                project.requiredCopies || 2,
              ]
                .map(cell)
                .join(","),
            ),
          ].join("\n")
        );
      };
      if (format === "bundle") {
        const unsafe = tasks.filter(
          (task) =>
            !taskMeetsCopyRequirement(task, project.requiredCopies || 2) ||
            manifestDestinationIndex(task) < 0,
        );
        if (unsafe.length)
          throw new Error(
            `仍有 ${unsafe.length} 个素材卷未满足校验、清单或物理独立副本要求，不能生成项目归档包`,
          );
        const chosen = await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
        if (chosen.canceled) return null;
        const folder = path.join(
          chosen.filePaths[0],
          `Kocpy_${segment(project.name)}_项目归档包_${Date.now()}`,
        );
        await fs.mkdir(folder, { recursive: true });
        const archiveFiles = [
          "项目完整报告.pdf",
          "项目完整数据.json",
          "项目素材统计.csv",
          ...tasks.map(
            (task) => `${segment(task.name)}_${task.id.slice(0, 6)}.mhl`,
          ),
        ];
        await Promise.all([
          fs.writeFile(
            path.join(folder, "项目完整报告.pdf"),
            await htmlToPdf(await generateProjectReport(project, tasks)),
          ),
          fs.writeFile(path.join(folder, "项目素材统计.csv"), csv()),
          ...tasks.map((task) =>
            fs.writeFile(
              path.join(
                folder,
                `${segment(task.name)}_${task.id.slice(0, 6)}.mhl`,
              ),
              generateMhl(task, manifestDestinationIndex(task)),
            ),
          ),
        ]);
        await writeProjectJsonStream(
          path.join(folder, "项目完整数据.json"),
          project,
          tasks,
        );
        const checksums = await Promise.all(
          archiveFiles.map(
            async (name) =>
              `${await hashFile(path.join(folder, name), "sha256")}  ${name}`,
          ),
        );
        await fs.writeFile(
          path.join(folder, "SHA256SUMS.txt"),
          checksums.join("\n") + "\n",
        );
        return folder;
      }
      const extension = format;
      const result = await dialog.showSaveDialog({
        defaultPath: `Kocpy_${project.name}_项目完整报告.${extension}`,
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
      });
      if (!result.filePath) return null;
      if (format === "json")
        await writeProjectJsonStream(result.filePath, project, tasks);
      else if (format === "csv") await fs.writeFile(result.filePath, csv());
      else
        await fs.writeFile(
          result.filePath,
          await htmlToPdf(await generateProjectReport(project, tasks)),
        );
      await syncReport(result.filePath);
      return result.filePath;
    },
  );
  handle(
    "report:resolve-csv",
    async (shootingDate: string, projectId?: string) => {
      const tasks = engine
        .getAllTasks()
        .filter(
          (t) =>
            (!projectId || t.projectId === projectId) &&
            (t.shootingDate ||
              new Date(t.completedAt || t.createdAt || 0).toLocaleDateString(
                "sv-SE",
              )) === shootingDate,
        );
      const videos = tasks
        .flatMap((task) =>
          task.fileRecords
            .filter((file) => /\.(mov|mp4|mxf|mkv|avi|m4v)$/i.test(file.name))
            .map((file) => ({
              task,
              file,
              mediaPath: file.destinations.find(
                (destination) => destination.verified && destination.path,
              )?.path,
            })),
        )
        .filter((row) => row.mediaPath);
      if (!videos.length) throw new Error("所选拍摄日没有已校验的视频素材");
      const result = await dialog.showSaveDialog({
        defaultPath: `Kocpy_${shootingDate}_Resolve媒体池.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!result.filePath) return null;
      const cell = (value: unknown) => {
        const raw = String(value ?? "");
        const safe = /^[=+@-]/.test(raw) ? "'" + raw : raw;
        return '"' + safe.replace(/"/g, '""') + '"';
      };
      const rows = [
        "Media Path,Clip Name,Reel,Camera,Shooting Date,Kocpy Task",
      ];
      for (const row of videos) {
        const metadata = await inspectMedia(
          row.mediaPath!,
          path.join(app.getPath("userData"), "thumbnails"),
        ).catch(() => ({}) as any);
        rows.push(
          [
            row.mediaPath,
            row.file.name,
            row.task.devices[0] || "",
            metadata.camera || "",
            row.task.shootingDate || shootingDate,
            row.task.name,
          ]
            .map(cell)
            .join(","),
        );
      }
      await fs.writeFile(result.filePath, "\ufeff" + rows.join("\n"), "utf8");
      await syncReport(result.filePath);
      return result.filePath;
    },
  );
  handle(
    "report:export",
    async (id: string, format: "pdf" | "json" | "mhl" | "ascmhl") => {
      const task = engine.getTask(id);
      if (!task) throw new Error("任务不存在");
      if (["pending", "running", "paused", "verifying"].includes(task.status))
        throw new Error("任务结束后才能导出完整报告");
      const r = await dialog.showSaveDialog({
        defaultPath: `Kocpy_${task.name}_${id.slice(0, 6)}${format === "ascmhl" ? "_ASC.mhl" : `.${format}`}`,
        filters: [
          {
            name: format.toUpperCase(),
            extensions: [format === "ascmhl" ? "mhl" : format],
          },
        ],
      });
      if (!r.filePath) return null;
      if (format === "json")
        await fs.writeFile(r.filePath, JSON.stringify(task, null, 2));
      else if (format === "mhl") {
        const destinationIndex = manifestDestinationIndex(task);
        if (
          task.status !== "completed" ||
          !manifestRequirementMet(task) ||
          destinationIndex < 0
        )
          throw new Error(
            "只有通过完整校验且没有未解决清单差异的副本才能导出 MHL",
          );
        await fs.writeFile(r.filePath, generateMhl(task, destinationIndex));
      } else if (format === "ascmhl") {
        const destinationIndex = manifestDestinationIndex(task);
        if (
          task.status !== "completed" ||
          !manifestRequirementMet(task) ||
          destinationIndex < 0
        )
          throw new Error(
            "只有通过完整校验且没有未解决清单差异的副本才能导出 ASC MHL",
          );
        for (const record of task.fileRecords)
          if (!record.ascMhlMd5) {
            const readable =
              record.destinations.find((d) => d.verified && d.path)?.path ||
              path.join(task.sourcePath, record.relativePath);
            record.ascMhlMd5 = await hashFile(readable, "md5");
          }
        await fs.writeFile(r.filePath, generateAscMhl(task, destinationIndex));
        await persist();
      } else {
        for (const record of task.fileRecords) {
          if (record.thumbnailPath || !isThumbnailMedia(record.name)) continue;
          const readable = record.destinations.find(
            (destination) => destination.verified && destination.path,
          )?.path;
          if (!readable) continue;
          record.thumbnailPath = await inspectMedia(
            readable,
            path.join(app.getPath("userData"), "thumbnails"),
          ).then(
            (media) => media.thumbnailPath,
            () => undefined,
          );
        }
        await persist();
        const report = new BrowserWindow({
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        try {
          await report.loadURL(
            "data:text/html;charset=utf-8," +
              encodeURIComponent(
                (
                  await generateReport(task, { includeThumbnails: true })
                ).toString(),
              ),
          );
          const pdf = await report.webContents.printToPDF({
            printBackground: true,
            pageSize: "A4",
            margins: { top: 0.4, bottom: 0.4, left: 0.3, right: 0.3 },
          });
          await fs.writeFile(r.filePath, pdf);
        } finally {
          report.destroy();
        }
      }
      await syncReport(r.filePath);
      return r.filePath;
    },
  );
  handle("media:inspect", async (input: string) => {
    const tracked = engine
      .getAllTasks()
      .flatMap((t) => t.fileRecords)
      .some((f) => f.destinations.some((d) => d.path === input && d.verified));
    if (!tracked) throw new Error("只能预览已校验的素材副本");
    return inspectMedia(
      input,
      path.join(app.getPath("userData"), "thumbnails"),
    );
  });
  handle("proxy:list", () => proxyJobs);
  handle("proxy:presets", () => savedProxyPresets);
  handle(
    "proxy:save-preset",
    async (value: Partial<SavedProxyPreset> & { name: string }) => {
      const name = value.name?.trim(),
        resolution = value.resolution?.trim(),
        namingTemplate = value.namingTemplate?.trim();
      if (!name) throw new Error("请输入预设名称");
      if (!resolution || !/^(\d{3,4}p|\d{3,5}x\d{3,5})$/i.test(resolution))
        throw new Error("分辨率格式无效");
      if (!namingTemplate || !namingTemplate.includes("{name}"))
        throw new Error("命名规则必须包含 {name}");
      const existing = savedProxyPresets.find((item) => item.id === value.id),
        now = Date.now(),
        format = value.format === "prores" ? "prores" : "h264",
        container = value.container || (format === "prores" ? "mov" : "mp4"),
        parameters = validateProxyParameters({
          purpose: value.purpose || "review",
          format,
          resolution,
          bitrateMbps:
            value.bitrateMbps && value.bitrateMbps > 0
              ? Math.min(500, value.bitrateMbps)
              : undefined,
          container,
          namingTemplate,
        });
      const preset: SavedProxyPreset = {
        id: existing?.id || randomUUID(),
        name,
        ...parameters,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      savedProxyPresets = [
        ...savedProxyPresets.filter((item) => item.id !== preset.id),
        preset,
      ].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
      await store.write("proxy-presets.json", savedProxyPresets);
      return savedProxyPresets;
    },
  );
  handle("proxy:delete-preset", async (id: string) => {
    savedProxyPresets = savedProxyPresets.filter((item) => item.id !== id);
    await store.write("proxy-presets.json", savedProxyPresets);
    return savedProxyPresets;
  });
  handle(
    "proxy:enqueue",
    async (
      inputs: string[],
      out: string,
      format: "h264" | "prores",
      resolution: string,
      options: {
        preset?: "review" | "editorial" | "offline";
        namingTemplate?: string;
        bitrateMbps?: number;
        container?: "mp4" | "mov" | "mkv";
        dependsOn?: string[];
        chain?: boolean;
      } = {},
    ) => {
      if (!inputs.length) throw new Error("请选择至少一个视频");
      const parameters = validateProxyParameters({
        purpose:
          options.preset || (format === "prores" ? "editorial" : "review"),
        format,
        resolution,
        bitrateMbps: options.bitrateMbps,
        container: options.container || (format === "prores" ? "mov" : "mp4"),
        namingTemplate: options.namingTemplate || "{name}_proxy_{resolution}",
      });
      const canonicalOut = await canonical(out);
      for (const task of engine.getAllTasks())
        if (inside(canonicalOut, await canonical(task.sourcePath)))
          throw new Error("代理不能写入素材源目录");
      const tracked = new Map(
        engine
          .getAllTasks()
          .flatMap((task) =>
            task.fileRecords.flatMap((record) =>
              record.destinations
                .filter((destination) => destination.verified)
                .map(
                  (destination) =>
                    [
                      destination.path,
                      { task, record, destination },
                    ] as const,
                ),
            ),
          ),
      );
      for (const input of inputs)
        if (!tracked.has(input))
          throw new Error("只能为已校验的备份文件生成代理");
      const jobs: ProxyJob[] = [];
      for (const input of inputs) {
        const source = tracked.get(input)!;
        if (!source.destination.checksum && !source.record.srcChecksum)
          throw new Error(`已校验记录缺少哈希证据：${path.basename(input)}`);
        const stat = await fs.stat(input);
        if (!stat.isFile()) throw new Error("请选择视频文件");
        if (stat.size !== source.record.size)
          throw new Error(`素材大小已变化，请先重新校验：${path.basename(input)}`);
        const metadata = await inspectMedia(
            input,
            path.join(app.getPath("userData"), "thumbnails"),
          ).catch(() => ({}) as any),
          sourceEvidence = {
            taskId: source.task.id,
            relativePath: source.record.relativePath,
            path: input,
            bytes: stat.size,
            modifiedAt: stat.mtimeMs,
            hashAlgorithm: source.task.hashAlgorithm,
            checksum: source.destination.checksum || source.record.srcChecksum,
            capturedAt: Date.now(),
            media: {
              duration: metadata.duration,
              frameRate: metadata.frameRate,
              timecode: metadata.timecode,
              audio: metadata.audio,
              audioTracks: metadata.audioTracks,
              rotation: metadata.rotation,
              colorSpace: metadata.colorSpace,
              resolution: metadata.resolution,
            },
          };
        jobs.push({
          id: randomUUID(),
          input,
          name: path.basename(input),
          outputDir: out,
          format: parameters.format,
          resolution: parameters.resolution,
          bitrateMbps: parameters.bitrateMbps,
          container: parameters.container,
          preset: parameters.purpose,
          namingTemplate: parameters.namingTemplate,
          sourceTaskId: source.task.id,
          sourceRelativePath: source.record.relativePath,
          status: "pending",
          stage: "queued",
          progress: 0,
          createdAt: Date.now(),
          timecode: metadata.timecode,
          sourceFrameRate: metadata.frameRate,
          sourceAudio: metadata.audio,
          sourceDuration: metadata.duration,
          sourceColorSpace: metadata.colorSpace,
          sourceEvidence,
          parameterSnapshot: { ...parameters },
          dependsOn:
            options.chain && jobs.length
              ? [jobs[jobs.length - 1].id]
              : options.dependsOn,
        });
      }
      proxyJobs.push(...jobs);
      await persistProxyJobs();
      emitProxyJobs();
      void processProxyQueue();
      return jobs;
    },
  );
  handle("proxy:cancel", async (id?: string) => {
    const job = id
      ? proxyJobs.find((j) => j.id === id)
      : proxyJobs.find((j) => j.status === "running");
    if (!job) return false;
    if (job.status === "running")
      proxyController?.abort(new Error("用户取消代理任务"));
    else if (["pending", "paused"].includes(job.status))
      job.status = "cancelled";
    await persistProxyJobs();
    emitProxyJobs();
    return true;
  });
  handle("proxy:pause", async (id: string) => {
    const job = proxyJobs.find((item) => item.id === id);
    if (!job || job.status !== "running")
      throw new Error("只有正在转码的任务可以暂停");
    job.pauseReason = "user";
    proxyPauseRequested = id;
    proxyController?.abort(new Error("用户暂停代理任务"));
    return true;
  });
  handle("proxy:resume", async (id: string) => {
    const job = proxyJobs.find((item) => item.id === id);
    if (!job || job.status !== "paused") throw new Error("该代理任务未暂停");
    Object.assign(job, {
      status: "pending",
      stage: "queued",
      progress: 0,
      error: undefined,
      pauseReason: undefined,
    });
    await persistProxyJobs();
    emitProxyJobs();
    void processProxyQueue();
    return true;
  });
  handle("proxy:retry", async (id: string) => {
    const job = proxyJobs.find((j) => j.id === id);
    if (!job || !["failed", "cancelled"].includes(job.status))
      throw new Error("该任务不能重试");
    Object.assign(job, {
      status: "pending",
      stage: "queued",
      progress: 0,
      error: undefined,
      pauseReason: undefined,
      completedAt: undefined,
    });
    await persistProxyJobs();
    emitProxyJobs();
    void processProxyQueue();
    return true;
  });
  handle("proxy:delete", async (id: string) => {
    const job = proxyJobs.find((j) => j.id === id);
    if (!job || ["running", "pending", "paused"].includes(job.status))
      throw new Error("请先取消代理任务");
    proxyJobs = proxyJobs.filter((j) => j.id !== id);
    await persistProxyJobs();
    emitProxyJobs();
    return true;
  });
  handle(
    "proxy:export-delivery",
    async (
      format: "resolve" | "premiere" | "fcpxml" | "json",
      jobIds?: string[],
    ) => {
      if (!["resolve", "premiere", "fcpxml", "json"].includes(format))
        throw new Error("不支持的交付格式");
      const selected = await preflightProxyDelivery(
          proxyJobs.filter(
            (job) =>
              job.status === "completed" &&
              (!jobIds || jobIds.includes(job.id)),
          ),
        ),
        extension =
          format === "fcpxml" ? "fcpxml" : format === "json" ? "json" : "csv",
        result = await dialog.showSaveDialog({
          defaultPath: `Kocpy_代理交付_${format}.${extension}`,
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        });
      if (!result.filePath) return null;
      await fs.writeFile(
        result.filePath,
        generateDeliveryManifest(selected, format),
        "utf8",
      );
      return result.filePath;
    },
  );
  handle("proxy:export-package", async (jobIds?: string[]) => {
    const completed = proxyJobs.filter(
      (job) =>
        job.status === "completed" &&
        job.outputPath &&
        (!jobIds || jobIds.includes(job.id)),
    );
    if (!completed.length) throw new Error("没有可交付的已完成代理文件");
    const chosen = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (chosen.canceled) return null;
    return publishProxyDeliveryPackage(
      completed,
      chosen.filePaths[0],
      app.getVersion(),
    );
  });
  engine.on("progress", (payload) => {
    if (operations.active)
      operations.progress({
        message: `${payload.status} · ${payload.currentFile || ""}`,
        totalBytes: payload.totalBytes,
        completedBytes: payload.verifiedBytes,
        speedBps: payload.speedBps,
      });
    if (!persistTimer)
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        // The canonical checkpoint remains crash-safe every second. The large
        // legacy mirror is synchronized when the task settles or another
        // explicit state transition occurs, avoiding duplicate full-state I/O
        // in the transfer hot path.
        void persist(false, false).catch(() => {});
      }, 1000);
    if (main && !main.isDestroyed())
      main.webContents.send("tasks:progress", payload);
    if (
      ["running", "paused", "verifying"].includes(payload.status) &&
      blocker === undefined
    )
      blocker = powerSaveBlocker.start("prevent-app-suspension");
  });
  engine.on(
    "settled",
    async (task: BackupTask, context?: { kind: "reverify" }) => {
      const allowCompletionActions =
        !operations.active && context?.kind !== "reverify";
      clearTimeout(persistTimer);
      persistTimer = undefined;
      void persist(true)
        .then(async () => {
          if (main && !main.isDestroyed())
            main.webContents.send("workspace:changed");
          if (!engine.hasActive() && backupStartPending === 0) {
            const resumed = resumeBackupPausedProxyJobs(proxyJobs);
            if (resumed) {
              await persistProxyJobs();
              emitProxyJobs();
            }
            void processProxyQueue();
          }
        })
        .catch(() => undefined);
      if (blocker !== undefined) {
        powerSaveBlocker.stop(blocker);
        blocker = undefined;
      }
      if (main && !main.isDestroyed())
        main.webContents.send("tasks:settled", task);
      if (task.status === "completed" && Notification.isSupported()) {
        const passed = task.destinations.filter(
          (destination) => destination.verified,
        ).length;
        new Notification({
          title: "备份与校验完成",
          body: `${task.name} · ${task.totalFiles} 个文件 · ${passed} 个目标通过校验`,
          silent: !(await store.read("settings.json", defaultSettings))
            .notificationSound,
        }).show();
      }
      if (
        task.status === "completed" &&
        task.projectId &&
        allowCompletionActions
      )
        void (async () => {
          const project = (await readProjects()).find(
            (item) => item.id === task.projectId,
          );
          if (!ensureCompletionActionPlan(task, project)) return;
          await persist(true);
          if (main && !main.isDestroyed())
            main.webContents.send("workspace:changed");
        })().catch((error) => {
          task.faultTimeline = [
            ...(task.faultTimeline || []),
            {
              at: Date.now(),
              phase: "completion-plan",
              level: "error",
              message: String(error),
            },
          ];
          void persist();
        });
    },
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Kocpy",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "窗口",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }],
      },
    ]),
  );
  createWindow();
  powerMonitor.on("suspend", () => {
    for (const task of engine
      .getAllTasks()
      .filter((item) => ["running", "verifying"].includes(item.status))) {
      try {
        engine.pauseTask(task.id);
        task.faultTimeline = [
          ...(task.faultTimeline || []),
          {
            at: Date.now(),
            phase: "system-sleep",
            level: "warning",
            message: "系统进入睡眠，任务已保存检查点并安全暂停",
          },
        ];
      } catch {
        /* task may already be settling */
      }
    }
    void persist();
  });
  powerMonitor.on("resume", () => {
    for (const task of engine
      .getAllTasks()
      .filter((item) => item.status === "paused")) {
      task.faultTimeline = [
        ...(task.faultTimeline || []),
        {
          at: Date.now(),
          phase: "system-resume",
          level: "info",
          message: "系统已唤醒；请确认素材源与目的地后继续",
        },
      ];
    }
    void persist();
  });
  emitProxyJobs();
  void processProxyQueue();
  app.on("activate", () => {
    if (!main || main.isDestroyed()) createWindow();
    else main.show();
  });
});
app.on("before-quit", (event) => {
  if (quitReady) return;
  event.preventDefault();
  if (engine.hasActive() || proxyBusy || operations.active) {
    main?.show();
    dialog.showMessageBoxSync({
      type: "info",
      message: "仍有任务进行中",
      detail: operations.active
        ? operations
            .list()
            .filter((item) => item.status === "running")
            .map((item) => item.name)
            .join("、") +
          "尚未完成。可关闭窗口在后台继续，提交阶段不支持强制取消，请等待结束后退出。"
        : "请先安全取消备份或代理任务，或等待完成后退出。",
    });
    return;
  }
  void Promise.all([workspace.flush(), store.flush(), catalog.flush()])
    .then(() => {
      quitReady = true;
      app.quit();
    })
    .catch((e) => dialog.showErrorBox("保存失败，暂未退出", String(e)));
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
