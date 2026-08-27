import type { BackupTask, TaskConfig, ProjectConfig, ProjectStructureReport, ProxyJob } from "../../main/types";
export type { BackupTask, TaskConfig, ProjectConfig, ProjectStructureReport, ProxyJob };
export interface Volume {
  name: string;
  path: string;
  total: number;
  free: number;
  used: number;
  deviceType: string;
  canEject: boolean;
  identity?: { id: string; uuid?: string; deviceNode?: string; name: string; device: string };
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
}
export interface Scan {
  totalFiles: number;
  totalBytes: number;
  skipped: number;
  sample: string[];
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
  selectDirectory(defaultPath?: string): Promise<string | null>;
  getTasks(): Promise<BackupTask[]>;
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
  reveal(path: string): Promise<void>;
  previewMigration(): Promise<Array<{path:string;tasks:number;projects:number;hasSettings:boolean}>>;
  importMigration(path:string): Promise<{tasks:number;projects:number;backup:string}>;
  checkUpdates(): Promise<UpdateInfo>;
  openUpdate(url:string): Promise<void>;
  openAuthor(url:string): Promise<void>;
  previewTheme(theme: Settings["theme"]): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getProjects(): Promise<ProjectConfig[]>;
  inspectProjectStructure(project: ProjectConfig): Promise<ProjectStructureReport>;
  saveProject(project: ProjectConfig, createMissing?: boolean): Promise<ProjectConfig[]>;
  claimProjectVolume(projectId: string, device: string, prefixOverride?: string): Promise<{label:string;timestamp:string;collision:number;prefix:string;project:ProjectConfig}>;
  exportReport(id: string, format: "pdf" | "json" | "mhl" | "ascmhl"): Promise<string | null>;
  exportDailyReport(date: string, projectId?: string): Promise<string | null>;
  exportResolveCsv(date: string, projectId?: string): Promise<string | null>;
  inspectMedia(path: string): Promise<{name:string;path:string;size:number;modifiedAt:number;duration?:string;video?:string;audio?:string;timecode?:string;camera?:string;creationTime?:string;resolution?:string;frameRate?:string;thumbnail?:string;thumbnailPath?:string}>;
  getProxyJobs(): Promise<ProxyJob[]>;
  enqueueProxy(
    inputs: string[],
    out: string,
    format: "h264" | "prores",
    resolution: "1080p" | "720p",
  ): Promise<ProxyJob[]>;
  cancelProxy(id?: string): Promise<void>;
  retryProxy(id: string): Promise<void>;
  deleteProxy(id: string): Promise<void>;
  onProxyJobs(callback: (jobs: ProxyJob[]) => void): () => void;
  onTaskSettled(callback: (task: BackupTask) => void): () => void;
  onProgress(
    callback: (task: Partial<BackupTask> & { taskId: string }) => void,
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
  failed: "需要处理",
  cancelled: "已取消",
};
