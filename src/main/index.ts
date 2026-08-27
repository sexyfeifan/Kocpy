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
import { randomUUID } from "node:crypto";
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
import { generateReport, generateDailyReport } from "./backup/ReportGenerator";
import { generateMhl, generateAscMhl } from "./backup/ManifestGenerator";
import type { BackupTask, ProjectConfig, TaskConfig, ProxyJob } from "./types";
import { compareVersions, selectMacAsset, type GitHubRelease } from "./update";
import { claimTimestampedVolume, createProjectDateFolders, formatVolumeTimestamp, makeProjectFolderName } from "./project-path";

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
  };
};
let main: BrowserWindow | null = null,
  persistTimer: ReturnType<typeof setTimeout> | undefined,
  quitReady = false,
  blocker: number | undefined,
  proxyBusy = false,
  proxyController: AbortController | undefined,
  proxyJobs: ProxyJob[] = [];
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
async function processProxyQueue() {
  if (proxyBusy) return;
  const job = proxyJobs.find((j) => j.status === "pending"); if (!job) return;
  proxyBusy = true; proxyController = new AbortController(); Object.assign(job, { status: "running", progress: 0, startedAt: Date.now(), error: undefined });
  emitProxyJobs(); await persistProxyJobs(); const lock = powerSaveBlocker.start("prevent-app-suspension");
  try {
    const result = await makeProxy(job.input, job.outputDir, job.format, job.resolution, { signal: proxyController.signal, onProgress: (progress) => { job.progress = progress; emitProxyJobs(); } });
    Object.assign(job, { status: "completed", progress: 100, outputPath: result.outputPath, completedAt: Date.now() });
  } catch (e: any) { Object.assign(job, { status: proxyController.signal.aborted ? "cancelled" : "failed", error: e.message || String(e), completedAt: Date.now() }); }
  finally { proxyBusy = false; proxyController = undefined; powerSaveBlocker.stop(lock); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); }
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
  handle("dialog:directory", async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("tasks:list", () => engine.getAllTasks());
  handle("tasks:create", async (config: TaskConfig) => {
    await validatePaths(config.sourcePath, config.destinationPaths);
    const task = engine.createTask(config);
    const sourceIdentity = await volumeIdentity(config.sourcePath);
    task.sourceVolumeId = sourceIdentity.id;
    task.sourceVolumeUuid = sourceIdentity.uuid;
    task.sourceVolumeName = sourceIdentity.name;
    await Promise.all(task.destinations.map(async (destination) => {
      const identity = await volumeIdentity(destination.path);
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
  handle("tasks:retry-failed", async (id: string) => { const task = engine.getTask(id); if (!task || !task.destinations.some((d) => !d.verified)) throw new Error("没有可重试的失败目标"); engine.startTask(id); await persist(); return true; });
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
    return {
      totalFiles: r.files.length,
      totalBytes: r.totalBytes,
      skipped: r.skipped,
      sample: r.files.slice(0, 6).map((f) => f.relativePath),
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
  handle("system:reveal", (file: string) => shell.showItemInFolder(file));
  handle("migration:preview", async () => {
    const sources = [] as Array<{path:string;tasks:number;projects:number;hasSettings:boolean}>;
    for (const legacy of [path.join(appDataRoot, "New Kocpy"), path.join(appDataRoot, "KocardPro")]) {
      const tasks = await new Storage(legacy).read<BackupTask[]>("tasks.json", []), projects = await new Storage(legacy).read<ProjectConfig[]>("projects.json", []), hasSettings = await fs.access(path.join(legacy, "settings.json")).then(() => true, () => false);
      if (tasks.length || projects.length || hasSettings) sources.push({ path: legacy, tasks: tasks.length, projects: projects.length, hasSettings });
    }
    return sources;
  });
  handle("migration:import", async (legacy: string) => {
    const allowed = [path.join(appDataRoot, "New Kocpy"), path.join(appDataRoot, "KocardPro")]; if (!allowed.includes(legacy)) throw new Error("不支持的迁移来源");
    const sourceStore = new Storage(legacy), oldTasks = await sourceStore.read<BackupTask[]>("tasks.json", []), oldProjects = await sourceStore.read<ProjectConfig[]>("projects.json", []);
    const backup = path.join(userDataPath, "migration-backups", String(Date.now())); await fs.mkdir(backup, { recursive: true });
    for (const file of ["tasks.json", "projects.json", "settings.json"]) await fs.copyFile(path.join(userDataPath, file), path.join(backup, file)).catch((e) => { if (e.code !== "ENOENT") throw e; });
    const existingIds = new Set(engine.getAllTasks().map((t) => t.id)); for (const task of oldTasks) if (!existingIds.has(task.id)) engine.loadTask(task); await persist();
    const projects = await store.read<ProjectConfig[]>("projects.json", []), projectIds = new Set(projects.map((p) => p.id)); for (const project of oldProjects) if (!projectIds.has(project.id)) projects.push(project); await store.write("projects.json", projects);
    const legacySettings = await sourceStore.read<typeof defaultSettings | null>("settings.json", null); if (legacySettings) await store.write("settings.json", { ...defaultSettings, ...legacySettings });
    return { tasks: oldTasks.filter((t) => !existingIds.has(t.id)).length, projects: oldProjects.filter((p) => !projectIds.has(p.id)).length, backup };
  });
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
  handle("projects:save", async (project: ProjectConfig) => {
    project.name = segment(project.name);
    if (!project.shootingDateStart) throw new Error("请设置项目开始日期");
    if (project.shootingDateEnd && project.shootingDateEnd < project.shootingDateStart) throw new Error("项目结束日期不能早于开始日期");
    project.devices = [...new Set(project.devices.map(segment))].slice(0, 10);
    if (!project.devices.length) throw new Error("请至少选择一个设备或机位");
    if (!project.destinationPaths?.length || project.destinationPaths.length > 4 || project.destinationPaths.some((value) => !path.isAbsolute(value))) throw new Error("请选择 1–4 个有效备份根目录");
    project.projectFolderName = makeProjectFolderName(project.shootingDateStart, project.name);
    project.volumePrefixByDevice = Object.fromEntries(project.devices.map((device) => [device, segment(project.volumePrefixByDevice?.[device] || `${device}_`)]));
    project.devicePositions = Object.fromEntries(project.devices.flatMap((device) => {
      const positions = [...new Set(project.devicePositions?.[device] || [])].filter((value) => /^[A-E]$/.test(value)).slice(0, 5);
      return positions.length ? [[device, positions]] : [];
    }));
    project = normalizeProject(project);
    await createProjectDateFolders(project.destinationPaths!, project.projectFolderName!, project.shootingDateStart!);
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
  handle("proxy:enqueue", async (inputs: string[], out: string, format: "h264" | "prores", resolution: "1080p" | "720p") => {
    if (!inputs.length) throw new Error("请选择至少一个视频");
    const canonicalOut = await canonical(out);
    for (const task of engine.getAllTasks()) if (inside(canonicalOut, await canonical(task.sourcePath))) throw new Error("代理不能写入素材源目录");
    const tracked = new Set(engine.getAllTasks().flatMap((t) => t.fileRecords).flatMap((f) => f.destinations.filter((d) => d.verified).map((d) => d.path)));
    for (const input of inputs) if (!tracked.has(input)) throw new Error("只能为已校验的备份文件生成代理");
    const jobs = await Promise.all(inputs.map(async (input): Promise<ProxyJob> => { const metadata = await inspectMedia(input, path.join(app.getPath("userData"), "thumbnails")).catch(() => ({} as any)); return { id: randomUUID(), input, name: path.basename(input), outputDir: out, format, resolution, status: "pending", progress: 0, createdAt: Date.now(), timecode: metadata.timecode }; }));
    proxyJobs.push(...jobs); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); return jobs;
  });
  handle("proxy:cancel", async (id?: string) => { const job = id ? proxyJobs.find((j) => j.id === id) : proxyJobs.find((j) => j.status === "running"); if (!job) return false; if (job.status === "running") proxyController?.abort(new Error("用户取消代理任务")); else if (job.status === "pending") job.status = "cancelled"; await persistProxyJobs(); emitProxyJobs(); return true; });
  handle("proxy:retry", async (id: string) => { const job = proxyJobs.find((j) => j.id === id); if (!job || !["failed", "cancelled"].includes(job.status)) throw new Error("该任务不能重试"); Object.assign(job, { status: "pending", progress: 0, error: undefined, completedAt: undefined }); await persistProxyJobs(); emitProxyJobs(); void processProxyQueue(); return true; });
  handle("proxy:delete", async (id: string) => { const job = proxyJobs.find((j) => j.id === id); if (!job || ["running", "pending"].includes(job.status)) throw new Error("请先取消代理任务"); proxyJobs = proxyJobs.filter((j) => j.id !== id); await persistProxyJobs(); emitProxyJobs(); return true; });
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
