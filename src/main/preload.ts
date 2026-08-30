import { contextBridge, ipcRenderer } from "electron";
const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);
contextBridge.exposeInMainWorld("api", {
  resolveDroppedPaths: (files: File[]) =>
    files
      .map((file) => (file as File & { path?: string }).path || "")
      .filter(Boolean),
  selectDirectory: call("dialog:directory"),
  getTasks: call("tasks:list"),
  getTask: call("tasks:get"),
  getCatalogStats: call("catalog:stats"),
  getCatalogFiles: call("catalog:files"),
  rebuildCatalog: call("catalog:rebuild"),
  createTask: call("tasks:create"),
  startTask: call("tasks:start"),
  cancelTask: call("tasks:cancel"),
  pauseTask: call("tasks:pause"),
  resumeTask: call("tasks:resume"),
  reverifyTask: call("tasks:reverify"),
  retryFailedDestinations: call("tasks:retry-failed"),
  deleteTask: call("tasks:delete"),
  setPriority: call("tasks:priority"),
  scanSource: call("source:scan"),
  listVolumes: call("volumes:list"),
  driveInfo: call("volumes:info"),
  ejectVolume: call("volumes:eject"),
  ejectCompletedVolumes: call("volumes:eject-completed"),
  runBenchmark: call("diagnostics:benchmark"),
  getReliabilityValidations: call("diagnostics:reliability-list"),
  validateReliabilityVolume: call("diagnostics:validate-volume"),
  getDiagnostics: call("diagnostics:get"),
  exportDiagnostics: call("diagnostics:export"),
  getArchiveHealth: call("archive:health-list"),
  getArchiveChanges: call("archive:changes"),
  getArchiveReminders: call("archive:reminders"),
  saveArchiveReminder: call("archive:save-reminder"),
  verifyArchiveScope: call("archive:verify-scope"),
  auditUntrackedArchive: call("archive:audit-untracked"),
  moveArchiveCopy: call("archive:move-copy"),
  exportArchiveChanges: call("archive:export-changes"),
  verifyProjectArchive: call("archive:verify-project"),
  repairArchiveCopy: call("archive:repair-copy"),
  getProjectTemplates: call("templates:list"),
  createTemplateFromProject: call("templates:from-project"),
  saveProjectTemplate: call("templates:save"),
  deleteProjectTemplate: call("templates:delete"),
  hideProjectTemplate: call("templates:hide"),
  exportProjectTemplates: call("templates:export"),
  importProjectTemplates: call("templates:import"),
  previewProjectTemplate: call("templates:preview-apply"),
  applyProjectTemplate: call("templates:apply"),
  previewExistingBackup: call("existing:preview"),
  importExistingBackup: call("existing:import"),
  importExistingScope: call("existing:import-scope"),
  reanalyzeExistingProject: call("existing:reanalyze-project"),
  establishExistingBaseline: call("existing:establish-baseline"),
  repairExistingManifest: call("existing:repair-manifest-missing"),
  reverifyExistingManifest: call("existing:reverify-manifest"),
  acceptExistingManifestExtra: call("existing:accept-manifest-extra"),
  reviseExistingManifestMissing: call("existing:revise-manifest-missing"),
  revealExistingManifestItem: call("existing:reveal-manifest-item"),
  revealExistingManifestAudit: call("existing:reveal-manifest-audit"),
  relinkLibraryFile: call("library:relink"),
  getProjectCoverage: call("projects:coverage"),
  signProjectChecklist: call("projects:sign-checklist"),
  getNasPresets: call("nas:list"),
  saveNasPreset: call("nas:save"),
  deleteNasPreset: call("nas:delete"),
  testNasPreset: call("nas:test"),
  addProjectHandoff: call("projects:add-handoff"),
  exportWorkspace: call("workspace:export"),
  importWorkspace: call("workspace:import"),
  backupWorkspaceData: call("workspace:backup-data"),
  coldArchiveProject: call("workspace:cold-archive"),
  restoreColdArchive: call("workspace:restore-cold"),
  startLanIndex: call("lan:start"),
  stopLanIndex: call("lan:stop"),
  getLanIndexStatus: call("lan:status"),
  reveal: call("system:reveal"),
  openPath: call("system:open-path"),
  checkUpdates: call("updates:check"),
  openUpdate: call("updates:open"),
  openAuthor: call("system:open-author"),
  previewTheme: call("settings:preview-theme"),
  getSettings: call("settings:get"),
  saveSettings: call("settings:save"),
  getProjects: call("projects:list"),
  previewProjectDeletion: call("projects:delete-preview"),
  deleteProject: call("projects:delete"),
  inspectProjectStructure: call("projects:inspect-structure"),
  saveProject: call("projects:save"),
  claimProjectVolume: call("projects:claim-volume"),
  exportReport: call("report:export"),
  exportDailyReport: call("report:daily"),
  exportProjectReport: call("report:project"),
  exportResolveCsv: call("report:resolve-csv"),
  inspectMedia: call("media:inspect"),
  getProxyJobs: call("proxy:list"),
  getProxyPresets: call("proxy:presets"),
  saveProxyPreset: call("proxy:save-preset"),
  deleteProxyPreset: call("proxy:delete-preset"),
  enqueueProxy: call("proxy:enqueue"),
  cancelProxy: call("proxy:cancel"),
  pauseProxy: call("proxy:pause"),
  resumeProxy: call("proxy:resume"),
  retryProxy: call("proxy:retry"),
  deleteProxy: call("proxy:delete"),
  exportProxyDelivery: call("proxy:export-delivery"),
  exportProxyPackage: call("proxy:export-package"),
  onProxyJobs: (callback: (jobs: unknown) => void) => {
    const listener = (_event: unknown, jobs: unknown) => callback(jobs);
    ipcRenderer.on("proxy:jobs", listener);
    return () => ipcRenderer.removeListener("proxy:jobs", listener);
  },
  onTaskSettled: (callback: (task: unknown) => void) => {
    const listener = (_event: unknown, task: unknown) => callback(task);
    ipcRenderer.on("tasks:settled", listener);
    return () => ipcRenderer.removeListener("tasks:settled", listener);
  },
  onProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("tasks:progress", listener);
    return () => ipcRenderer.removeListener("tasks:progress", listener);
  },
  onExistingImportProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("existing:progress", listener);
    return () => ipcRenderer.removeListener("existing:progress", listener);
  },
});
