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
  // 基础功能
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

  // 系统功能
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

  // 设置功能
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

  // 项目功能
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

  // 应用功能
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

  // ASC MHL API
  mhlGenerate: (sourcePath: string, algorithm: string, operator: string, notes?: string) =>
    ipcRenderer.invoke('mhl:generate', sourcePath, algorithm, operator, notes),

  mhlVerify: (mhlPath: string, targetPath: string) =>
    ipcRenderer.invoke('mhl:verify', mhlPath, targetPath),

  // 元数据 API
  metadataExtract: (filePath: string) =>
    ipcRenderer.invoke('metadata:extract', filePath),

  metadataExtractBatch: (filePaths: string[]) =>
    ipcRenderer.invoke('metadata:extractBatch', filePaths),

  metadataGetSupportedFormats: () =>
    ipcRenderer.invoke('metadata:getSupportedFormats'),

  // 转码 API
  transcodeVideo: (options: any) =>
    ipcRenderer.invoke('transcode:video', options),

  transcodeBatch: (files: any[], options: any, concurrency?: number) =>
    ipcRenderer.invoke('transcode:batch', files, options, concurrency),

  transcodeGetFormats: () =>
    ipcRenderer.invoke('transcode:getFormats'),

  transcodeGetResolutions: () =>
    ipcRenderer.invoke('transcode:getResolutions'),

  // LUT/CDL API
  lutImport: (filePath: string, name?: string, tags?: string[]) =>
    ipcRenderer.invoke('lut:import', filePath, name, tags),

  lutGetAll: () =>
    ipcRenderer.invoke('lut:getAll'),

  lutCreateCDL: (name: string, slope: number[], offset: number[], power: number[], saturation: number) =>
    ipcRenderer.invoke('lut:createCDL', name, slope, offset, power, saturation),

  lutGetCDLs: () =>
    ipcRenderer.invoke('lut:getCDLs'),

  lutExportCDL: (cdlId: string, format: 'xml' | 'ccc') =>
    ipcRenderer.invoke('lut:exportCDL', cdlId, format),

  // DaVinci Resolve API
  resolveExportALE: (entries: any[], outputPath: string) =>
    ipcRenderer.invoke('resolve:exportALE', entries, outputPath),

  resolveExportXML: (entries: any[], outputPath: string) =>
    ipcRenderer.invoke('resolve:exportXML', entries, outputPath),

  resolveExportEDL: (entries: any[], outputPath: string) =>
    ipcRenderer.invoke('resolve:exportEDL', entries, outputPath),

  resolveCreateProject: (projectName: string, basePath: string) =>
    ipcRenderer.invoke('resolve:createProject', projectName, basePath),

  // NAS API
  nasScan: () =>
    ipcRenderer.invoke('nas:scan'),

  nasGetDevices: () =>
    ipcRenderer.invoke('nas:getDevices'),

  nasCreateSyncJob: (source: string, destination: string) =>
    ipcRenderer.invoke('nas:createSyncJob', source, destination),

  nasStartSync: (jobId: string) =>
    ipcRenderer.invoke('nas:startSync', jobId),

  nasGetSyncJobs: () =>
    ipcRenderer.invoke('nas:getSyncJobs'),

  // 媒体生命周期 API
  lifecycleRegister: (filePath: string, project?: string, tags?: string[]) =>
    ipcRenderer.invoke('lifecycle:register', filePath, project, tags),

  lifecycleUpdateStatus: (id: string, status: string, location?: string, notes?: string) =>
    ipcRenderer.invoke('lifecycle:updateStatus', id, status, location, notes),

  lifecycleGetAll: () =>
    ipcRenderer.invoke('lifecycle:getAll'),

  lifecycleSearch: (query: string) =>
    ipcRenderer.invoke('lifecycle:search', query),

  lifecycleGetStatistics: () =>
    ipcRenderer.invoke('lifecycle:getStatistics'),

  lifecycleCreateArchivePolicy: (policy: any) =>
    ipcRenderer.invoke('lifecycle:createArchivePolicy', policy),

  lifecycleGetArchivePolicies: () =>
    ipcRenderer.invoke('lifecycle:getArchivePolicies'),

  lifecycleExecuteArchivePolicy: (policyId: string) =>
    ipcRenderer.invoke('lifecycle:executeArchivePolicy', policyId)
})
