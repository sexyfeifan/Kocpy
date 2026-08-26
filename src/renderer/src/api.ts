import type { BackupTask, TaskConfig, ProjectConfig } from "../../main/types";
export type { BackupTask, TaskConfig, ProjectConfig };
export interface Volume {
  name: string;
  path: string;
  total: number;
  free: number;
  used: number;
  deviceType: string;
  canEject: boolean;
}
export interface Settings {
  defaultHash: "sha256" | "md5" | "sha1";
  defaultDuplicateStrategy: "skip" | "suffix";
  includeHidden: boolean;
  operator: string;
  theme: "dark" | "light";
}
export interface Scan {
  totalFiles: number;
  totalBytes: number;
  skipped: number;
  sample: string[];
}
export interface API {
  selectDirectory(): Promise<string | null>;
  getTasks(): Promise<BackupTask[]>;
  createTask(config: TaskConfig): Promise<BackupTask>;
  startTask(id: string): Promise<void>;
  cancelTask(id: string): Promise<void>;
  pauseTask(id: string): Promise<void>;
  resumeTask(id: string): Promise<void>;
  reverifyTask(id: string): Promise<BackupTask>;
  deleteTask(id: string): Promise<void>;
  setPriority(id: string, value: boolean): Promise<void>;
  scanSource(path: string, includeHidden?: boolean): Promise<Scan>;
  listVolumes(): Promise<Volume[]>;
  driveInfo(
    path: string,
  ): Promise<{ total: number; free: number; used: number }>;
  ejectVolume(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  getProjects(): Promise<ProjectConfig[]>;
  saveProject(project: ProjectConfig): Promise<ProjectConfig[]>;
  exportReport(id: string, format: "pdf" | "json" | "mhl"): Promise<string | null>;
  inspectMedia(path: string): Promise<{name:string;path:string;size:number;modifiedAt:number;duration?:string;video?:string;audio?:string;thumbnail?:string}>;
  cancelProxy(): Promise<void>;
  onProxyProgress(callback: (percent: number) => void): () => void;
  createProxy(
    input: string,
    out: string,
    format: "h264" | "prores",
    resolution: "1080p" | "720p",
  ): Promise<{ outputPath: string; size: number }>;
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
