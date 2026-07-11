import { contextBridge, ipcRenderer } from 'electron'
import type { TaskConfig, ProgressPayload, ProjectConfig } from './types'

interface AppSettings {
  defaultHash: 'md5' | 'sha1' | 'sha256'
  verifyAfterCopy: boolean
  devices: string[]
  defaultDuplicateStrategy?: 'skip' | 'suffix'
  defaultGenerateThumbnails?: boolean
  webhookUrl?: string
  webhookEnabled?: boolean
}

contextBridge.exposeInMainWorld('api', {
  selectDirectory: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:selectDirectory', defaultPath),

  saveReport: (taskName: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveReport', taskName),

  createTask: (config: TaskConfig) =>
    ipcRenderer.invoke('backup:createTask', config),

  startTask: (taskId: string) =>
    ipcRenderer.invoke('backup:startTask', taskId),

  cancelTask: (taskId: string) =>
    ipcRenderer.invoke('backup:cancelTask', taskId),

  deleteTask: (taskId: string) =>
    ipcRenderer.invoke('backup:deleteTask', taskId),

  setPriority: (taskId: string, priority: boolean): Promise<void> =>
    ipcRenderer.invoke('backup:setPriority', taskId, priority),

  getTasks: () =>
    ipcRenderer.invoke('backup:getTasks'),

  getTask: (taskId: string) =>
    ipcRenderer.invoke('backup:getTask', taskId),

  generateReport: (taskId: string, savePath: string, options?: { includeThumbnails?: boolean }) =>
    ipcRenderer.invoke('backup:generateReport', taskId, savePath, options),

  getDriveInfo: (dirPath: string) =>
    ipcRenderer.invoke('system:getDriveInfo', dirPath),

  getSystemInfo: () =>
    ipcRenderer.invoke('system:getInfo'),

  revealInFinder: (filePath: string) =>
    ipcRenderer.invoke('system:revealInFinder', filePath),

  openLogsFolder: (): Promise<void> =>
    ipcRenderer.invoke('system:openLogs'),

  listVolumes: () =>
    ipcRenderer.invoke('system:listVolumes'),

  ejectVolume: (volumePath: string) =>
    ipcRenderer.invoke('system:ejectVolume', volumePath),

  getSettings: (): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:get'),

  saveSettings: (settings: AppSettings): Promise<boolean> =>
    ipcRenderer.invoke('settings:save', settings),

  getDevices: (): Promise<string[]> =>
    ipcRenderer.invoke('settings:getDevices'),

  addDevice: (name: string): Promise<string[]> =>
    ipcRenderer.invoke('settings:addDevice', name),

  removeDevice: (name: string): Promise<string[]> =>
    ipcRenderer.invoke('settings:removeDevice', name),

  renameDevice: (oldName: string, newName: string): Promise<string[]> =>
    ipcRenderer.invoke('settings:renameDevice', oldName, newName),

  getProjects: (): Promise<ProjectConfig[]> =>
    ipcRenderer.invoke('projects:getAll'),

  saveProject: (project: ProjectConfig): Promise<ProjectConfig[]> =>
    ipcRenderer.invoke('projects:save', project),

  deleteProject: (projectId: string): Promise<ProjectConfig[]> =>
    ipcRenderer.invoke('projects:delete', projectId),

  createFileStructure: (projectId: string) =>
    ipcRenderer.invoke('projects:createFileStructure', projectId),

  resolveBackupPath: (params: { projectId: string; shootingDate: string; deviceName: string; positionLabel: string }) =>
    ipcRenderer.invoke('projects:resolveBackupPath', params),

  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke('app:getVersion'),

  checkForUpdates: (): Promise<{
    hasUpdate: boolean
    currentVersion?: string
    latestVersion?: string
    releaseUrl?: string
    releaseNotes?: string
    publishedAt?: string
    assets?: { name: string; url: string; size: number }[]
    error?: string
  }> => ipcRenderer.invoke('app:checkForUpdates'),

  testWebhook: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('webhook:test', url),

  onProgress: (callback: (payload: ProgressPayload) => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: ProgressPayload) => callback(payload)
    ipcRenderer.on('backup:progress', handler)
    return () => ipcRenderer.removeListener('backup:progress', handler)
  },

  // ASC MHL 相关API
  mhlGenerate: (sourcePath: string, algorithm: string, operator: string, notes?: string) =>
    ipcRenderer.invoke('mhl:generate', sourcePath, algorithm, operator, notes),

  mhlVerify: (mhlPath: string, targetPath: string) =>
    ipcRenderer.invoke('mhl:verify', mhlPath, targetPath)
})
