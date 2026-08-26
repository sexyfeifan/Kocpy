import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  powerSaveBlocker,
} from "electron";
import path from "node:path";
import { promises as fs } from "node:fs";
import { BackupEngine } from "./backup/BackupEngine";
import {
  scan,
  validatePaths,
  segment,
  inside,
  canonical,
} from "./backup/safety";
import { Storage, defaultSettings } from "./storage";
import { listVolumes, driveInfo, ejectVolume } from "./system";
import { makeProxy } from "./proxy";
import { generateReport } from "./backup/ReportGenerator";
import type { BackupTask, ProjectConfig, TaskConfig } from "./types";

app.setName("New Kocpy");
app.setPath(
  "userData",
  process.env.KOCPY_DATA_DIR || path.join(app.getPath("appData"), "New Kocpy"),
);
if (!app.requestSingleInstanceLock()) app.exit(0);

const engine = new BackupEngine(),
  store = new Storage(app.getPath("userData"));
let main: BrowserWindow | null = null,
  quitReady = false,
  blocker: number | undefined,
  proxyBusy = false;
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
function createWindow() {
  main = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "New Kocpy",
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
  const saved = await store.read<BackupTask[]>("tasks.json", []);
  for (const task of saved) {
    if (["pending", "running", "verifying"].includes(task.status)) {
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
            ["running", "verifying", "pending"].includes(t.status) &&
            (inside(t.sourcePath, volume) ||
              t.destinations.some((d) => inside(d.path, volume))),
        )
    )
      throw new Error("该磁盘有进行中或等待中的任务，请先取消任务");
    if (proxyBusy) throw new Error("请等待代理转码完成后再推出设备");
    return ejectVolume(volume);
  });
  handle("system:reveal", (file: string) => shell.showItemInFolder(file));
  handle("settings:get", () => store.read("settings.json", defaultSettings));
  handle("settings:save", (settings: typeof defaultSettings) =>
    store.write("settings.json", settings),
  );
  handle("projects:list", () =>
    store.read<ProjectConfig[]>("projects.json", []),
  );
  handle("projects:save", async (project: ProjectConfig) => {
    project.name = segment(project.name);
    project.devices = project.devices.map(segment);
    const all = await store.read<ProjectConfig[]>("projects.json", []),
      idx = all.findIndex((p) => p.id === project.id);
    if (idx < 0) all.push(project);
    else all[idx] = project;
    await store.write("projects.json", all);
    return all;
  });
  handle("report:export", async (id: string, format: "pdf" | "json") => {
    const task = engine.getTask(id);
    if (!task) throw new Error("任务不存在");
    if (["pending", "running", "verifying"].includes(task.status))
      throw new Error("任务结束后才能导出完整报告");
    const r = await dialog.showSaveDialog({
      defaultPath: `Kocpy_${task.name}_${id.slice(0, 6)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!r.filePath) return null;
    if (format === "json")
      await fs.writeFile(r.filePath, JSON.stringify(task, null, 2));
    else {
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
            encodeURIComponent((await generateReport(task)).toString()),
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
    return r.filePath;
  });
  handle(
    "proxy:create",
    async (
      input: string,
      out: string,
      format: "h264" | "prores",
      res: "1080p" | "720p",
    ) => {
      if (proxyBusy) throw new Error("已有代理任务正在处理，请等待完成");
      const tracked = engine
        .getAllTasks()
        .flatMap((t) => t.fileRecords)
        .some((f) =>
          f.destinations.some((d) => d.path === input && d.verified),
        );
      if (!tracked) throw new Error("只能为已校验的备份文件生成代理");
      const canonicalOut = await canonical(out);
      for (const task of engine.getAllTasks())
        if (inside(canonicalOut, await canonical(task.sourcePath)))
          throw new Error("代理不能写入素材源目录");
      proxyBusy = true;
      const lock = powerSaveBlocker.start("prevent-app-suspension");
      try {
        return await makeProxy(input, out, format, res);
      } finally {
        proxyBusy = false;
        powerSaveBlocker.stop(lock);
      }
    },
  );
  engine.on("progress", (payload) => {
    if (main && !main.isDestroyed())
      main.webContents.send("tasks:progress", payload);
    if (
      ["running", "verifying"].includes(payload.status) &&
      blocker === undefined
    )
      blocker = powerSaveBlocker.start("prevent-app-suspension");
  });
  engine.on("settled", () => {
    void persist().catch((e) =>
      dialog.showErrorBox("任务记录保存失败", String(e)),
    );
    if (blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "New Kocpy",
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
