import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  powerSaveBlocker,
  Notification,
  nativeTheme,
} from "electron";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { promises as fs } from "node:fs";
import { BackupEngine, hashFile } from "./backup/BackupEngine";
import {
  scan,
  validatePaths,
  segment,
  inside,
  canonical,
} from "./backup/safety";
import { Storage, defaultSettings } from "./storage";
import { listVolumes, driveInfo, ejectVolume, volumeIdentity } from "./system";
import { makeProxy } from "./proxy";
import { inspectMedia, isThumbnailMedia } from "./media";
import { generateReport, generateDailyReport, generateProjectReport } from "./backup/ReportGenerator";
import { generateMhl, generateAscMhl } from "./backup/ManifestGenerator";
import type { ArchiveHealthRecord, BackupTask, ProjectConfig, ProjectTemplate, TaskConfig, ProxyJob } from "./types";
import { compareVersions, selectMacAsset, type GitHubRelease } from "./update";
import { claimTimestampedVolume, createProjectStructure, formatVolumeTimestamp, inspectProjectStructure, makeProjectFolderName } from "./project-path";
import { verifiedPhysicalCopyCount } from "./project-closeout";
import { benchmarkDirectory, buildDiagnosticSnapshot, type BenchmarkResult } from "./diagnostics";
import { generateDeliveryManifest } from "./delivery";
import { mergeWorkspace, sourceSuggestion, templateFromProject } from "./lifecycle";

app.setName("Kocpy");
const appDataRoot = app.getPath("appData");
const userDataPath = process.env.KOCPY_DATA_DIR || path.join(appDataRoot, "Kocpy");
app.setPath("userData", userDataPath);
if (!app.requestSingleInstanceLock()) app.exit(0);

const engine = new BackupEngine(path.join(app.getPath("userData"), "thumbnails")),
  store = new Storage(app.getPath("userData"));
