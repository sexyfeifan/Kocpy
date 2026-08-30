export type HashAlgorithm = "md5" | "sha1" | "sha256" | "xxhash32";
export type TaskStatus =
  | "pending"
  | "running"
  | "paused"
  | "verifying"
  | "completed"
  | "unverified"
  | "failed"
  | "cancelled";
export type CopyMode = "normal" | "mirror";
export type DuplicateStrategy = "skip" | "suffix";
export type ProxyStatus =
  "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type ProxyPreset = "review" | "editorial" | "offline";
export interface SavedProxyPreset {
  id: string;
  name: string;
  format: "h264" | "prores";
  resolution: string;
  bitrateMbps?: number;
  container: "mp4" | "mov" | "mkv";
  namingTemplate: string;
  createdAt: number;
  updatedAt: number;
}
export interface ProxyJob {
  id: string;
  input: string;
  name: string;
  outputDir: string;
  format: "h264" | "prores";
  resolution: string;
  bitrateMbps?: number;
  container?: "mp4" | "mov" | "mkv";
  status: ProxyStatus;
  progress: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  outputPath?: string;
  error?: string;
  timecode?: string;
  preset?: ProxyPreset;
  namingTemplate?: string;
  sourceTaskId?: string;
  sourceRelativePath?: string;
  sourceFrameRate?: string;
  sourceAudio?: string;
  sourceDuration?: string;
  sourceColorSpace?: string;
  dependsOn?: string[];
  validation?: {
    frameRate: "match" | "changed" | "unknown";
    timecode: "match" | "changed" | "unknown";
    audio: "present" | "missing" | "unknown";
    colorSpace?: "match" | "changed" | "unknown";
    notes: string[];
  };
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
  speedHistory?: Array<{ at: number; copy: number; verify: number }>;
  copySpeedSamples?: number[];
  verifySpeedSamples?: number[];
  performance?: TransferPerformance;
  verifyPerformance?: TransferPerformance;
}

