import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  BackupTask,
  ExistingImportPreview,
  ExistingImportProgress,
  ExistingReanalysisResult,
  NasPreset,
  ProjectConfig,
  ProjectCoverage,
  ProjectStructureReport,
  ProjectTemplate,
  ProxyJob,
  ReliabilityValidationRecord,
  SavedProxyPreset,
  TaskConfig,
  TransferPerformance,
  BenchmarkResult,
  WorkspaceMergeResult,
} from "../../main/types";
export type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  BackupTask,
  ExistingImportPreview,
  ExistingImportProgress,
  ExistingReanalysisResult,
  NasPreset,
  ProjectConfig,
  ProjectCoverage,
  ProjectStructureReport,
  ProjectTemplate,
  ProxyJob,
  ReliabilityValidationRecord,
  SavedProxyPreset,
  TaskConfig,
  TransferPerformance,
  BenchmarkResult,
  WorkspaceMergeResult,
};
export interface Volume {
  name: string;
  path: string;
  total: number;
  free: number;
  used: number;
  deviceType: string;
  canEject: boolean;
  identity?: {
    id: string;
    uuid?: string;
    deviceNode?: string;
    name: string;
    device: string;
  };
  isNetwork?: boolean;
  protocol?: string;
  latencyMs?: number;
  writable?: boolean;
}
export interface Settings {
  defaultHash: "sha256" | "md5" | "sha1";
  defaultDuplicateStrategy: "skip" | "suffix";
  includeHidden: boolean;
  operator: string;
  theme: "dark" | "light";
  reportSyncPath: string;
  thumbnailCacheGiB: number;
  notificationSound: boolean;
}
export interface Scan {
  totalFiles: number;
  totalBytes: number;
  skipped: number;
  sample: string[];
  breakdown: Record<
    "video" | "photo" | "audio" | "other",
    { files: number; bytes: number }
  >;
  suggestion?: {
    duplicateTaskId?: string;
    duplicateTaskName?: string;
    projectId?: string;
    device?: string;
    cameraPosition?: string;
    nextVolume: number;
  };
}
export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  releaseUrl: string;
  downloadUrl?: string;
  assetName?: string;
  arch: "arm64" | "x64";
  archLabel: "Apple Silicon" | "Intel";
}
export interface API {
  resolveDroppedPaths(files: File[]): string[];
  selectDirectory(defaultPath?: string): Promise<string | null>;
  getTasks(): Promise<BackupTask[]>;
  getTask(id: string): Promise<BackupTask>;
  getCatalogStats(): Promise<{
    tasks: number;
    files: number;
    projects: number;
    schema: number;
  }>;
  getCatalogFiles(options: {
    projectId?: string;
    query?: string;
    kind?: string;
    offset?: number;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
  rebuildCatalog(): Promise<{
    tasks: number;
    files: number;
    projects: number;
    schema: number;
  }>;
  createTask(config: TaskConfig): Promise<BackupTask>;
  startTask(id: string): Promise<void>;
  cancelTask(id: string): Promise<void>;
  pauseTask(id: string): Promise<void>;
  resumeTask(id: string): Promise<void>;
  reverifyTask(id: string): Promise<BackupTask>;
  retryFailedDestinations(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  setPriority(id: string, value: boolean): Promise<void>;
  scanSource(path: string, includeHidden?: boolean): Promise<Scan>;
  listVolumes(): Promise<Volume[]>;
  driveInfo(
    path: string,
  ): Promise<{ total: number; free: number; used: number }>;
  ejectVolume(path: string): Promise<void>;
  ejectCompletedVolumes(): Promise<
    Array<{ path: string; ok: boolean; error?: string }>
  >;
  runBenchmark(path: string, sizeMiB?: number): Promise<BenchmarkResult>;
  getReliabilityValidations(): Promise<ReliabilityValidationRecord[]>;
  validateReliabilityVolume(path: string): Promise<ReliabilityValidationRecord>;
  getDiagnostics(): Promise<any>;
  exportDiagnostics(): Promise<string | null>;
  getArchiveHealth(): Promise<ArchiveHealthRecord[]>;
  getArchiveChanges(projectId?: string): Promise<ArchiveChangeRecord[]>;
  getArchiveReminders(): Promise<ArchiveReminder[]>;
  saveArchiveReminder(value: ArchiveReminder): Promise<ArchiveReminder[]>;
  verifyArchiveScope(scope: {
    projectId?: string;
    shootingDate?: string;
    taskId?: string;
    relativePath?: string;
    volumePath?: string;
  }): Promise<{ changes: ArchiveChangeRecord[]; record: ArchiveHealthRecord }>;
  auditUntrackedArchive(
    projectId: string,
    root: string,
  ): Promise<ArchiveChangeRecord[]>;
  moveArchiveCopy(
    taskId: string,
    destinationId: string,
    newPath: string,
  ): Promise<BackupTask>;
  exportArchiveChanges(projectId: string): Promise<string | null>;
  verifyProjectArchive(projectId: string): Promise<ArchiveHealthRecord>;
  repairArchiveCopy(
    taskId: string,
    destinationId: string,
  ): Promise<{ repaired: number; preservedDamagedOriginals: number }>;
  getProjectTemplates(): Promise<ProjectTemplate[]>;
  createTemplateFromProject(
    projectId: string,
    name?: string,
  ): Promise<ProjectTemplate[]>;
  deleteProjectTemplate(id: string): Promise<ProjectTemplate[]>;
  applyProjectTemplate(
    templateId: string,
    projectId: string,
  ): Promise<ProjectConfig[]>;
  previewExistingBackup(
    root: string,
    projectId?: string,
    scope?: "card" | "day" | "project" | "auto",
    selectedDate?: string,
  ): Promise<ExistingImportPreview>;
  importExistingBackup(
    projectId: string,
    root: string,
    mode: "manifest-import" | "external-baseline" | "unverified-import",
    metadata?: {
      shootingDate?: string;
      device?: string;
      cameraPosition?: string;
      card?: string;
    },
  ): Promise<BackupTask>;
  importExistingScope(
    projectId: string,
    root: string,
    mode: "manifest-import" | "external-baseline" | "unverified-import",
    scope: "card" | "day" | "project",
    selectedDate?: string,
    jobId?: string,
  ): Promise<BackupTask[]>;
  reanalyzeExistingProject(
    projectId: string,
    apply?: boolean,
  ): Promise<ExistingReanalysisResult>;
  establishExistingBaseline(
    taskId: string,
    jobId?: string,
  ): Promise<BackupTask>;
  repairExistingManifest(
    taskId: string,
    jobId?: string,
  ): Promise<{ files: number; bytes: number } | null>;
  reverifyExistingManifest(
    taskId: string,
    jobId?: string,
  ): Promise<BackupTask>;
  acceptExistingManifestExtra(taskId: string): Promise<BackupTask>;
  revealExistingManifestItem(
    taskId: string,
    relativePath?: string,
  ): Promise<void>;
  relinkLibraryFile(
    taskId: string,
    relativePath: string,
  ): Promise<string | null>;
  getProjectCoverage(projectId: string): Promise<ProjectCoverage>;
  signProjectChecklist(projectId: string, run: any): Promise<ProjectConfig>;
  getNasPresets(): Promise<NasPreset[]>;
  saveNasPreset(value: NasPreset): Promise<NasPreset[]>;
  deleteNasPreset(id: string): Promise<NasPreset[]>;
  testNasPreset(id: string): Promise<any>;
  addProjectHandoff(
    projectId: string,
    operator: string,
    note: string,
  ): Promise<ProjectConfig[]>;
  exportWorkspace(): Promise<string | null>;
  importWorkspace(): Promise<WorkspaceMergeResult | null>;
  backupWorkspaceData(): Promise<string | null>;
  coldArchiveProject(projectId: string): Promise<string | null>;
  restoreColdArchive(): Promise<{
    project: ProjectConfig;
    tasks: number;
  } | null>;
  startLanIndex(): Promise<{
    active: boolean;
    port: number;
    addresses: string[];
    token: string;
  }>;
  stopLanIndex(): Promise<{
    active: boolean;
    port: number;
    addresses: string[];
    token: string;
  }>;
  getLanIndexStatus(): Promise<{
    active: boolean;
    port: number;
    addresses: string[];
    token: string;
  }>;
  reveal(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  checkUpdates(): Promise<UpdateInfo>;
  openUpdate(url: string): Promise<void>;
  openAuthor(url: string): Promise<void>;
  previewTheme(theme: Settings["theme"]): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getProjects(): Promise<ProjectConfig[]>;
  inspectProjectStructure(
    project: ProjectConfig,
  ): Promise<ProjectStructureReport>;
  saveProject(
    project: ProjectConfig,
    createMissing?: boolean,
  ): Promise<ProjectConfig[]>;
  claimProjectVolume(
    projectId: string,
    device: string,
    prefixOverride?: string,
  ): Promise<{
    label: string;
    timestamp: string;
    collision: number;
    prefix: string;
    project: ProjectConfig;
  }>;
  exportReport(
    id: string,
    format: "pdf" | "json" | "mhl" | "ascmhl",
  ): Promise<string | null>;
  exportDailyReport(date: string, projectId?: string): Promise<string | null>;
  exportProjectReport(
    projectId: string,
    format: "pdf" | "json" | "csv" | "bundle",
  ): Promise<string | null>;
  exportResolveCsv(date: string, projectId?: string): Promise<string | null>;
  inspectMedia(path: string): Promise<{
    name: string;
    path: string;
    size: number;
    modifiedAt: number;
    duration?: string;
    video?: string;
    audio?: string;
    timecode?: string;
    camera?: string;
    creationTime?: string;
    resolution?: string;
    frameRate?: string;
    colorSpace?: string;
    thumbnail?: string;
    thumbnailPath?: string;
    waveform?: string;
    waveformPath?: string;
  }>;
  getProxyJobs(): Promise<ProxyJob[]>;
  getProxyPresets(): Promise<SavedProxyPreset[]>;
  saveProxyPreset(
    value: Partial<SavedProxyPreset> & { name: string },
  ): Promise<SavedProxyPreset[]>;
  deleteProxyPreset(id: string): Promise<SavedProxyPreset[]>;
  enqueueProxy(
    inputs: string[],
    out: string,
    format: "h264" | "prores",
    resolution: string,
    options?: {
      preset?: "review" | "editorial" | "offline";
      namingTemplate?: string;
      bitrateMbps?: number;
      container?: "mp4" | "mov" | "mkv";
      dependsOn?: string[];
      chain?: boolean;
    },
  ): Promise<ProxyJob[]>;
  cancelProxy(id?: string): Promise<void>;
  pauseProxy(id: string): Promise<void>;
  resumeProxy(id: string): Promise<void>;
  retryProxy(id: string): Promise<void>;
  deleteProxy(id: string): Promise<void>;
  exportProxyDelivery(
    format: "resolve" | "premiere" | "fcpxml" | "json",
  ): Promise<string | null>;
  exportProxyPackage(): Promise<string | null>;
  onProxyJobs(callback: (jobs: ProxyJob[]) => void): () => void;
  onTaskSettled(callback: (task: BackupTask) => void): () => void;
  onProgress(
    callback: (task: Partial<BackupTask> & { taskId: string }) => void,
  ): () => void;
  onExistingImportProgress(
    callback: (progress: ExistingImportProgress) => void,
  ): () => void;
}
declare global {
  interface Window {
    api: API;
  }
}
export const api = window.api;
export const bytes = (n = 0) => {
  if (!n) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toLocaleString("en-US", { maximumFractionDigits: i > 1 ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][i]}`;
};
export const leaf = (p: string) => p.split("/").filter(Boolean).pop() || p;
export const previewVolumeTimestamp = (value = new Date()) => {
  const part = (number: number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}${part(value.getMonth() + 1)}${part(value.getDate())}${part(value.getHours())}${part(value.getMinutes())}`;
};
export const date = (n?: number) =>
  n
    ? new Date(n).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "等待开始";
export const today = () => new Date().toLocaleDateString("sv-SE");
export const active = (t: BackupTask) =>
  ["running", "paused", "verifying", "pending"].includes(t.status);
export const statusText: Record<string, string> = {
  pending: "等待执行",
  running: "正在拷贝",
  verifying: "正在校验",
  paused: "已暂停",
  completed: "校验通过",
  unverified: "已识别 · 待建立基线",
  failed: "需要处理",
  cancelled: "已取消",
};