const normalizeProject = (project: ProjectConfig): ProjectConfig => {
  const shootingDateStart = project.shootingDateStart || project.shootingDate || new Date().toLocaleDateString("sv-SE");
  const devices = project.devices?.length ? project.devices.slice(0, 10) : ["FX3"];
  return {
    ...project,
    devices,
    shootingDateStart,
    shootingDateEnd: project.shootingDateEnd || shootingDateStart,
    projectFolderName: project.projectFolderName || makeProjectFolderName(shootingDateStart, project.name),
    volumePrefixByDevice: Object.fromEntries(devices.map((device) => [device, project.volumePrefixByDevice?.[device] || project.volumePrefix || `${device}_`])),
    devicePositions: Object.fromEntries(devices.flatMap((device) => {
      const positions = (project.devicePositions?.[device] || []).filter((value) => /^[A-E]$/.test(value)).slice(0, 5);
      return positions.length ? [[device, positions]] : [];
    })),
    restDays: [...new Set(project.restDays || [])],
    unusedDevicesByDate: Object.fromEntries(Object.entries(project.unusedDevicesByDate || {}).map(([date, values]) => [date, [...new Set(values)].filter((device) => devices.includes(device))])),
    requiredCopies: Math.max(1, Math.min(4, project.requiredCopies || 2)),
  };
};
const prepareProject = (value: ProjectConfig): ProjectConfig => {
  const project = { ...value, devices: [...(value.devices || [])], destinationPaths: [...(value.destinationPaths || [])] };
  project.name = segment(project.name);
  if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
  if (project.shootingDateEnd && project.shootingDateEnd < project.shootingDateStart) throw new Error("项目结束日期不能早于开始日期");
  project.devices = [...new Set(project.devices.map(segment))].slice(0, 10);
  if (!project.devices.length) throw new Error("请至少选择一个设备或机位");
  if (!project.destinationPaths?.length || project.destinationPaths.length > 4 || project.destinationPaths.some((pathValue) => !path.isAbsolute(pathValue))) throw new Error("请选择 1–4 个有效备份根目录");
  project.projectFolderName = makeProjectFolderName(project.shootingDateStart, project.name);
  project.volumePrefixByDevice = Object.fromEntries(project.devices.map((device) => [device, segment(project.volumePrefixByDevice?.[device] || `${device}_`)]));
  project.devicePositions = Object.fromEntries(project.devices.flatMap((device) => {
    const positions = [...new Set(project.devicePositions?.[device] || [])].filter((position) => /^[A-E]$/.test(position)).slice(0, 5);
    return positions.length ? [[device, positions]] : [];
  }));
  project.restDays = [...new Set(project.restDays || [])];
  project.unusedDevicesByDate = Object.fromEntries(Object.entries(project.unusedDevicesByDate || {}).map(([date, values]) => [date, [...new Set(values)].filter((device) => project.devices.includes(device))]));
  project.requiredCopies = Math.max(1, Math.min(4, project.requiredCopies || 2));
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
let healthRecords: ArchiveHealthRecord[] = [], projectTemplates: ProjectTemplate[] = [];
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
const emitProxyJobs = () => { if (main && !main.isDestroyed()) main.webContents.send("proxy:jobs", proxyJobs); };
async function syncReport(file: string) {
  const settings = await store.read("settings.json", defaultSettings);
  if (!settings.reportSyncPath) return;
  await fs.mkdir(settings.reportSyncPath, { recursive: true });
  const target = path.join(settings.reportSyncPath, path.basename(file));
  if (path.resolve(target) !== path.resolve(file)) await fs.copyFile(file, target);
}
async function htmlToPdf(html: Buffer | string) {
  const report = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try { await report.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html.toString())); return await report.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.35, bottom: 0.35, left: 0.3, right: 0.3 } }); }
  finally { report.destroy(); }
}
async function processProxyQueue() {
  if (proxyBusy) return;
  const job = proxyJobs.find((j) => j.status === "pending"); if (!job) return;
  proxyBusy = true; proxyController = new AbortController(); Object.assign(job, { status: "running", progress: 0, startedAt: Date.now(), error: undefined });
  emitProxyJobs(); await persistProxyJobs(); const lock = powerSaveBlocker.start("prevent-app-suspension");
  try {
    const result = await makeProxy(job.input, job.outputDir, job.format, job.resolution, { signal: proxyController.signal, namingTemplate: job.namingTemplate, onProgress: (progress) => { job.progress = progress; emitProxyJobs(); } });
    const outputMetadata = await inspectMedia(result.outputPath, path.join(app.getPath("userData"), "thumbnails")).catch(() => ({} as any));
    const notes: string[] = [], frameRate = !job.sourceFrameRate || !outputMetadata.frameRate ? "unknown" : Math.abs(Number(job.sourceFrameRate) - Number(outputMetadata.frameRate)) < 0.02 ? "match" : "changed", timecode = !job.timecode || !outputMetadata.timecode ? "unknown" : job.timecode === outputMetadata.timecode ? "match" : "changed", audio = !job.sourceAudio ? "unknown" : outputMetadata.audio ? "present" : "missing";
    if (frameRate === "changed") notes.push(`帧率由 ${job.sourceFrameRate} 变为 ${outputMetadata.frameRate}`); if (timecode === "changed") notes.push("输出时间码与源素材不同"); if (audio === "missing") notes.push("源素材包含音轨，但代理未检测到音轨");
    Object.assign(job, { status: "completed", progress: 100, outputPath: result.outputPath, completedAt: Date.now(), validation: { frameRate, timecode, audio, notes } });
  } catch (e: any) { const paused = proxyPauseRequested === job.id; Object.assign(job, { status: paused ? "paused" : proxyController.signal.aborted ? "cancelled" : "failed", error: paused ? undefined : e.message || String(e), completedAt: paused ? undefined : Date.now() }); }
  finally { proxyBusy = false; proxyController = undefined; proxyPauseRequested = undefined; powerSaveBlocker.stop(lock); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); }
}
function createWindow() {
  main = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
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
  nativeTheme.themeSource = initialSettings.theme === "light" ? "light" : "dark";
  proxyJobs = await store.read<ProxyJob[]>("proxy-jobs.json", []);
  benchmarkHistory = await store.read<BenchmarkResult[]>("benchmarks.json", []);
  healthRecords = await store.read<ArchiveHealthRecord[]>("archive-health.json", []);
  projectTemplates = await store.read<ProjectTemplate[]>("project-templates.json", []);
  for (const job of proxyJobs) if (job.status === "running") { job.status = "failed"; job.error = "上次转码被中断，可点击重试"; }
  const saved = await store.read<BackupTask[]>("tasks.json", []);
  for (const task of saved) {
    if (["pending", "running", "paused", "verifying"].includes(task.status)) {
      task.status = "failed";
      task.errorMessage = "上次运行中断。可重新执行并重新校验已有文件。";
    }
    engine.loadTask(task);
  }
  await persist();
  handle("dialog:directory", async (defaultPath?: string) => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath && path.isAbsolute(defaultPath) ? defaultPath : undefined,
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("tasks:list", () => engine.getAllTasks());
  handle("tasks:create", async (config: TaskConfig) => {
    await validatePaths(config.sourcePath, config.destinationPaths);
    const sourceIdentity = await volumeIdentity(config.sourcePath);
    const destinationIdentities = await Promise.all(config.destinationPaths.map((destination) => volumeIdentity(destination)));
    if (config.projectId) {
      const project = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject).find((item) => item.id === config.projectId);
      if (!project) throw new Error("拍摄项目不存在");
      const required = project.requiredCopies || 2;
      if (destinationIdentities.length < required || new Set(destinationIdentities.map((identity) => identity.uuid || identity.id)).size < required) throw new Error(`项目要求 ${required} 份物理独立副本，请选择位于不同磁盘的目的地`);
    }
    const task = engine.createTask(config);
    task.sourceVolumeId = sourceIdentity.id;
    task.sourceVolumeUuid = sourceIdentity.uuid;
    task.sourceVolumeName = sourceIdentity.name;
    await Promise.all(task.destinations.map(async (destination, index) => {
      const identity = destinationIdentities[index];
      destination.volumeId = identity.id;
      destination.volumeUuid = identity.uuid;
      destination.volumeName = identity.name;
    }));
    await persist();
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
  handle("tasks:pause", async (id: string) => { engine.pauseTask(id); await persist(); return true; });
  handle("tasks:resume", async (id: string) => { engine.resumeTask(id); await persist(); return true; });
  handle("tasks:reverify", async (id: string) => { const result = await engine.reverifyTask(id); await persist(); return result; });
  handle("tasks:retry-failed", async (id: string) => { engine.retryFailedDestinations(id); await persist(); return true; });
  handle("tasks:delete", (id: string) => {
    engine.deleteTask(id);
    return persist();
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
    const breakdown = Object.fromEntries((["video", "photo", "audio", "other"] as const).map((kind) => [kind, { files: 0, bytes: 0 }])) as Record<"video" | "photo" | "audio" | "other", { files: number; bytes: number }>;
    for (const file of r.files) { const kind = /\.(mov|mp4|mxf|mkv|avi|m4v|r3d|braw)$/i.test(file.name) ? "video" : /\.(jpg|jpeg|png|heic|tif|tiff|dng|arw|cr2|cr3|nef|raf)$/i.test(file.name) ? "photo" : /\.(wav|mp3|aac|flac|aif|aiff)$/i.test(file.name) ? "audio" : "other"; breakdown[kind].files++; breakdown[kind].bytes += file.size; }
    return {
      totalFiles: r.files.length,
      totalBytes: r.totalBytes,
      skipped: r.skipped,
      sample: r.files.slice(0, 6).map((f) => f.relativePath),
      breakdown,
      suggestion: sourceSuggestion(engine.getAllTasks(), { volumeId: await volumeIdentity(source).then((identity) => identity.uuid || identity.id, () => undefined), files: r.files.map((file) => ({ relativePath: file.relativePath, size: file.size })) }),
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
    if (proxyJobs.some((job) => ["pending", "running"].includes(job.status) && (inside(job.input, volume) || inside(job.outputDir, volume))))
      throw new Error("该磁盘有等待中或进行中的代理任务，请先取消任务");
    return ejectVolume(volume);
  });
  handle("volumes:eject-completed", async () => {
    const volumes = await listVolumes(), results: Array<{ path: string; ok: boolean; error?: string }> = [];
    for (const volume of volumes.filter((item) => item.canEject)) {
      const unsafe = engine.getAllTasks().some((task) => ["running", "paused", "verifying", "pending"].includes(task.status) && (inside(task.sourcePath, volume.path) || task.destinations.some((destination) => inside(destination.path, volume.path))));
      if (unsafe) { results.push({ path: volume.path, ok: false, error: "仍有进行中任务" }); continue; }
      if (proxyJobs.some((job) => ["pending", "running"].includes(job.status) && (inside(job.input, volume.path) || inside(job.outputDir, volume.path)))) { results.push({ path: volume.path, ok: false, error: "仍有代理任务正在使用" }); continue; }
      const related = engine.getAllTasks().filter((task) => inside(task.sourcePath, volume.path) || task.destinations.some((destination) => inside(destination.path, volume.path)));
      const complete = related.filter((task) => task.status === "completed" && task.destinations.every((destination) => destination.verified));
      const uncovered = related.filter((task) => ["failed", "cancelled"].includes(task.status)).some((task) => !complete.some((candidate) => (candidate.createdAt || 0) >= (task.createdAt || 0) && (candidate.sourceVolumeUuid && candidate.sourceVolumeUuid === task.sourceVolumeUuid || candidate.sourcePath === task.sourcePath)));
      if (!related.length || !complete.length || uncovered) { results.push({ path: volume.path, ok: false, error: uncovered ? "存在尚未被后续成功备份覆盖的失败任务" : "没有完整且通过校验的备份记录" }); continue; }
      try { await ejectVolume(volume.path); results.push({ path: volume.path, ok: true }); } catch (error: any) { results.push({ path: volume.path, ok: false, error: error.message || String(error) }); }
    }
    return results;
  });
  const diagnosticSnapshot = async () => buildDiagnosticSnapshot({ version: app.getVersion(), tasks: engine.getAllTasks(), volumes: await listVolumes(), benchmarks: benchmarkHistory });
  handle("diagnostics:benchmark", async (directory: string, sizeMiB = 64) => {
    if (!path.isAbsolute(directory)) throw new Error("请选择有效的性能预检目录");
    if (engine.hasActive() || proxyBusy) throw new Error("请在没有备份或代理任务运行时执行性能预检");
    const result = await benchmarkDirectory(directory, sizeMiB);
    benchmarkHistory = [...benchmarkHistory.slice(-19), result];
    await store.write("benchmarks.json", benchmarkHistory);
    return result;
  });
  handle("diagnostics:get", diagnosticSnapshot);
  handle("diagnostics:export", async () => {
    const result = await dialog.showSaveDialog({ defaultPath: `Kocpy_诊断包_${new Date().toLocaleDateString("sv-SE")}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!result.filePath) return null;
    await fs.writeFile(result.filePath, JSON.stringify(await diagnosticSnapshot(), null, 2), "utf8");
    return result.filePath;
  });
  handle("archive:health-list", () => healthRecords);
  handle("archive:verify-project", async (projectId: string) => {
    if (engine.hasActive() || proxyBusy) throw new Error("请等待当前备份或代理任务结束");
    const tasks = engine.getAllTasks().filter((task) => task.projectId === projectId && task.fileRecords.length), notes: string[] = [];
    if (!tasks.length) throw new Error("项目没有可复校验的素材记录");
    let healthyTasks = 0, missingCopies = 0;
    for (const task of tasks) { try { await engine.reverifyTask(task.id); if (task.status === "completed") healthyTasks++; else notes.push(`${task.name} 未通过复校验`); } catch (error: any) { notes.push(`${task.name}：${error.message || String(error)}`); } missingCopies += task.destinations.filter((destination) => !destination.verified).length; }
    const record: ArchiveHealthRecord = { id: randomUUID(), projectId, checkedAt: Date.now(), taskCount: tasks.length, healthyTasks, failedTasks: tasks.length - healthyTasks, missingCopies, notes };
    healthRecords = [...healthRecords.slice(-199), record]; await store.write("archive-health.json", healthRecords); await persist(); return record;
  });
  handle("archive:repair-copy", async (taskId: string, destinationId: string) => {
    if (engine.hasActive() || proxyBusy) throw new Error("请等待当前任务结束");
    const task = engine.getTask(taskId); if (!task) throw new Error("任务不存在"); const target = task.destinations.find((destination) => destination.id === destinationId); if (!target) throw new Error("目标副本不存在");
    let repaired = 0;
    for (const record of task.fileRecords) {
      const targetRecord = record.destinations.find((entry) => inside(entry.path, target.resolvedPath || target.path)); if (!targetRecord || targetRecord.verified) continue;
      const healthy = record.destinations.find((entry) => entry.verified && entry.path !== targetRecord.path); if (!healthy) throw new Error(`${record.relativePath} 没有可用于修复的健康副本`);
      const partial = `${targetRecord.path}.kocpy-repair.partial`; await fs.mkdir(path.dirname(targetRecord.path), { recursive: true }); await fs.copyFile(healthy.path, partial);
      if (await hashFile(partial, task.hashAlgorithm) !== record.srcChecksum) { await fs.unlink(partial).catch(() => {}); throw new Error(`${record.relativePath} 修复副本校验失败`); }
      const exists = await fs.access(targetRecord.path).then(() => true, () => false); if (exists) await fs.rename(targetRecord.path, `${targetRecord.path}.kocpy-damaged-${Date.now()}`); await fs.rename(partial, targetRecord.path); targetRecord.verified = true; targetRecord.checksum = record.srcChecksum; repaired++;
    }
    target.verified = task.fileRecords.every((record) => record.destinations.filter((entry) => inside(entry.path, target.resolvedPath || target.path)).every((entry) => entry.verified)); target.error = undefined; await persist(); return { repaired, preservedDamagedOriginals: repaired };
  });
  handle("templates:list", () => projectTemplates);
  handle("templates:from-project", async (projectId: string, name?: string) => { const project = (await store.read<ProjectConfig[]>("projects.json", [])).find((item) => item.id === projectId); if (!project) throw new Error("项目不存在"); const template = templateFromProject(project, name); const index = projectTemplates.findIndex((item) => item.id === template.id); if (index < 0) projectTemplates.push(template); else projectTemplates[index] = { ...template, createdAt: projectTemplates[index].createdAt }; await store.write("project-templates.json", projectTemplates); return projectTemplates; });
  handle("templates:delete", async (id: string) => { projectTemplates = projectTemplates.filter((item) => item.id !== id); await store.write("project-templates.json", projectTemplates); return projectTemplates; });
  handle("templates:apply", async (templateId: string, projectId: string) => { const template = projectTemplates.find((item) => item.id === templateId); if (!template) throw new Error("模板不存在"); const projects = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject), project = projects.find((item) => item.id === projectId); if (!project) throw new Error("项目不存在"); Object.assign(project, { devices: [...template.devices], volumePrefix: template.volumePrefix, requiredCopies: template.requiredCopies, namingRule: template.namingRule, completionActions: [...template.completionActions] }); if ((project.destinationPaths?.length || 0) < template.requiredCopies) throw new Error(`模板要求 ${template.requiredCopies} 份副本，当前项目目的地不足`); await store.write("projects.json", projects); return projects; });
  handle("projects:add-handoff", async (projectId: string, operator: string, note: string) => { const projects = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject), project = projects.find((item) => item.id === projectId); if (!project) throw new Error("项目不存在"); if (!note.trim()) throw new Error("请输入交接内容"); project.handoffNotes = [...(project.handoffNotes || []).slice(-199), { id: randomUUID(), at: Date.now(), operator: operator.trim() || "未署名", note: note.trim() }]; await store.write("projects.json", projects); return projects; });
  handle("workspace:export", async () => { const result = await dialog.showSaveDialog({ defaultPath: `Kocpy_工作站配置_${Date.now()}.json`, filters: [{ name: "JSON", extensions: ["json"] }] }); if (!result.filePath) return null; const projects = await store.read<ProjectConfig[]>("projects.json", []); const payload = { schema: 1, application: "Kocpy", version: app.getVersion(), workstation: createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12), exportedAt: Date.now(), projects, tasks: engine.getAllTasks(), templates: projectTemplates, healthRecords }; await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), "utf8"); return result.filePath; });
  handle("workspace:import", async () => { const chosen = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Kocpy 工作站配置", extensions: ["json"] }] }); if (chosen.canceled) return null; const incoming = JSON.parse(await fs.readFile(chosen.filePaths[0], "utf8")); if (incoming.application !== "Kocpy" || incoming.schema !== 1) throw new Error("不是受支持的 Kocpy 工作站配置包"); const currentProjects = await store.read<ProjectConfig[]>("projects.json", []), merged = mergeWorkspace({ projects: currentProjects, tasks: engine.getAllTasks() }, incoming); await store.write("projects.json", merged.projects); for (const task of merged.tasks) if (!engine.getTask(task.id)) engine.loadTask(task); projectTemplates = [...projectTemplates, ...(incoming.templates || [])].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index); healthRecords = [...healthRecords, ...(incoming.healthRecords || [])].filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index).slice(-500); await Promise.all([store.write("project-templates.json", projectTemplates), store.write("archive-health.json", healthRecords), persist()]); return merged.result; });
  handle("workspace:backup-data", async () => { const result = await dialog.showSaveDialog({ defaultPath: `Kocpy_本地数据备份_${Date.now()}.json`, filters: [{ name: "JSON", extensions: ["json"] }] }); if (!result.filePath) return null; await fs.writeFile(result.filePath, JSON.stringify({ schema: 1, version: app.getVersion(), createdAt: Date.now(), tasks: engine.getAllTasks(), projects: await store.read<ProjectConfig[]>("projects.json", []), settings: await store.read("settings.json", defaultSettings), proxyJobs, projectTemplates, healthRecords, benchmarkHistory }, null, 2), "utf8"); return result.filePath; });
  handle("system:reveal", (file: string) => shell.showItemInFolder(file));
  handle("updates:check", async () => {
    const response = await fetch("https://api.github.com/repos/sexyfeifan/Kocpy/releases/latest", { headers: { "Accept": "application/vnd.github+json", "User-Agent": `Kocpy/${app.getVersion()}` } });
    if (!response.ok) throw new Error(`更新检查失败（HTTP ${response.status}）`);
    const release = await response.json() as GitHubRelease, latest = String(release.tag_name || "").replace(/^v/, ""), current = app.getVersion();
    if (!latest || !release.html_url) throw new Error("GitHub Release 没有可用版本");
    const asset = selectMacAsset(release, process.arch);
    return { current, latest, available: compareVersions(latest, current) > 0, releaseUrl: release.html_url, ...asset };
  });
  handle("updates:open", (url: string) => { if (!/^https:\/\/github\.com\/sexyfeifan\/Kocpy\/releases(?:\/(?:tag|download)\/.*)?$/.test(url)) throw new Error("无效更新地址"); return shell.openExternal(url); });
  handle("system:open-author", (url: string) => {
    const allowed = new Set(["https://github.com/sexyfeifan", "https://www.xiaohongshu.com/user/profile/5d24d2ca000000001103fe97"]);
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
  handle("projects:list", async () => (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject));
  handle("projects:inspect-structure", async (project: ProjectConfig) => inspectProjectStructure(prepareProject(project)));
  handle("projects:save", async (value: ProjectConfig, createMissing = true) => {
    const project = prepareProject(value);
    if ((project.destinationPaths?.length || 0) < (project.requiredCopies || 2)) throw new Error(`项目要求 ${project.requiredCopies || 2} 份物理独立副本，请配置至少同等数量的目的地`);
    if (createMissing) await createProjectStructure(project);
    const all = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject),
      idx = all.findIndex((p) => p.id === project.id);
    if (idx < 0) all.push(project);
    else all[idx] = project;
    await store.write("projects.json", all);
    return all;
  });
  handle("projects:claim-volume", async (projectId: string, device: string, prefixOverride?: string) => {
    const all = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject), project = all.find((p) => p.id === projectId);
    if (!project) throw new Error("项目不存在");
    if (!project.devices.includes(device)) throw new Error("所选设备不属于当前项目");
    const timestamp = formatVolumeTimestamp();
    project.lastVolumeTimestampByDevice ||= {};
    project.volumeTimestampCollisionByDevice ||= {};
    const configuredPrefix = project.volumePrefixByDevice?.[device] || project.volumePrefix || `${device}_`;
    const cleanOverride = prefixOverride?.trim() ? segment(prefixOverride) : "";
    const prefix = cleanOverride ? (cleanOverride.endsWith("_") ? cleanOverride : `${cleanOverride}_`) : configuredPrefix;
    const claimed = claimTimestampedVolume(prefix, timestamp, project.lastVolumeTimestampByDevice[device], project.volumeTimestampCollisionByDevice[device]);
    project.lastVolumeTimestampByDevice[device] = timestamp;
    project.volumeTimestampCollisionByDevice[device] = claimed.collision;
    await store.write("projects.json", all);
    return { ...claimed, timestamp, prefix, project };
  });
  handle("report:daily", async (shootingDate: string, projectId?: string) => {
    const tasks = engine.getAllTasks().filter((t) => (!projectId || t.projectId === projectId) && (t.shootingDate || new Date(t.completedAt || t.createdAt || 0).toLocaleDateString("sv-SE")) === shootingDate);
    if (!tasks.length) throw new Error("所选拍摄日没有可汇总的任务");
    const project = (await store.read<ProjectConfig[]>("projects.json", [])).find((p) => p.id === projectId);
    const r = await dialog.showSaveDialog({ defaultPath: `Kocpy_${project?.name || "全部项目"}_${shootingDate}_汇总.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!r.filePath) return null;
    const report = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await report.loadURL("data:text/html;charset=utf-8," + encodeURIComponent((await generateDailyReport(tasks, shootingDate, project?.name)).toString())); const pdf = await report.webContents.printToPDF({ printBackground: true, pageSize: "A4", margins: { top: 0.35, bottom: 0.35, left: 0.3, right: 0.3 } }); await fs.writeFile(r.filePath, pdf); }
    finally { report.destroy(); }
    await syncReport(r.filePath);
    return r.filePath;
  });
  handle("report:project", async (projectId: string, format: "pdf" | "json" | "csv" | "bundle") => {
    const project = (await store.read<ProjectConfig[]>("projects.json", [])).map(normalizeProject).find((item) => item.id === projectId);
    if (!project) throw new Error("项目不存在");
    const tasks = engine.getAllTasks().filter((task) => task.projectId === projectId);
    if (!tasks.length) throw new Error("当前项目还没有可导出的备份记录");
    const csv = () => { const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`; return "\ufeff" + ["拍摄日期,设备,机位,素材卷,文件数,素材大小,状态,通过目标,物理独立副本,项目要求副本", ...tasks.map((task) => [task.shootingDate, task.devices.join("/"), task.cameraPosition, task.name, task.totalFiles, task.totalBytes, task.status, task.destinations.filter((destination) => destination.verified).length, verifiedPhysicalCopyCount(task), project.requiredCopies || 2].map(cell).join(","))].join("\n"); };
    if (format === "bundle") {
      const chosen = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] }); if (chosen.canceled) return null;
      const folder = path.join(chosen.filePaths[0], `Kocpy_${segment(project.name)}_项目归档包_${Date.now()}`); await fs.mkdir(folder, { recursive: true });
      const archiveFiles = ["项目完整报告.pdf", "项目完整数据.json", "项目素材统计.csv", ...tasks.map((task) => `${segment(task.name)}_${task.id.slice(0, 6)}.mhl`)];
      await Promise.all([
        fs.writeFile(path.join(folder, "项目完整报告.pdf"), await htmlToPdf(await generateProjectReport(project, tasks))),
        fs.writeFile(path.join(folder, "项目完整数据.json"), JSON.stringify({ generatedAt: new Date().toISOString(), project, tasks }, null, 2)),
        fs.writeFile(path.join(folder, "项目素材统计.csv"), csv()),
        ...tasks.map((task) => fs.writeFile(path.join(folder, `${segment(task.name)}_${task.id.slice(0, 6)}.mhl`), generateMhl(task))),
      ]);
      const checksums = await Promise.all(archiveFiles.map(async (name) => `${await hashFile(path.join(folder, name), "sha256")}  ${name}`));
      await fs.writeFile(path.join(folder, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
      return folder;
    }
    const extension = format;
    const result = await dialog.showSaveDialog({ defaultPath: `Kocpy_${project.name}_项目完整报告.${extension}`, filters: [{ name: format.toUpperCase(), extensions: [extension] }] });
    if (!result.filePath) return null;
    if (format === "json") await fs.writeFile(result.filePath, JSON.stringify({ generatedAt: new Date().toISOString(), project, tasks }, null, 2));
    else if (format === "csv") await fs.writeFile(result.filePath, csv());
    else await fs.writeFile(result.filePath, await htmlToPdf(await generateProjectReport(project, tasks)));
    await syncReport(result.filePath);
    return result.filePath;
  });
  handle("report:resolve-csv", async (shootingDate: string, projectId?: string) => {
    const tasks = engine.getAllTasks().filter((t) => (!projectId || t.projectId === projectId) && (t.shootingDate || new Date(t.completedAt || t.createdAt || 0).toLocaleDateString("sv-SE")) === shootingDate);
    const videos = tasks.flatMap((task) => task.fileRecords.filter((file) => /\.(mov|mp4|mxf|mkv|avi|m4v)$/i.test(file.name)).map((file) => ({ task, file, mediaPath: file.destinations.find((destination) => destination.verified && destination.path)?.path }))).filter((row) => row.mediaPath);
    if (!videos.length) throw new Error("所选拍摄日没有已校验的视频素材");
    const result = await dialog.showSaveDialog({ defaultPath: `Kocpy_${shootingDate}_Resolve媒体池.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!result.filePath) return null;
    const cell = (value: unknown) => { const raw = String(value ?? ""); const safe = /^[=+@-]/.test(raw) ? "'" + raw : raw; return '"' + safe.replace(/"/g, '""') + '"'; };
    const rows = ["Media Path,Clip Name,Reel,Camera,Shooting Date,Kocpy Task"];
    for (const row of videos) {
      const metadata = await inspectMedia(row.mediaPath!, path.join(app.getPath("userData"), "thumbnails")).catch(() => ({} as any));
      rows.push([row.mediaPath, row.file.name, row.task.devices[0] || "", metadata.camera || "", row.task.shootingDate || shootingDate, row.task.name].map(cell).join(","));
    }
    await fs.writeFile(result.filePath, "\ufeff" + rows.join("\n"), "utf8");
    await syncReport(result.filePath);
    return result.filePath;
  });
  handle("report:export", async (id: string, format: "pdf" | "json" | "mhl" | "ascmhl") => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    if (["pending", "running", "paused", "verifying"].includes(task.status))
      throw new Error("任务结束后才能导出完整报告");
    const r = await dialog.showSaveDialog({
      defaultPath: `Kocpy_${task.name}_${id.slice(0, 6)}${format === "ascmhl" ? "_ASC.mhl" : `.${format}`}`,
      filters: [{ name: format.toUpperCase(), extensions: [format === "ascmhl" ? "mhl" : format] }],
    });
    if (!r.filePath) return null;
    if (format === "json")
      await fs.writeFile(r.filePath, JSON.stringify(task, null, 2));
    else if (format === "mhl") await fs.writeFile(r.filePath, generateMhl(task));
    else if (format === "ascmhl") {
      for (const record of task.fileRecords) if (!record.ascMhlMd5) {
        const readable = record.destinations.find((d) => d.verified && d.path)?.path || path.join(task.sourcePath, record.relativePath);
        record.ascMhlMd5 = await hashFile(readable, "md5");
      }
      await fs.writeFile(r.filePath, generateAscMhl(task)); await persist();
    }
    else {
      for (const record of task.fileRecords) {
        if (record.thumbnailPath || !isThumbnailMedia(record.name)) continue;
        const readable = record.destinations.find((destination) => destination.verified && destination.path)?.path;
        if (!readable) continue;
        record.thumbnailPath = await inspectMedia(readable, path.join(app.getPath("userData"), "thumbnails")).then((media) => media.thumbnailPath, () => undefined);
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
            encodeURIComponent((await generateReport(task, { includeThumbnails: true })).toString()),
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
  });
  handle("media:inspect", async (input: string) => {
    const tracked = engine.getAllTasks().flatMap((t) => t.fileRecords).some((f) => f.destinations.some((d) => d.path === input && d.verified));
    if (!tracked) throw new Error("只能预览已校验的素材副本");
    return inspectMedia(input, path.join(app.getPath("userData"), "thumbnails"));
  });
  handle("proxy:list", () => proxyJobs);
  handle("proxy:enqueue", async (inputs: string[], out: string, format: "h264" | "prores", resolution: "1080p" | "720p", options: { preset?: "review" | "editorial" | "offline"; namingTemplate?: string } = {}) => {
    if (!inputs.length) throw new Error("请选择至少一个视频");
    const canonicalOut = await canonical(out);
    for (const task of engine.getAllTasks()) if (inside(canonicalOut, await canonical(task.sourcePath))) throw new Error("代理不能写入素材源目录");
    const tracked = new Map(engine.getAllTasks().flatMap((task) => task.fileRecords.flatMap((record) => record.destinations.filter((destination) => destination.verified).map((destination) => [destination.path, { taskId: task.id, relativePath: record.relativePath }] as const))));
    for (const input of inputs) if (!tracked.has(input)) throw new Error("只能为已校验的备份文件生成代理");
    const jobs = await Promise.all(inputs.map(async (input): Promise<ProxyJob> => { const metadata = await inspectMedia(input, path.join(app.getPath("userData"), "thumbnails")).catch(() => ({} as any)), source = tracked.get(input)!; return { id: randomUUID(), input, name: path.basename(input), outputDir: out, format, resolution, preset: options.preset || (format === "prores" ? "editorial" : "review"), namingTemplate: options.namingTemplate || "{name}_proxy_{resolution}", sourceTaskId: source.taskId, sourceRelativePath: source.relativePath, status: "pending", progress: 0, createdAt: Date.now(), timecode: metadata.timecode, sourceFrameRate: metadata.frameRate, sourceAudio: metadata.audio }; }));
    proxyJobs.push(...jobs); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); return jobs;
  });
  handle("proxy:cancel", async (id?: string) => { const job = id ? proxyJobs.find((j) => j.id === id) : proxyJobs.find((j) => j.status === "running"); if (!job) return false; if (job.status === "running") proxyController?.abort(new Error("用户取消代理任务")); else if (job.status === "pending") job.status = "cancelled"; await persistProxyJobs(); emitProxyJobs(); return true; });
  handle("proxy:pause", async (id: string) => { const job = proxyJobs.find((item) => item.id === id); if (!job || job.status !== "running") throw new Error("只有正在转码的任务可以暂停"); proxyPauseRequested = id; proxyController?.abort(new Error("用户暂停代理任务")); return true; });
  handle("proxy:resume", async (id: string) => { const job = proxyJobs.find((item) => item.id === id); if (!job || job.status !== "paused") throw new Error("该代理任务未暂停"); Object.assign(job, { status: "pending", progress: 0, error: undefined }); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); return true; });
  handle("proxy:retry", async (id: string) => { const job = proxyJobs.find((j) => j.id === id); if (!job || !["failed", "cancelled"].includes(job.status)) throw new Error("该任务不能重试"); Object.assign(job, { status: "pending", progress: 0, error: undefined, completedAt: undefined }); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); return true; });
  handle("proxy:delete", async (id: string) => { const job = proxyJobs.find((j) => j.id === id); if (!job || ["running", "pending"].includes(job.status)) throw new Error("请先取消代理任务"); proxyJobs = proxyJobs.filter((j) => j.id !== id); await persistProxyJobs(); emitProxyJobs(); return true; });
  handle("proxy:export-delivery", async (format: "resolve" | "premiere" | "fcpxml" | "json") => {
    if (!["resolve", "premiere", "fcpxml", "json"].includes(format)) throw new Error("不支持的交付格式");
    const extension = format === "fcpxml" ? "fcpxml" : format === "json" ? "json" : "csv", result = await dialog.showSaveDialog({ defaultPath: `Kocpy_代理交付_${format}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!result.filePath) return null; await fs.writeFile(result.filePath, generateDeliveryManifest(proxyJobs, format), "utf8"); return result.filePath;
  });
  engine.on("progress", (payload) => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void persist().catch(() => {}), 1000);
    if (main && !main.isDestroyed())
      main.webContents.send("tasks:progress", payload);
    if (
      ["running", "paused", "verifying"].includes(payload.status) &&
      blocker === undefined
    )
      blocker = powerSaveBlocker.start("prevent-app-suspension");
  });
  engine.on("settled", (task: BackupTask) => {
    clearTimeout(persistTimer);
    void persist().catch((e) =>
      dialog.showErrorBox("任务记录保存失败", String(e)),
    );
    if (blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
    if (main && !main.isDestroyed()) main.webContents.send("tasks:settled", task);
    if (task.status === "completed" && Notification.isSupported()) {
      const passed = task.destinations.filter((destination) => destination.verified).length;
      new Notification({
        title: "备份与校验完成",
        body: `${task.name} · ${task.totalFiles} 个文件 · ${passed} 个目标通过校验`,
        silent: false,
      }).show();
    }
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
  emitProxyJobs(); void processProxyQueue();
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