export interface TransferPerformance {
  average: number;
  peak: number;
  p50: number;
  p95: number;
  samples: number;
  stalls: number;
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

export interface ExternalManifestComparison {
  path: string;
  algorithm?: HashAlgorithm;
  status: "structure-match" | "verified" | "mismatch" | "unsupported";
  entries: number;
  matched: number;
  missing: string[];
  extra: string[];
  sizeMismatches: Array<{
    relativePath: string;
    expected: number;
    actual: number;
  }>;
  checksumMismatches: string[];
  pathCollisionHints?: Array<{
    missingPath: string;
    extraPath: string;
    expectedSize?: number;
    actualSize: number;
  }>;
  checkedAt: number;
  resolution?:
    | {
        type: "accepted-extra";
        resolvedAt: number;
        note: string;
      }
    | {
        type: "revised-missing";
        resolvedAt: number;
        note: string;
        excluded: string[];
        originalManifestSha256: string;
        revisedManifestSha256: string;
        auditPath: string;
      };
}

export interface BackupTask {
  provenance?:
    | "kocpy-transfer"
    | "manifest-import"
    | "external-baseline"
    | "unverified-import";
  importedAt?: number;
  confidence?: "verified" | "baseline" | "unverified";
  externalManifest?: ExternalManifestComparison;
  projectId?: string;
  projectFolderName?: string;
  projectNamingRule?: string;
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
  sourceReadSpeedBps?: number;
  sourceSpeedHistory?: Array<{ at: number; speed: number }>;
  sourceHashSpeedBps?: number;
  sourceCopyReadSpeedBps?: number;
  sourceHashHistory?: Array<{ at: number; speed: number }>;
  sourceCopyReadHistory?: Array<{ at: number; speed: number }>;
  sourceHashPerformance?: TransferPerformance;
  sourceCopyReadPerformance?: TransferPerformance;
  performanceSummary?: string;
  mediaBreakdown?: Record<
    "video" | "photo" | "audio" | "other",
    { files: number; bytes: number }
  >;
  faultTimeline?: Array<{
    at: number;
    phase: string;
    level: "info" | "warning" | "error";
    message: string;
  }>;
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
  projectNamingRule?: string;
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

export interface ExistingImportProgress {
  jobId: string;
  phase: "analyzing" | "hashing" | "finalizing" | "completed" | "failed";
  message: string;
  totalFiles: number;
  completedFiles: number;
  totalBytes: number;
  completedBytes: number;
  totalCandidates: number;
  completedCandidates: number;
  currentCandidate?: string;
  currentFile?: string;
  speedBps: number;
  eta: number;
}

export interface ExistingReanalysisResult {
  importedTasks: number;
  metadataUpdated: number;
  baselinesNeeded: number;
  duplicatesFound: number;
  duplicatesMerged: number;
  rootsDeduplicated: number;
  unavailableSources: number;
  aggregateRecordsFound: number;
  aggregateRecordsRemoved: number;
  manifestDifferences: number;
  manifestsInspected: number;
  devicesDetected: string[];
  applied: boolean;
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

export interface BenchmarkResult {
  path: string;
  bytes: number;
  writeBps: number;
  readBps: number;
  durationMs: number;
  completedAt: number;
}
export interface ReliabilityValidationRecord {
  id: string;
  path: string;
  volumeName: string;
  fileSystem: string;
  checkedAt: number;
  status: "passed" | "failed";
  largeFileBytes: number;
  smallFiles: number;
  writeBps?: number;
  readBps?: number;
  durationMs: number;
  error?: string;
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
  coldArchivedAt?: number;
  coldArchiveFile?: string;
  createdAt?: number;
  restDays?: string[];
  unusedDevicesByDate?: Record<string, string[]>;
  expectedDevicesByDate?: Record<string, string[]>;
  requiredCopies?: number;
  namingRule?: string;
  completionActions?: Array<"report" | "delivery" | "proxy" | "eject">;
  handoffNotes?: Array<{
    id: string;
    at: number;
    operator: string;
    note: string;
  }>;
  managedSince?: string;
  expectedVolumes?: number;
  productionType?:
    "commercial" | "documentary" | "short" | "variety" | "feature" | "custom";
  crew?: Array<{
    id: string;
    name: string;
    role: "DIT" | "cinematographer" | "data-manager" | "assistant" | "other";
  }>;
  checklists?: Array<{
    id: string;
    phase: "start" | "close";
    label: string;
    required: boolean;
  }>;
  checklistRuns?: Array<{
    id: string;
    date: string;
    phase: "start" | "close";
    completed: string[];
    operator: string;
    signedAt?: number;
    signature?: string;
  }>;
  boundRoots?: Array<{
    id: string;
    path: string;
    boundAt: number;
    provenance: "manifest-import" | "external-baseline" | "unverified-import";
  }>;
  nasPresetId?: string;
}

export interface ArchiveHealthRecord {
  id: string;
  projectId: string;
  checkedAt: number;
  taskCount: number;
  healthyTasks: number;
  failedTasks: number;
  missingCopies: number;
  repairedFiles?: number;
  durationMs?: number;
  bytesVerified?: number;
  averageReadBps?: number;
  risk?: "healthy" | "attention" | "critical";
  scope?: "disk" | "project" | "day" | "card" | "file";
  notes: string[];
}
export interface ProjectTemplate {
  id: string;
  name: string;
  devices: string[];
  volumePrefix: string;
  requiredCopies: number;
  namingRule: string;
  completionActions: Array<"report" | "delivery" | "proxy" | "eject">;
  createdAt: number;
  updatedAt: number;
}
export interface WorkspaceMergeResult {
  projectsAdded: number;
  projectsUpdated: number;
  tasksAdded: number;
  duplicates: number;
  conflicts: string[];
  importedAt: number;
}

export interface ArchiveChangeRecord {
  id: string;
  projectId: string;
  taskId?: string;
  at: number;
  kind:
    | "verified"
    | "missing"
    | "damaged"
    | "modified"
    | "added"
    | "moved"
    | "disk-replaced"
    | "repaired";
  path?: string;
  from?: string;
  to?: string;
  note: string;
}
export interface ArchiveReminder {
  id: string;
  projectId: string;
  intervalDays: number;
  nextAt: number;
  enabled: boolean;
  lastNotifiedAt?: number;
}
export interface NasPreset {
  id: string;
  name: string;
  path: string;
  protocol: "smb" | "nfs" | "afp" | "network";
  expectedHost?: string;
  minimumWriteBps?: number;
  createdAt: number;
  lastCheckedAt?: number;
  online?: boolean;
  lastLatencyMs?: number;
  lastWriteBps?: number;
  lastError?: string;
}
export interface ProjectCoverage {
  recorded: number;
  verified: number;
  compliant: number;
  attention: number;
  byProvenance: Record<string, number>;
  managedSince?: string;
  expected?: number;
  coveragePercent?: number;
}
export interface ExistingImportPreview {
  root: string;
  files: number;
  bytes: number;
  detectedStructure: "card" | "day" | "project" | "unknown";
  warnings: string[];
  manifest?: string;
  suggestedDate?: string;
  suggestedDevice?: string;
  suggestedCard?: string;
  groups: Array<{
    key: string;
    relativeRoot: string;
    files: number;
    bytes: number;
    suggestedDate?: string;
    suggestedDevice?: string;
    suggestedCard?: string;
  }>;
  candidates: Array<{
    relativeRoot: string;
    files: number;
    bytes: number;
    shootingDate?: string;
    device?: string;
    cameraPosition?: string;
    card?: string;
  }>;
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
