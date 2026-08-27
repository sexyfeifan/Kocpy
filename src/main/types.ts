export type HashAlgorithm = "md5" | "sha1" | "sha256";
export type TaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";
export type CopyMode = "normal" | "mirror";
export type DuplicateStrategy = "skip" | "suffix";
export type ProxyStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export interface ProxyJob {
  id: string; input: string; name: string; outputDir: string; format: "h264" | "prores"; resolution: "1080p" | "720p";
  status: ProxyStatus; progress: number; createdAt: number; startedAt?: number; completedAt?: number; outputPath?: string; error?: string; timecode?: string;
}

export interface Destination {
  id: string;
  path: string;
  resolvedPath?: string;
  label: string;
  verified: boolean;
  checksum?: string;
  bytesWritten: number;
  copiedBytes?: number;
  verifiedBytes?: number;
  copyProgress?: number;
  verifyProgress?: number;
  speedBps?: number;
  verifySpeedBps?: number;
  volumeId?: string;
  volumeUuid?: string;
  volumeName?: string;
  available?: boolean;
  error?: string;
}

export interface FileRecord {
  name: string;
  relativePath: string;
  size: number;
  srcChecksum: string;
  ascMhlMd5?: string;
  destinations: Array<{
    path: string;
    checksum: string;
    verified: boolean;
    unchanged?: boolean;
  }>;
  thumbnailPath?: string;
  skipped?: boolean;
}

export interface BackupTask {
  projectId?: string;
  projectFolderName?: string;
  shootingDate?: string;
  cameraPosition?: string;
  createdAt?: number;
  id: string;
  name: string;
  sourcePath: string;
  sourceVolumeId?: string;
  sourceVolumeUuid?: string;
  sourceVolumeName?: string;
  devices: string[];
  destinations: Destination[];
  hashAlgorithm: HashAlgorithm;
  namingTemplate: string;
  shootingDateFolder?: string;
  copyMode?: CopyMode;
  status: TaskStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  physicalWrittenBytes?: number;
  verifiedBytes?: number;
  copyProgress?: number;
  verifyProgress?: number;
  aggregateSpeedBps?: number;
  verifySpeedBps?: number;
  verifyEta?: number;
  speedBps: number;
  eta: number;
  currentFile: string;
  verifyLog: string[];
  startedAt?: number;
  completedAt?: number;
  verifyCompletedFiles?: number;
  verifyTotalFiles?: number;
  errorMessage?: string;
  fileRecords: FileRecord[];
  skippedFiles?: number;
  skippedBytes?: number;
  priority?: boolean;
  duplicateStrategy?: DuplicateStrategy;
  generateThumbnails?: boolean;
  fx3Rename?: boolean;
  includeHidden?: boolean;
  thumbnailError?: string;
  incremental?: boolean;
  volumeNumber?: number;
  unchangedFiles?: number;
  unchangedBytes?: number;
  pausedAt?: number;
  lastCheckpointAt?: number;
  volumeWarnings?: string[];
  lastVerifiedAt?: number;
}

export interface TaskConfig {
  projectId?: string;
  name: string;
  sourcePath: string;
  devices: string[];
  destinationPaths: string[];
  hashAlgorithm: HashAlgorithm;
  namingTemplate: string;
  shootingDate: string;
  cameraPosition?: string;
  projectName?: string;
  projectStartDate?: string;
  projectFolderName?: string;
  copyMode?: CopyMode;
  duplicateStrategy?: DuplicateStrategy;
  generateThumbnails?: boolean;
  priority?: boolean;
  fx3Rename?: boolean;
  includeHidden?: boolean;
  incremental?: boolean;
  volumeNumber?: number;
}

export interface ProgressPayload {
  taskId: string;
  status: TaskStatus;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  speedBps: number;
  eta: number;
  currentFile: string;
  verifyLog: string[];
  destinations: Destination[];
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
  verifyCompletedFiles?: number;
  verifyTotalFiles?: number;
  skippedFiles?: number;
  skippedBytes?: number;
  unchangedFiles?: number;
  unchangedBytes?: number;
}

export interface VolumeInfo {
  path: string;
  label: string;
  total: number;
  free: number;
  used: number;
  type: string;
  deviceType?: "system" | "source" | "destination";
  canEject?: boolean;
}

export interface ProjectConfig {
  id: string;
  name: string;
  devices: string[];
  volumePrefix: string;
  volumePrefixByDevice?: Record<string, string>;
  projectFolderName?: string;
  nextVolumeByDevice?: Record<string, number>;
  lastVolumeTimestampByDevice?: Record<string, string>;
  volumeTimestampCollisionByDevice?: Record<string, number>;
  shootingDate?: string;
  shootingDateStart?: string;
  shootingDateEnd?: string;
  devicePositions?: Record<string, string[]>;
  destinationPaths?: string[];
  status?: "active" | "archived";
  createdAt?: number;
}

export interface ProjectStructureDestination {
  destination: string;
  expectedCount: number;
  existingCount: number;
  missing: string[];
  conflicts: string[];
  error?: string;
}

export interface ProjectStructureReport {
  expectedCount: number;
  missingCount: number;
  conflictCount: number;
  destinations: ProjectStructureDestination[];
}
