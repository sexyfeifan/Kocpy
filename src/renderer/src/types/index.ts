export type HashAlgorithm = 'md5' | 'sha1' | 'sha256'
export type TaskStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled'
export type CopyMode = 'normal' | 'mirror'

export interface Destination {
  id: string
  path: string
  resolvedPath?: string
  label: string
  verified: boolean
  checksum?: string
  bytesWritten: number
  error?: string
}

export interface FileRecord {
  name: string
  relativePath: string
  size: number
  srcChecksum: string
  destinations: Array<{
    path: string
    checksum: string
    verified: boolean
  }>
  thumbnailPath?: string
}

export interface BackupTask {
  id: string
  name: string
  sourcePath: string
  devices: string[]
  destinations: Destination[]
  hashAlgorithm: HashAlgorithm
  namingTemplate: string
  shootingDateFolder?: string
  copyMode?: CopyMode
  status: TaskStatus
  totalFiles: number
  completedFiles: number
  totalBytes: number
  transferredBytes: number
  speedBps: number
  eta: number
  currentFile: string
  verifyLog: string[]
  verifyTotalFiles?: number
  verifyCompletedFiles?: number
  startedAt?: number
  completedAt?: number
  errorMessage?: string
  fileRecords: FileRecord[]
  skippedFiles?: number
  skippedBytes?: number
  priority?: boolean
  generateThumbnails?: boolean
  thumbnailError?: string
}

export interface TaskConfig {
  name: string
  sourcePath: string
  devices: string[]
  destinationPaths: string[]
  hashAlgorithm: HashAlgorithm
  namingTemplate: string
  shootingDate: string
  projectName?: string
  copyMode?: CopyMode
  fx3Rename?: boolean
}

export interface ProgressPayload {
  taskId: string
  status: TaskStatus
  totalFiles: number
  completedFiles: number
  totalBytes: number
  transferredBytes: number
  speedBps: number
  eta: number
  currentFile: string
  verifyLog: string[]
  destinations: Destination[]
  errorMessage?: string
}

export interface AppSettings {
  defaultHash: HashAlgorithm
  verifyAfterCopy: boolean
  devices: string[]
  backupCount: number
  isUnlocked: boolean
  webhookUrl?: string
  webhookEnabled?: boolean
}

export interface ProjectConfig {
  id: string
  name: string
  devices: string[]
  volumePrefix: string
  shootingDate?: string
  shootingDateStart?: string
  shootingDateEnd?: string
  devicePositions?: Record<string, string[]>
  destinationPaths?: string[]
  status?: 'active' | 'archived'
  createdAt?: number
}

export interface VolumeInfo {
  name: string
  path: string
  total: number
  free: number
  used: number
  deviceType: 'system' | 'source' | 'destination'
  canEject: boolean
}

declare global {
  interface Window {
    api: {
      selectDirectory: (defaultPath?: string) => Promise<string | null>
      saveReport: (taskName: string) => Promise<string | null>
      createTask: (config: TaskConfig) => Promise<BackupTask>
      startTask: (taskId: string) => Promise<{ allowed: boolean; remaining: number }>
      cancelTask: (taskId: string) => Promise<boolean>
      deleteTask: (taskId: string) => Promise<boolean>
      setPriority: (taskId: string, priority: boolean) => Promise<void>
      getTasks: () => Promise<BackupTask[]>
      getTask: (taskId: string) => Promise<BackupTask | undefined>
      generateReport: (taskId: string, savePath: string, options?: { includeThumbnails?: boolean }) => Promise<boolean>
      getDriveInfo: (dirPath: string) => Promise<{ total: number; free: number; used: number } | null>
      getSystemInfo: () => Promise<{ platform: string; arch: string; hostname: string }>
      revealInFinder: (filePath: string) => Promise<void>
      getSettings: () => Promise<AppSettings>
      saveSettings: (settings: AppSettings) => Promise<boolean>
      getDevices: () => Promise<string[]>
      addDevice: (name: string) => Promise<string[]>
      removeDevice: (name: string) => Promise<string[]>
      renameDevice: (oldName: string, newName: string) => Promise<string[]>
      getProjects: () => Promise<ProjectConfig[]>
      saveProject: (project: ProjectConfig) => Promise<ProjectConfig[]>
      deleteProject: (projectId: string) => Promise<ProjectConfig[]>
      onProgress: (callback: (payload: ProgressPayload) => void) => () => void
      listVolumes: () => Promise<VolumeInfo[]>
      ejectVolume: (volumePath: string) => Promise<boolean>
      createFileStructure: (projectId: string) => Promise<{ created: string[]; skipped: string[]; errors: string[] }>
      resolveBackupPath: (params: { projectId: string; shootingDate: string; deviceName: string; positionLabel: string }) => Promise<string | null>
      getAppVersion: () => Promise<string>
      checkAndIncrementBackupCount: () => Promise<{ allowed: boolean; remaining: number }>
      unlock: () => Promise<boolean>
      testWebhook: (url: string) => Promise<{ ok: boolean; error?: string }>
    }
  }
}
