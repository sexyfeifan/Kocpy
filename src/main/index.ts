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
import { inspectMedia, isThumbnailMedia, pruneMediaCache } from "./media";
import {
  generateReport,
  generateDailyReport,
  generateProjectReport,
} from "./backup/ReportGenerator";
import { generateMhl, generateAscMhl } from "./backup/ManifestGenerator";
import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  BackupTask,
  NasPreset,
  ProjectConfig,
  ProjectTemplate,
  ReliabilityValidationRecord,
  SavedProxyPreset,
  TaskConfig,
  ProxyJob,
} from "./types";
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
  verifiedPhysicalCopyCount,
} from "./project-closeout";
import {
  benchmarkDirectory,
  buildDiagnosticSnapshot,
  type BenchmarkResult,
} from "./diagnostics";
import { generateDeliveryManifest } from "./delivery";
import {
  mergeWorkspace,
  sourceSuggestion,
  templateFromProject,
  validateWorkspacePackage,
} from "./lifecycle";
import { CatalogDatabase } from "./catalog";
import {
  builtInProductionTemplates,
  importExistingBackup,
  inspectExternalManifest,
  previewExistingBackup,
  projectCoverage,
  repairMissingManifestFiles,
  reviseMhlMissingEntries,
} from "./production-lifecycle";
import { LanProjectIndex } from "./lan-index";
import {
  consolidateExistingRecords,
  deduplicateBoundRoots,
  existingSourceKey,
} from "./existing-records";

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
  catalog = new CatalogDatabase(app.getPath("userData"));
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
        const positions = (project.devicePositions?.[device] || [])
          .filter((value) => /^[A-E]$/.test(value))
          .slice(0, 5);
        return positions.length ? [[device, positions]] : [];
      }),
    ),
    restDays: [...new Set(project.restDays || [])],
    unusedDevicesByDate: Object.fromEntries(
      Object.entries(project.unusedDevicesByDate || {}).map(
        ([date, values]) => [
          date,
          [...new Set(values)].filter((device) => devices.includes(device)),
        ],
      ),
    ),
    requiredCopies: Math.max(1, Math.min(4, project.requiredCopies || 2)),
  };
};

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
      const positions = [...new Set(project.devicePositions?.[device] || [])]
        .filter((position) => /^[A-E]$/.test(position))
        .slice(0, 5);
      return positions.length ? [[device, positions]] : [];
    }),
  );
  project.restDays = [...new Set(project.restDays || [])];
  project.unusedDevicesByDate = Object.fromEntries(
    Object.entries(project.unusedDevicesByDate || {}).map(([date, values]) => [
      date,
      [...new Set(values)].filter((device) => project.devices.includes(device)),
    ]),
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
  proxyJobs: ProxyJob[] = [];
let benchmarkHistory: BenchmarkResult[] = [];
let reliabilityValidations: ReliabilityValidationRecord[] = [];
let healthRecords: ArchiveHealthRecord[] = [],
  projectTemplates: ProjectTemplate[] = [],
  archiveChanges: ArchiveChangeRecord[] = [],
  archiveReminders: ArchiveReminder[] = [],
  nasPresets: NasPreset[] = [],
  savedProxyPresets: SavedProxyPreset[] = [];
const lanIndex = new LanProjectIndex(() => ({
  projects: [],
  tasks: engine.getAllTasks(),
}));
const persist = () =>
  store.write("tasks.json", engine.getAllTasks().slice().reverse());
app.on("second-instance", () => {
  if (main && !main.isDestroyed()) {
    main.show();
    main.focus();
  }
});
function handle(name: string, fn: (...args: any[]) => any) {
  ipcMain.handle(name, (_event, ...args) => fn(...args));
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
async function processProxyQueue() {
  if (proxyBusy) return;
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
    progress: 0,
    startedAt: Date.now(),
    error: undefined,
  });
  emitProxyJobs();
  await persistProxyJobs();
  const lock = powerSaveBlocker.start("prevent-app-suspension");
  try {
    if (!job.sourceDuration) {
      const sourceMetadata = await inspectMedia(
        job.input,
        path.join(app.getPath("userData"), "thumbnails"),
      ).catch(() => ({}) as any);
      job.sourceDuration = sourceMetadata.duration;
      job.sourceFrameRate ||= sourceMetadata.frameRate;
      job.sourceAudio ||= sourceMetadata.audio;
      job.timecode ||= sourceMetadata.timecode;
      job.sourceColorSpace ||= sourceMetadata.colorSpace;
    }
    const result = await makeProxy(
      job.input,
      job.outputDir,
      job.format,
      job.resolution,
      {
        signal: proxyController.signal,
        namingTemplate: job.namingTemplate,
        bitrateMbps: job.bitrateMbps,
        container: job.container,
        onProgress: (progress) => {
          job.progress = progress;
          emitProxyJobs();
        },
      },
    );
    const outputMetadata = await inspectMedia(
      result.outputPath,
      path.join(app.getPath("userData"), "thumbnails"),
    ).catch(() => ({}) as any);
    const notes: string[] = [],
      frameRate =
        !job.sourceFrameRate || !outputMetadata.frameRate
          ? "unknown"
          : Math.abs(
                Number(job.sourceFrameRate) - Number(outputMetadata.frameRate),
              ) < 0.02
            ? "match"
            : "changed",
      timecode =
        !job.timecode || !outputMetadata.timecode
          ? "unknown"
          : job.timecode === outputMetadata.timecode
            ? "match"
            : "changed",
      audio = !job.sourceAudio
        ? "unknown"
        : outputMetadata.audio
          ? "present"
          : "missing",
      colorSpace =
        !job.sourceColorSpace || !outputMetadata.colorSpace
          ? "unknown"
          : job.sourceColorSpace === outputMetadata.colorSpace
            ? "match"
            : "changed";
    if (frameRate === "changed")
      notes.push(
        `帧率由 ${job.sourceFrameRate} 变为 ${outputMetadata.frameRate}`,
      );
    if (timecode === "changed") notes.push("输出时间码与源素材不同");
    if (audio === "missing") notes.push("源素材包含音轨，但代理未检测到音轨");
    if (colorSpace === "changed")
      notes.push(
        `色彩空间由 ${job.sourceColorSpace} 变为 ${outputMetadata.colorSpace}`,
      );
    Object.assign(job, {
      status: "completed",
      progress: 100,
      outputPath: result.outputPath,
      completedAt: Date.now(),
      validation: { frameRate, timecode, audio, colorSpace, notes },
    });
  } catch (e: any) {
    const paused = proxyPauseRequested === job.id;
    Object.assign(job, {
      status: paused
        ? "paused"
        : proxyController.signal.aborted
          ? "cancelled"
          : "failed",
      error: paused ? undefined : e.message || String(e),
      completedAt: paused ? undefined : Date.now(),
    });
  } finally {
    proxyBusy = false;
    proxyController = undefined;
    proxyPauseRequested = undefined;
    powerSaveBlocker.stop(lock);
    await persistProxyJobs();
    emitProxyJobs();
    void processProxyQueue();
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
  main.webContents.on("will-navigate", (event) => event.preventDefault());
  main.once("ready-to-show", () => main?.show());
  main.on("close", (event) => {
    if ((engine.hasActive() || proxyBusy) && !quitReady) {
      event.preventDefault();
      main?.hide();
    }
  });
  if (process.env.ELECTRON_RENDERER_URL)
    main.loadURL(process.env.ELECTRON_RENDERER_URL);
  else main.loadFile(path.join(__dirname, "../renderer/index.html"));
}
app.whenReady().then(async () => {
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
  healthRecords = await store.read<ArchiveHealthRecord[]>(
    "archive-health.json",
    [],
  );
  projectTemplates = await store.read<ProjectTemplate[]>(
    "project-templates.json",
    [],
  );
  archiveChanges = await store.read<ArchiveChangeRecord[]>(
    "archive-changes.json",
    [],
  );
  archiveReminders = await store.read<ArchiveReminder[]>(
    "archive-reminders.json",
    [],
  );
  nasPresets = await store.read<NasPreset[]>("nas-presets.json", []);
  savedProxyPresets = await store.read<SavedProxyPreset[]>(
    "proxy-presets.json",
    [],
  );
  void refreshNasHealth();
  setInterval(() => void refreshNasHealth(), 60_000);
  for (const reminder of archiveReminders.filter(
    (item) => item.enabled && item.nextAt <= Date.now(),
  )) {
    const project = (
      await store.read<ProjectConfig[]>("projects.json", [])
    ).find((item) => item.id === reminder.projectId);
    if (Notification.isSupported())
      new Notification({
        title: "归档复校验到期",
        body: `${project?.name || "项目"} 已到周期复校验时间`,
        silent: !initialSettings.notificationSound,
      }).show();
    reminder.lastNotifiedAt = Date.now();
    reminder.nextAt = Date.now() + reminder.intervalDays * 86_400_000;
  }
  await store.write("archive-reminders.json", archiveReminders);
  setInterval(
    () =>
      void (async () => {
        const due = archiveReminders.filter(
          (item) => item.enabled && item.nextAt <= Date.now(),
        );
        if (!due.length) return;
        const projects = await store.read<ProjectConfig[]>("projects.json", []);
        for (const reminder of due) {
          const project = projects.find(
            (item) => item.id === reminder.projectId,
          );
          if (Notification.isSupported())
            new Notification({
              title: "归档复校验到期",
              body: `${project?.name || "项目"} 已到周期复校验时间`,
              silent: !initialSettings.notificationSound,
            }).show();
          reminder.lastNotifiedAt = Date.now();
          reminder.nextAt = Date.now() + reminder.intervalDays * 86_400_000;
        }
        await store.write("archive-reminders.json", archiveReminders);
      })(),
    3_600_000,
  );
  for (const template of builtInProductionTemplates())
    if (!projectTemplates.some((item) => item.id === template.id))
      projectTemplates.push(template);
  for (const job of proxyJobs)
    if (job.status === "running") {
      job.status = "failed";
      job.error = "上次转码被中断，可点击重试";
    }
  const mirroredTasks = await store.read<BackupTask[]>("tasks.json", []),
    indexedTasks = await catalog.loadTasks().catch(() => []);
  const saved = indexedTasks.length ? indexedTasks : mirroredTasks;
  for (const task of saved) {
    if (["pending", "running", "paused", "verifying"].includes(task.status)) {
      task.status = "failed";
      task.errorMessage = "上次运行中断。可重新执行并重新校验已有文件。";
    }
    engine.loadTask(task);
  }
  await persist();
  const mirroredProjects = (
      await store.read<ProjectConfig[]>("projects.json", [])
    ).map(normalizeProject),
    indexedProjects = (await catalog.loadProjects().catch(() => [])).map(
      normalizeProject,
    ),
    initialProjects = indexedProjects.length
      ? indexedProjects
      : mirroredProjects;
  await store.write("projects.json", initialProjects);
  if (!indexedTasks.length || !indexedProjects.length)
    await catalog
      .rebuild(engine.getAllTasks(), initialProjects)
      .catch(async () => {
        await catalog.recover().catch(() => {});
        await catalog.rebuild(engine.getAllTasks(), initialProjects);
      });
  else for (const task of engine.getAllTasks()) await catalog.upsertTask(task);
  handle("dialog:directory", async (defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath:
        defaultPath && path.isAbsolute(defaultPath) ? defaultPath : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
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
    (options: {
      projectId?: string;
      query?: string;
      kind?: string;
      offset?: number;
      limit?: number;
    }) => catalog.pageFiles(options || {}),
  );
  handle("catalog:rebuild", async () => {
    const projects = (
      await store.read<ProjectConfig[]>("projects.json", [])
    ).map(normalizeProject);
    await catalog.rebuild(engine.getAllTasks(), projects);
    return catalog.stats();
  });
  handle("tasks:create", async (config: TaskConfig) => {
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
    if (config.projectId) {
      const project = (await store.read<ProjectConfig[]>("projects.json", []))
        .map(normalizeProject)
        .find((item) => item.id === config.projectId);
      if (!project) throw new Error("拍摄项目不存在");
      const required = project.requiredCopies || 2;
      if (
        destinationIdentities.length < required ||
        new Set(
          destinationIdentities.map((identity) => identity.uuid || identity.id),
        ).size < required
      )
        throw new Error(
          `项目要求 ${required} 份物理独立副本，请选择位于不同磁盘的目的地`,
        );
    }
    const task = engine.createTask(config);
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
    await persist();
    await catalog.upsertTask(task);
    return task;
  });
  handle("tasks:start", async (id: string) => {
    engine.startTask(id);
    await persist();
    return true;
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
    engine.resumeTask(id);
    await persist();
    return true;
  });
  handle("tasks:reverify", async (id: string) => {
    const result = await engine.reverifyTask(id);
    await persist();
    return result;
  });
  handle("tasks:retry-failed", async (id: string) => {
    engine.retryFailedDestinations(id);
    await persist();
    return true;
  });
  handle("tasks:delete", async (id: string) => {
    engine.deleteTask(id);
    await Promise.all([persist(), catalog.deleteTask(id)]);
    return true;
  });
  handle("tasks:priority", async (id: string, value: boolean) => {
    engine.setPriority(id, value);
    await persist();
  });
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
          ["pending", "running"].includes(job.status) &&
          (inside(job.input, volume) || inside(job.outputDir, volume)),
      )
    )
      throw new Error("该磁盘有等待中或进行中的代理任务，请先取消任务");
    return ejectVolume(volume);
  });
  handle("volumes:eject-completed", async () => {
    const volumes = await listVolumes(),
      results: Array<{ path: string; ok: boolean; error?: string }> = [];
    for (const volume of volumes.filter((item) => item.canEject)) {
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
        results.push({ path: volume.path, ok: false, error: "仍有进行中任务" });
        continue;
      }
      if (
        proxyJobs.some(
          (job) =>
            ["pending", "running"].includes(job.status) &&
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
          task.destinations.every((destination) => destination.verified),
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
      try {
        await ejectVolume(volume.path);
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
  });
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
  });
  handle("diagnostics:benchmark", async (directory: string, sizeMiB = 64) => {
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
      await fs.writeFile(large, block, { flag: "wx" });
      for (let offset = 0; offset < smallFiles; offset += 100)
        await Promise.all(
          Array.from(
            { length: Math.min(100, smallFiles - offset) },
            (_, index) =>
              fs.writeFile(
                path.join(
                  root,
                  "small",
                  `clip-${String(offset + index).padStart(5, "0")}.dat`,
                ),
                `kocpy-${offset + index}`,
                { flag: "wx" },
              ),
          ),
        );
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
  handle("archive:reminders", () => archiveReminders);
  handle("archive:save-reminder", async (value: ArchiveReminder) => {
    const reminder = {
      ...value,
      id: value.id || randomUUID(),
      intervalDays: Math.max(1, Math.min(3650, value.intervalDays || 180)),
      nextAt:
        value.nextAt ||
        Date.now() + Math.max(1, value.intervalDays || 180) * 86_400_000,
    };
    archiveReminders = [
      ...archiveReminders.filter((item) => item.id !== reminder.id),
      reminder,
    ];
    await store.write("archive-reminders.json", archiveReminders);
    return archiveReminders;
  });
  handle(
    "archive:verify-scope",
    async (scope: {
      projectId?: string;
      shootingDate?: string;
      taskId?: string;
      relativePath?: string;
      volumePath?: string;
    }) => {
      if (engine.hasActive() || proxyBusy)
        throw new Error("请等待当前任务结束");
      const started = Date.now();
      let tasks = engine.getAllTasks();
      if (scope.projectId)
        tasks = tasks.filter((task) => task.projectId === scope.projectId);
      if (scope.shootingDate)
        tasks = tasks.filter(
          (task) => task.shootingDate === scope.shootingDate,
        );
      if (scope.taskId)
        tasks = tasks.filter((task) => task.id === scope.taskId);
      if (scope.volumePath)
        tasks = tasks.filter((task) =>
          task.destinations.some(
            (item) =>
              inside(item.resolvedPath || item.path, scope.volumePath!) ||
              inside(scope.volumePath!, item.resolvedPath || item.path),
          ),
        );
      if (!tasks.length) throw new Error("范围内没有素材记录");
      const changes: ArchiveChangeRecord[] = [];
      let bytesVerified = 0,
        healthyTasks = 0,
        missingCopies = 0;
      for (const task of tasks) {
        if (scope.relativePath || scope.volumePath) {
          const records = scope.relativePath
            ? task.fileRecords.filter(
                (file) => file.relativePath === scope.relativePath,
              )
            : task.fileRecords;
          if (!records.length) continue;
          let taskHealthy = true;
          for (const record of records)
            for (const destination of record.destinations) {
              if (
                scope.volumePath &&
                !inside(destination.path, scope.volumePath)
              )
                continue;
              const exists = await fs.access(destination.path).then(
                  () => true,
                  () => false,
                ),
                actual = exists
                  ? await hashFile(destination.path, task.hashAlgorithm)
                  : "",
                kind = !exists
                  ? "missing"
                  : actual !== record.srcChecksum
                    ? "modified"
                    : "verified";
              destination.verified = kind === "verified";
              if (kind === "verified") bytesVerified += record.size;
              else {
                missingCopies++;
                taskHealthy = false;
              }
              if (kind !== "verified" || scope.relativePath)
                changes.push({
                  id: randomUUID(),
                  projectId: task.projectId || "",
                  taskId: task.id,
                  at: Date.now(),
                  kind,
                  path: destination.path,
                  note: `${record.relativePath}：${kind}`,
                });
            }
          if (taskHealthy) healthyTasks++;
          for (const top of task.destinations) {
            const root = top.resolvedPath || top.path,
              copies = task.fileRecords.flatMap((item) =>
                item.destinations.filter((copy) => inside(copy.path, root)),
              );
            top.verified =
              copies.length > 0 && copies.every((copy) => copy.verified);
          }
          changes.push({
            id: randomUUID(),
            projectId: task.projectId || "",
            taskId: task.id,
            at: Date.now(),
            kind: taskHealthy ? "verified" : "damaged",
            note: `${task.name} ${taskHealthy ? "复校验通过" : "复校验失败"}`,
          });
        } else {
          await engine.reverifyTask(task.id);
          if (task.status === "completed") healthyTasks++;
          missingCopies += task.destinations.filter(
            (item) => !item.verified,
          ).length;
          bytesVerified += task.fileRecords.reduce(
            (sum, item) =>
              sum +
              item.size *
                item.destinations.filter(
                  (copy) =>
                    copy.verified &&
                    (!scope.volumePath || inside(copy.path, scope.volumePath)),
                ).length,
            0,
          );
          changes.push({
            id: randomUUID(),
            projectId: task.projectId || "",
            taskId: task.id,
            at: Date.now(),
            kind: task.status === "completed" ? "verified" : "damaged",
            note: `${task.name} ${task.status === "completed" ? "复校验通过" : "复校验失败"}`,
          });
        }
      }
      const durationMs = Math.max(1, Date.now() - started),
        failedTasks = tasks.length - healthyTasks,
        record: ArchiveHealthRecord = {
          id: randomUUID(),
          projectId: scope.projectId || `disk:${scope.volumePath || "all"}`,
          checkedAt: Date.now(),
          taskCount: tasks.length,
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
          scope: scope.relativePath
            ? "file"
            : scope.taskId
              ? "card"
              : scope.shootingDate
                ? "day"
                : scope.volumePath
                  ? "disk"
                  : "project",
          notes: changes
            .filter((item) => item.kind !== "verified")
            .map((item) => item.note),
        };
      healthRecords = [...healthRecords.slice(-499), record];
      archiveChanges = [...archiveChanges, ...changes].slice(-10000);
      await Promise.all([
        store.write("archive-health.json", healthRecords),
        store.write("archive-changes.json", archiveChanges),
        persist(),
      ]);
      return { changes, record };
    },
  );
  handle("archive:audit-untracked", async (projectId: string, root: string) => {
    if (!path.isAbsolute(root)) throw new Error("请选择有效的归档根目录");
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
    const additions: ArchiveChangeRecord[] = [];
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
            at: Date.now(),
            kind: "added",
            path: file,
            note: `发现未记录文件：${path.relative(root, file)}`,
          });
        if (additions.length >= 10000) break;
      }
    }
    archiveChanges = [...archiveChanges, ...additions].slice(-10000);
    await store.write("archive-changes.json", archiveChanges);
    return additions;
  });
  handle(
    "archive:move-copy",
    async (taskId: string, destinationId: string, newPath: string) => {
      const task = engine.getTask(taskId),
        destination = task?.destinations.find(
          (item) => item.id === destinationId,
        );
      if (!task || !destination) throw new Error("副本记录不存在");
      if (!path.isAbsolute(newPath)) throw new Error("请选择有效的新位置");
      const from = destination.resolvedPath || destination.path,
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
      archiveChanges = [
        ...archiveChanges,
        {
          id: randomUUID(),
          projectId: task.projectId || "",
          taskId,
          at: Date.now(),
          kind: "moved" as const,
          from,
          to: newPath,
          note: `副本位置由 ${from} 更新为 ${newPath}，等待重新校验`,
        },
      ].slice(-10000);
      await Promise.all([
        store.write("archive-changes.json", archiveChanges),
        persist(),
      ]);
      return task;
    },
  );
  handle("archive:export-changes", async (projectId: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_归档变化_${projectId}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    await fs.writeFile(
      result.filePath,
      JSON.stringify(
        archiveChanges.filter((item) => item.projectId === projectId),
        null,
        2,
      ),
    );
    return result.filePath;
  });
  handle("archive:verify-project", async (projectId: string) => {
    if (engine.hasActive() || proxyBusy)
      throw new Error("请等待当前备份或代理任务结束");
    const started = Date.now(),
      tasks = engine
        .getAllTasks()
        .filter(
          (task) => task.projectId === projectId && task.fileRecords.length,
        ),
      notes: string[] = [];
    if (!tasks.length) throw new Error("项目没有可复校验的素材记录");
    let healthyTasks = 0,
      missingCopies = 0;
    for (const task of tasks) {
      try {
        await engine.reverifyTask(task.id);
        if (task.status === "completed") healthyTasks++;
        else notes.push(`${task.name} 未通过复校验`);
      } catch (error: any) {
        notes.push(`${task.name}：${error.message || String(error)}`);
      }
      missingCopies += task.destinations.filter(
        (destination) => !destination.verified,
      ).length;
    }
    const durationMs = Math.max(1, Date.now() - started),
      bytesVerified = tasks.reduce(
        (sum, task) =>
          sum +
          task.fileRecords.reduce(
            (total, file) =>
              total +
              file.size *
                file.destinations.filter((copy) => copy.verified).length,
            0,
          ),
        0,
      ),
      record: ArchiveHealthRecord = {
        id: randomUUID(),
        projectId,
        checkedAt: Date.now(),
        taskCount: tasks.length,
        healthyTasks,
        failedTasks: tasks.length - healthyTasks,
        missingCopies,
        durationMs,
        bytesVerified,
        averageReadBps: Math.round(bytesVerified / (durationMs / 1000)),
        risk:
          missingCopies || healthyTasks < tasks.length
            ? missingCopies > 1 || tasks.length - healthyTasks > 1
              ? "critical"
              : "attention"
            : "healthy",
        scope: "project",
        notes,
      };
    healthRecords = [...healthRecords.slice(-199), record];
    await store.write("archive-health.json", healthRecords);
    await persist();
    return record;
  });
  handle(
    "archive:repair-copy",
    async (taskId: string, destinationId: string) => {
      if (engine.hasActive() || proxyBusy)
        throw new Error("请等待当前任务结束");
      const task = engine.getTask(taskId);
      if (!task) throw new Error("任务不存在");
      const target = task.destinations.find(
        (destination) => destination.id === destinationId,
      );
      if (!target) throw new Error("目标副本不存在");
      let repaired = 0;
      for (const record of task.fileRecords) {
        const targetRecord = record.destinations.find((entry) =>
          inside(entry.path, target.resolvedPath || target.path),
        );
        if (!targetRecord || targetRecord.verified) continue;
        const healthy = record.destinations.find(
          (entry) => entry.verified && entry.path !== targetRecord.path,
        );
        if (!healthy)
          throw new Error(`${record.relativePath} 没有可用于修复的健康副本`);
        const partial = `${targetRecord.path}.kocpy-repair.partial`;
        await fs.mkdir(path.dirname(targetRecord.path), { recursive: true });
        await fs.copyFile(healthy.path, partial);
        if (
          (await hashFile(partial, task.hashAlgorithm)) !== record.srcChecksum
        ) {
          await fs.unlink(partial).catch(() => {});
          throw new Error(`${record.relativePath} 修复副本校验失败`);
        }
        const exists = await fs.access(targetRecord.path).then(
          () => true,
          () => false,
        );
        if (exists)
          await fs.rename(
            targetRecord.path,
            `${targetRecord.path}.kocpy-damaged-${Date.now()}`,
          );
        await fs.rename(partial, targetRecord.path);
        targetRecord.verified = true;
        targetRecord.checksum = record.srcChecksum;
        repaired++;
      }
      target.verified = task.fileRecords.every((record) =>
        record.destinations
          .filter((entry) =>
            inside(entry.path, target.resolvedPath || target.path),
          )
          .every((entry) => entry.verified),
      );
      target.error = undefined;
      await persist();
      return { repaired, preservedDamagedOriginals: repaired };
    },
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
        ? (await store.read<ProjectConfig[]>("projects.json", []))
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
      const projects = (
          await store.read<ProjectConfig[]>("projects.json", [])
        ).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      const task = await importExistingBackup(
        project,
        root,
        mode,
        metadata || {},
      );
      engine.loadTask(task);
      const consolidated = consolidateProjectExistingRecords(projectId);
      project.boundRoots = deduplicateBoundRoots([
        ...(project.boundRoots || []),
        { id: randomUUID(), path: root, boundAt: Date.now(), provenance: mode },
      ]);
      project.managedSince ||= task.shootingDate;
      await Promise.all([store.write("projects.json", projects), persist()]);
      await catalog.rebuild(engine.getAllTasks(), projects);
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
          main.webContents.send("existing:progress", {
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
      const projects = (
          await store.read<ProjectConfig[]>("projects.json", [])
        ).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      const preview = await previewExistingBackup(
        root,
        project,
        scope,
        selectedDate,
      );
      const candidates = preview.candidates;
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
      for (const task of tasks) engine.loadTask(task);
      const consolidated = consolidateProjectExistingRecords(projectId);
      project.boundRoots = deduplicateBoundRoots([
        ...(project.boundRoots || []),
        { id: randomUUID(), path: root, boundAt: Date.now(), provenance: mode },
      ]);
      project.managedSince ||= tasks
        .map((task) => task.shootingDate)
        .filter(Boolean)
        .sort()[0];
      await Promise.all([store.write("projects.json", projects), persist()]);
      await catalog.rebuild(engine.getAllTasks(), projects);
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
      const projects = (
          await store.read<ProjectConfig[]>("projects.json", [])
        ).map(normalizeProject),
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
      const
        rootsBefore = project.boundRoots || [],
        uniqueRoots = deduplicateBoundRoots(rootsBefore),
        rootsDeduplicated = rootsBefore.length - uniqueRoots.length;
      if (apply) {
        for (const duplicateId of [
          ...consolidated.duplicateIds,
          ...consolidated.aggregateIds,
        ])
          engine.deleteTask(duplicateId);
        project.boundRoots = uniqueRoots;
        await Promise.all([
          store.write("projects.json", projects),
          persist(),
        ]);
        await catalog.rebuild(engine.getAllTasks(), projects);
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
    async (taskId: string, jobId = randomUUID()) => {
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
          main.webContents.send("existing:progress", {
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
        await Promise.all([persist(), catalog.upsertTask(task)]);
        completedBytes = totalBytes;
        completedFiles = totalFiles;
        emit("completed", "首次哈希基线建立完成", undefined, true);
        return task;
      } catch (error) {
        task.status = "failed";
        task.errorMessage = String(error).replace(/^Error: /, "");
        await Promise.all([persist(), catalog.upsertTask(task)]);
        emit("failed", task.errorMessage, undefined, true);
        throw error;
      }
    },
  );
  handle(
    "existing:repair-manifest-missing",
    async (taskId: string, jobId = randomUUID()) => {
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
        targetRoot = await canonical(task.sourcePath);
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
          main.webContents.send("existing:progress", {
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
      emit("hashing", "正在预检健康副本，写入前逐文件核对清单", undefined, true);
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
        await Promise.all([persist(), catalog.upsertTask(task)]);
        emit("completed", `已补回 ${result.files} 个文件，准备完整重校验`, undefined, true);
        return result;
      } catch (error) {
        emit("failed", String(error).replace(/^Error: /, ""), undefined, true);
        throw error;
      }
    },
  );
  handle(
    "existing:reverify-manifest",
    async (taskId: string, jobId = randomUUID()) => {
      const task = engine.getTask(taskId);
      if (!task?.projectId || !task.externalManifest)
        throw new Error("接管素材卷或外部清单不存在");
      const projects = (
          await store.read<ProjectConfig[]>("projects.json", [])
        ).map(normalizeProject),
        project = projects.find((item) => item.id === task.projectId);
      if (!project) throw new Error("项目不存在");
      const preview = await previewExistingBackup(
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
          main.webContents.send("existing:progress", {
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
          verified.externalManifest.resolution = previousComparison.resolution;
        if (verified.status !== "completed") {
          if (
            verified.externalManifest &&
            previousComparison.resolution &&
            sameManifestDifferences(previousComparison, verified.externalManifest)
          )
            verified.externalManifest.resolution = previousComparison.resolution;
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
            log = task.verifyLog;
          Object.assign(task, verified, {
            id: originalId,
            createdAt: originalCreatedAt,
            verifyLog: [...log, ...verified.verifyLog].slice(-120),
          });
          await Promise.all([persist(), catalog.upsertTask(task)]);
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
          log = task.verifyLog;
        Object.assign(task, verified, {
          id: originalId,
          createdAt: originalCreatedAt,
          verifyLog: [...log, ...verified.verifyLog].slice(-120),
        });
        await Promise.all([persist(), catalog.upsertTask(task)]);
        completedBytes = totalBytes;
        completedFiles = totalFiles;
        emit("completed", "外部清单完整校验通过", undefined, true);
        return task;
      } catch (error) {
        emit("failed", String(error).replace(/^Error: /, ""), undefined, true);
        throw error;
      }
    },
  );
  handle("existing:accept-manifest-extra", async (taskId: string) => {
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
    comparison.resolution = {
      type: "accepted-extra",
      resolvedAt: Date.now(),
      note: "用户确认额外文件属于有效素材；保留外部清单差异，并以 Kocpy 首次哈希基线作为当前可信状态",
    };
    task.verifyLog = [...task.verifyLog, comparison.resolution.note].slice(-120);
    task.errorMessage = undefined;
    await Promise.all([persist(), catalog.upsertTask(task)]);
    return task;
  });
  handle(
    "existing:revise-manifest-missing",
    async (taskId: string, note: string, confirmation: string) => {
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
      if (!revised || revised.status === "mismatch" || revised.status === "unsupported")
        throw new Error("MHL 已保存审计副本，但修订结果仍有差异，请重新完整核对");
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
      await Promise.all([persist(), catalog.upsertTask(task)]);
      return result;
    },
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
        await fs
          .access(itemPath)
          .then(() => true, () => false)
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
    const root = await canonical(chosen.filePaths[0]),
      availability = await Promise.all(
        task.destinations.map((item) =>
          fs.access(item.resolvedPath || item.path).then(
            () => true,
            () => false,
          ),
        ),
      ),
      targetIndex = Math.max(
        0,
        availability.findIndex((value) => !value),
      );
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
    const identity = await volumeIdentity(root),
      destination = task.destinations[targetIndex];
    for (const item of task.fileRecords) {
      const copy = item.destinations[targetIndex];
      if (copy) {
        copy.path = await safeChild(root, item.relativePath);
        copy.checksum = item.srcChecksum;
        copy.verified = true;
      }
    }
    Object.assign(destination, {
      path: root,
      resolvedPath: root,
      volumeId: identity.id,
      volumeUuid: identity.uuid,
      volumeName: identity.name,
      verified: true,
      available: true,
      error: undefined,
    });
    await persist();
    await catalog.rebuild(
      engine.getAllTasks(),
      (await store.read<ProjectConfig[]>("projects.json", [])).map(
        normalizeProject,
      ),
    );
    return matched;
  });
  handle("system:open-path", async (file: string) => {
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return true;
  });
  handle("projects:coverage", (projectId: string) =>
    store.read<ProjectConfig[]>("projects.json", []).then((projects) => {
      const project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      return projectCoverage(project, engine.getAllTasks());
    }),
  );
  handle("projects:sign-checklist", async (projectId: string, run: any) => {
    const projects = (
        await store.read<ProjectConfig[]>("projects.json", [])
      ).map(normalizeProject),
      project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const valid = new Set(
      (project.checklists || [])
        .filter((item) => item.phase === run.phase)
        .map((item) => item.id),
    );
    run.completed = [
      ...new Set<string>((run.completed || []) as string[]),
    ].filter((id) => valid.has(id));
    run.id = run.id || randomUUID();
    run.signedAt = Date.now();
    project.checklistRuns = [
      ...(project.checklistRuns || []).filter((item) => item.id !== run.id),
      run,
    ].slice(-1000);
    await store.write("projects.json", projects);
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
    nasPresets = nasPresets.filter((item) => item.id !== id);
    await store.write("nas-presets.json", nasPresets);
    return nasPresets;
  });
  handle("nas:test", async (id: string) => {
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
    const project = (
      await store.read<ProjectConfig[]>("projects.json", [])
    ).find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const template = templateFromProject(project, name);
    const index = projectTemplates.findIndex((item) => item.id === template.id);
    if (index < 0) projectTemplates.push(template);
    else
      projectTemplates[index] = {
        ...template,
        createdAt: projectTemplates[index].createdAt,
      };
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:delete", async (id: string) => {
    projectTemplates = projectTemplates.filter((item) => item.id !== id);
    await store.write("project-templates.json", projectTemplates);
    return projectTemplates;
  });
  handle("templates:apply", async (templateId: string, projectId: string) => {
    const template = projectTemplates.find((item) => item.id === templateId);
    if (!template) throw new Error("模板不存在");
    const projects = (
        await store.read<ProjectConfig[]>("projects.json", [])
      ).map(normalizeProject),
      project = projects.find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    Object.assign(project, {
      devices: [...template.devices],
      volumePrefix: template.volumePrefix,
      requiredCopies: template.requiredCopies,
      namingRule: template.namingRule,
      completionActions: [...template.completionActions],
    });
    if ((project.destinationPaths?.length || 0) < template.requiredCopies)
      throw new Error(
        `模板要求 ${template.requiredCopies} 份副本，当前项目目的地不足`,
      );
    await store.write("projects.json", projects);
    return projects;
  });
  handle(
    "projects:add-handoff",
    async (projectId: string, operator: string, note: string) => {
      const projects = (
          await store.read<ProjectConfig[]>("projects.json", [])
        ).map(normalizeProject),
        project = projects.find((item) => item.id === projectId);
      if (!project) throw new Error("项目不存在");
      if (!note.trim()) throw new Error("请输入交接内容");
      project.handoffNotes = [
        ...(project.handoffNotes || []).slice(-199),
        {
          id: randomUUID(),
          at: Date.now(),
          operator: operator.trim() || "未署名",
          note: note.trim(),
        },
      ];
      await store.write("projects.json", projects);
      return projects;
    },
  );
  handle("workspace:export", async () => {
    const result = await dialog.showSaveDialog({
      defaultPath: `Kocpy_工作站配置_${Date.now()}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.filePath) return null;
    const projects = await store.read<ProjectConfig[]>("projects.json", []);
    const base = {
      schema: 1,
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
    const currentProjects = await store.read<ProjectConfig[]>(
        "projects.json",
        [],
      ),
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
    );
    await store.write("projects.json", merged.projects);
    for (const task of merged.tasks)
      if (!engine.getTask(task.id)) engine.loadTask(task);
    projectTemplates = [
      ...projectTemplates,
      ...(incoming.templates || []),
    ].filter(
      (item, index, all) =>
        all.findIndex((other) => other.id === item.id) === index,
    );
    healthRecords = [
      ...healthRecords,
      ...((incoming.healthRecords || []) as typeof healthRecords),
    ]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      )
      .slice(-500);
    archiveChanges = [...archiveChanges, ...(incoming.archiveChanges || [])]
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.id === item.id) === index,
      )
      .slice(-10000);
    await Promise.all([
      store.write("project-templates.json", projectTemplates),
      store.write("archive-health.json", healthRecords),
      store.write("archive-changes.json", archiveChanges),
      persist(),
    ]);
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
          schema: 1,
          version: app.getVersion(),
          createdAt: Date.now(),
          tasks: engine.getAllTasks(),
          projects: await store.read<ProjectConfig[]>("projects.json", []),
          settings: await store.read("settings.json", defaultSettings),
          proxyJobs,
          projectTemplates,
          healthRecords,
          benchmarkHistory,
          archiveChanges,
          archiveReminders,
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
    if (engine.hasActive() || proxyBusy) throw new Error("请等待当前任务结束");
    const projects = (
        await store.read<ProjectConfig[]>("projects.json", [])
      ).map(normalizeProject),
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
        schema: 1,
        application: "Kocpy",
        kind: "cold-archive",
        version: app.getVersion(),
        createdAt: Date.now(),
        project,
        tasks,
      },
      payload = { ...base, integrity: workspaceIntegrity(base) };
    await fs.writeFile(
      chosen.filePath,
      await gzipAsync(Buffer.from(JSON.stringify(payload))),
    );
    project.status = "archived";
    project.coldArchivedAt = Date.now();
    project.coldArchiveFile = chosen.filePath;
    for (const task of tasks) {
      engine.deleteTask(task.id);
      await catalog.deleteTask(task.id);
    }
    await Promise.all([
      store.write("projects.json", projects),
      catalog.upsertProject(project),
      persist(),
    ]);
    return chosen.filePath;
  });
  handle("workspace:restore-cold", async () => {
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Kocpy 冷归档", extensions: ["gz"] }],
    });
    if (chosen.canceled) return null;
    const parsed = JSON.parse(
      (await gunzipAsync(await fs.readFile(chosen.filePaths[0]))).toString(
        "utf8",
      ),
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
    const projects = (
        await store.read<ProjectConfig[]>("projects.json", [])
      ).map(normalizeProject),
      project = {
        ...parsed.project,
        status: "active",
        coldArchivedAt: undefined,
        coldArchiveFile: chosen.filePaths[0],
      },
      index = projects.findIndex((item) => item.id === project.id);
    if (index < 0) projects.push(project);
    else projects[index] = project;
    for (const task of parsed.tasks as BackupTask[]) {
      if (!engine.getTask(task.id)) engine.loadTask(task);
      await catalog.upsertTask(task);
    }
    await Promise.all([
      store.write("projects.json", projects),
      catalog.upsertProject(project),
      persist(),
    ]);
    return { project, tasks: parsed.tasks.length };
  });
  handle("lan:start", async () => {
    lanIndex.snapshot = async () => ({
      projects: await store.read<ProjectConfig[]>("projects.json", []),
      tasks: engine.getAllTasks(),
    });
    return lanIndex.start();
  });
  handle("lan:stop", () => lanIndex.stop());
  handle("lan:status", () => lanIndex.status());
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
    (await store.read<ProjectConfig[]>("projects.json", [])).map(
      normalizeProject,
    ),
  );
  handle("projects:inspect-structure", async (project: ProjectConfig) =>
    inspectProjectStructure(prepareProject(project)),
  );
  handle(
    "projects:save",
    async (value: ProjectConfig, createMissing = true) => {
      const project = prepareProject(value);
      if (
        (project.destinationPaths?.length || 0) < (project.requiredCopies || 2)
      )
        throw new Error(
          `项目要求 ${project.requiredCopies || 2} 份物理独立副本，请配置至少同等数量的目的地`,
        );
      if (createMissing) await createProjectStructure(project);
      const all = (await store.read<ProjectConfig[]>("projects.json", [])).map(
          normalizeProject,
        ),
        idx = all.findIndex((p) => p.id === project.id);
      if (idx < 0) all.push(project);
      else all[idx] = project;
      await store.write("projects.json", all);
      await catalog.upsertProject(project);
      return all;
    },
  );
  handle(
    "projects:claim-volume",
    async (projectId: string, device: string, prefixOverride?: string) => {
      const all = (await store.read<ProjectConfig[]>("projects.json", [])).map(
          normalizeProject,
        ),
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
      await store.write("projects.json", all);
      await catalog.upsertProject(project);
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
    const project = (
      await store.read<ProjectConfig[]>("projects.json", [])
    ).find((p) => p.id === projectId);
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
      const project = (await store.read<ProjectConfig[]>("projects.json", []))
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
            "拍摄日期,设备,机位,素材卷,文件数,素材大小,状态,通过目标,物理独立副本,项目要求副本",
            ...tasks.map((task) =>
              [
                task.shootingDate,
                task.devices.join("/"),
                task.cameraPosition,
                task.name,
                task.totalFiles,
                task.totalBytes,
                task.status,
                task.destinations.filter((destination) => destination.verified)
                  .length,
                verifiedPhysicalCopyCount(task),
                project.requiredCopies || 2,
              ]
                .map(cell)
                .join(","),
            ),
          ].join("\n")
        );
      };
      if (format === "bundle") {
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
              generateMhl(task),
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
      else if (format === "mhl")
        await fs.writeFile(r.filePath, generateMhl(task));
      else if (format === "ascmhl") {
        for (const record of task.fileRecords)
          if (!record.ascMhlMd5) {
            const readable =
              record.destinations.find((d) => d.verified && d.path)?.path ||
              path.join(task.sourcePath, record.relativePath);
            record.ascMhlMd5 = await hashFile(readable, "md5");
          }
        await fs.writeFile(r.filePath, generateAscMhl(task));
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
        now = Date.now();
      const preset: SavedProxyPreset = {
        id: existing?.id || randomUUID(),
        name,
        format: value.format === "prores" ? "prores" : "h264",
        resolution,
        bitrateMbps:
          value.bitrateMbps && value.bitrateMbps > 0
            ? Math.min(500, value.bitrateMbps)
            : undefined,
        container: ["mov", "mkv"].includes(value.container || "")
          ? (value.container as "mov" | "mkv")
          : "mp4",
        namingTemplate,
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
                      { taskId: task.id, relativePath: record.relativePath },
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
        const metadata = await inspectMedia(
            input,
            path.join(app.getPath("userData"), "thumbnails"),
          ).catch(() => ({}) as any),
          source = tracked.get(input)!;
        jobs.push({
          id: randomUUID(),
          input,
          name: path.basename(input),
          outputDir: out,
          format,
          resolution,
          bitrateMbps: options.bitrateMbps,
          container: options.container,
          preset:
            options.preset || (format === "prores" ? "editorial" : "review"),
          namingTemplate: options.namingTemplate || "{name}_proxy_{resolution}",
          sourceTaskId: source.taskId,
          sourceRelativePath: source.relativePath,
          status: "pending",
          progress: 0,
          createdAt: Date.now(),
          timecode: metadata.timecode,
          sourceFrameRate: metadata.frameRate,
          sourceAudio: metadata.audio,
          sourceDuration: metadata.duration,
          sourceColorSpace: metadata.colorSpace,
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
    else if (job.status === "pending") job.status = "cancelled";
    await persistProxyJobs();
    emitProxyJobs();
    return true;
  });
  handle("proxy:pause", async (id: string) => {
    const job = proxyJobs.find((item) => item.id === id);
    if (!job || job.status !== "running")
      throw new Error("只有正在转码的任务可以暂停");
    proxyPauseRequested = id;
    proxyController?.abort(new Error("用户暂停代理任务"));
    return true;
  });
  handle("proxy:resume", async (id: string) => {
    const job = proxyJobs.find((item) => item.id === id);
    if (!job || job.status !== "paused") throw new Error("该代理任务未暂停");
    Object.assign(job, { status: "pending", progress: 0, error: undefined });
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
      progress: 0,
      error: undefined,
      completedAt: undefined,
    });
    await persistProxyJobs();
    emitProxyJobs();
    void processProxyQueue();
    return true;
  });
  handle("proxy:delete", async (id: string) => {
    const job = proxyJobs.find((j) => j.id === id);
    if (!job || ["running", "pending"].includes(job.status))
      throw new Error("请先取消代理任务");
    proxyJobs = proxyJobs.filter((j) => j.id !== id);
    await persistProxyJobs();
    emitProxyJobs();
    return true;
  });
  handle(
    "proxy:export-delivery",
    async (format: "resolve" | "premiere" | "fcpxml" | "json") => {
      if (!["resolve", "premiere", "fcpxml", "json"].includes(format))
        throw new Error("不支持的交付格式");
      const extension =
          format === "fcpxml" ? "fcpxml" : format === "json" ? "json" : "csv",
        result = await dialog.showSaveDialog({
          defaultPath: `Kocpy_代理交付_${format}.${extension}`,
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        });
      if (!result.filePath) return null;
      await fs.writeFile(
        result.filePath,
        generateDeliveryManifest(proxyJobs, format),
        "utf8",
      );
      return result.filePath;
    },
  );
  handle("proxy:export-package", async () => {
    const completed = proxyJobs.filter(
      (job) => job.status === "completed" && job.outputPath,
    );
    if (!completed.length) throw new Error("没有可交付的已完成代理文件");
    const chosen = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (chosen.canceled) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const root = path.join(chosen.filePaths[0], `Kocpy_Delivery_${stamp}`),
      mediaDir = path.join(root, "Media");
    await fs.mkdir(mediaDir, { recursive: true });
    const checks = [];
    for (const job of completed) {
      const source = job.outputPath!,
        output = path.join(mediaDir, path.basename(source));
      await fs.copyFile(source, output);
      checks.push({
        jobId: job.id,
        sourceTaskId: job.sourceTaskId,
        sourceRelativePath: job.sourceRelativePath,
        file: path.relative(root, output),
        bytes: (await fs.stat(output)).size,
        sha256: await hashFile(output, "sha256"),
        validation: job.validation,
      });
    }
    await Promise.all([
      fs.writeFile(
        path.join(root, "Resolve.csv"),
        generateDeliveryManifest(completed, "resolve"),
        "utf8",
      ),
      fs.writeFile(
        path.join(root, "Premiere.csv"),
        generateDeliveryManifest(completed, "premiere"),
        "utf8",
      ),
      fs.writeFile(
        path.join(root, "FinalCut.fcpxml"),
        generateDeliveryManifest(completed, "fcpxml"),
        "utf8",
      ),
      fs.writeFile(
        path.join(root, "Delivery_Check.json"),
        JSON.stringify(
          {
            application: "Kocpy",
            version: app.getVersion(),
            generatedAt: Date.now(),
            files: checks,
          },
          null,
          2,
        ),
        "utf8",
      ),
    ]);
    return root;
  });
  engine.on("progress", (payload) => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const task = engine.getTask(payload.taskId);
      void Promise.all([
        persist(),
        task ? catalog.upsertTask(task) : Promise.resolve(),
      ]).catch(() => {});
    }, 1000);
    if (main && !main.isDestroyed())
      main.webContents.send("tasks:progress", payload);
    if (
      ["running", "paused", "verifying"].includes(payload.status) &&
      blocker === undefined
    )
      blocker = powerSaveBlocker.start("prevent-app-suspension");
  });
  engine.on("settled", async (task: BackupTask) => {
    clearTimeout(persistTimer);
    void persist().catch((e) =>
      dialog.showErrorBox("任务记录保存失败", String(e)),
    );
    void catalog.upsertTask(task).catch(() => {});
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
    if (task.status === "completed" && task.projectId)
      void (async () => {
        const project = (
            await store.read<ProjectConfig[]>("projects.json", [])
          ).find((item) => item.id === task.projectId),
          actions = project?.completionActions || [];
        if (!actions.length) return;
        const output = path.join(
          app.getPath("userData"),
          "completed-actions",
          project!.projectFolderName || project!.name,
          task.name,
        );
        await fs.mkdir(output, { recursive: true });
        if (actions.includes("report")) {
          const pdf = await htmlToPdf(
            await generateReport(task, { includeThumbnails: true }),
          );
          await fs.writeFile(
            path.join(output, `${task.name}_校验报告.pdf`),
            pdf,
          );
        }
        if (actions.includes("delivery"))
          await fs.writeFile(
            path.join(output, `${task.name}_交付清单.json`),
            JSON.stringify(
              {
                application: "Kocpy",
                version: app.getVersion(),
                task,
                generatedAt: Date.now(),
              },
              null,
              2,
            ),
          );
        if (actions.includes("proxy")) {
          const proxyOut = path.join(output, "Proxies");
          await fs.mkdir(proxyOut, { recursive: true });
          const video = /\.(mov|mp4|mxf|mts|m2ts|avi|mkv|r3d|braw)$/i;
          const jobs: ProxyJob[] = [];
          for (const record of task.fileRecords.filter((item) =>
            video.test(item.relativePath),
          )) {
            const copy = record.destinations.find((item) => item.verified);
            if (!copy) continue;
            jobs.push({
              id: randomUUID(),
              input: copy.path,
              name: path.basename(copy.path),
              outputDir: proxyOut,
              format: "h264",
              resolution: "1080p",
              container: "mp4",
              preset: "review",
              namingTemplate: "{name}_proxy_{resolution}",
              sourceTaskId: task.id,
              sourceRelativePath: record.relativePath,
              status: "pending",
              progress: 0,
              createdAt: Date.now(),
            });
          }
          proxyJobs.push(...jobs);
          await persistProxyJobs();
          emitProxyJobs();
          void processProxyQueue();
        }
        if (
          actions.includes("eject") &&
          task.destinations.every((item) => item.verified)
        )
          for (const destination of task.destinations)
            await ejectVolume(
              destination.resolvedPath || destination.path,
            ).catch(() => {});
      })().catch((error) => {
        task.faultTimeline = [
          ...(task.faultTimeline || []),
          {
            at: Date.now(),
            phase: "completion-action",
            level: "error",
            message: String(error),
          },
        ];
        void persist();
      });
  });
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
  if (engine.hasActive() || proxyBusy) {
    main?.show();
    dialog.showMessageBoxSync({
      type: "info",
      message: "仍有任务进行中",
      detail: "请先在工作台取消备份任务，或等待代理生成完成后退出。",
    });
    return;
  }
  void store
    .flush()
    .then(() => {
      quitReady = true;
      app.quit();
    })
    .catch((e) => dialog.showErrorBox("保存失败，暂未退出", String(e)));
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
