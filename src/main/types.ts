export type HashAlgorithm = 'md5' | 'sha1' | 'sha256'
export type TaskStatus = 'pending' | 'running' | 'verifying' | 'completed' | 'failed' | 'cancelled'
export type CopyMode = 'normal' | 'mirror'
export type DuplicateStrategy = 'skip' | 'suffix'

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
    unchanged?: boolean
  }>
  thumbnailPath?: string
  skipped?: boolean
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
  startedAt?: number
  completedAt?: number
  verifyCompletedFiles?: number
  verifyTotalFiles?: number
  errorMessage?: string
  fileRecords: FileRecord[]
  skippedFiles?: number
  skippedBytes?: number
  priority?: boolean
  duplicateStrategy?: DuplicateStrategy
  generateThumbnails?: boolean
  fx3Rename?: boolean
  includeHidden?: boolean
  thumbnailError?: string
  incremental?: boolean
  unchangedFiles?: number
  unchangedBytes?: number
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
  duplicateStrategy?: DuplicateStrategy
  generateThumbnails?: boolean
  priority?: boolean
  fx3Rename?: boolean
  includeHidden?: boolean
  incremental?: boolean
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
  startedAt?: number
  completedAt?: number
  verifyCompletedFiles?: number
  verifyTotalFiles?: number
  skippedFiles?: number
  skippedBytes?: number
  unchangedFiles?: number
  unchangedBytes?: number
}

export interface VolumeInfo {
  path: string
  label: string
  total: number
  free: number
  used: number
  type: string
  deviceType?: 'system' | 'source' | 'destination'
  canEject?: boolean
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
