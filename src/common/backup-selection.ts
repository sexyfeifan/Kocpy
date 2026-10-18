import type { InventoryScopeSnapshot, MediaDateSuggestionBasis } from "../main/types";
import type { VolumeIdentity } from "./volume-identity";
import type { StorageEvidence } from "./copy-evidence";

export interface BackupSelectionFile {
  relativePath: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

/** Historical claims are useful only after this concrete online file was read. */
export interface BackupSelectionHistoryEvidence {
  taskId: string;
  destinationId: string;
  relativePath: string;
  path: string;
  root: string;
  size: number;
  sha256: string;
  volumeIdentity: VolumeIdentity;
  storageEvidence: StorageEvidence;
  checkedAt: number;
}

export interface BackupSelectionGroup {
  id: string;
  label: string;
  relativePaths: string[];
  files: number;
  bytes: number;
  suggestedDate?: string;
  candidateDates: string[];
  basis: MediaDateSuggestionBasis;
  confidence: "high" | "review" | "unknown";
  evidence: string[];
  /** Unknown dependencies and indivisible camera packages cannot be deselected. */
  mandatory: boolean;
  mandatoryReason?: string;
  historyState: "verified" | "insufficient" | "unavailable" | "not-found";
  historyCopies: number;
  historyEvidence: BackupSelectionHistoryEvidence[];
}

export interface BackupSelectionPreview {
  timeContext?: import("./time-context").TimeContext;
  schemaVersion: 1;
  id: string;
  sourcePath: string;
  projectId?: string;
  requiredCopies: number;
  generatedAt: number;
  sourceScope: InventoryScopeSnapshot;
  sourceVolumeIdentity: VolumeIdentity;
  sourceRootBinding: { dev: number; ino: number };
  sourceFiles: BackupSelectionFile[];
  groups: BackupSelectionGroup[];
  digest: string;
}

export interface BackupSelectionDecision {
  selectedDates: string[];
  /** Explicitly reviewed shooting-day assignments; media timestamps remain suggestions. */
  assignedDates?: Record<string, string>;
  /** Only affects already unselected date groups, never the selected dates. */
  skipVerifiedHistory?: boolean;
  /** Required when any excluded file lacks verified historical protection. */
  allowUnprotectedExclusions?: boolean;
  operator: string;
}

export interface BackupSelectionPlan extends BackupSelectionPreview {
  selectedDates: string[];
  assignedDates: Record<string, string>;
  includedPaths: string[];
  excludedFiles: Array<{
    relativePath: string;
    groupId: string;
    reason: "user-date" | "history-verified";
    historyEvidence: BackupSelectionHistoryEvidence[];
  }>;
  confirmedAt: number;
  operator: string;
  /** All source content is in this task; historical coverage does not set this flag. */
  wholeCardCovered: boolean;
}

export interface BackupSelectionProgress {
  phase: "scanning" | "hashing" | "history" | "validating";
  currentFile?: string;
  completedFiles: number;
  totalFiles: number;
  completedBytes: number;
  totalBytes: number;
}

export interface BackupDateInspection {
  groups: BackupSelectionGroup[];
  dates: string[];
  unknownGroups: number;
  sourceFiles: number;
  totalBytes: number;
}

/** Conservative dependency closure shared by pre-copy and post-copy workflows. */
export function conservativeSelectionFamilies(relativePaths: string[], sourcePath = "") {
  const packageNames = new Set(["PRIVATE", "AVCHD", "CONTENTS", "XDROOT", "AVF_INFO", "BPAV"]);
  const video = /\.(mov|mp4|mxf|mts|m2ts|avi|r3d|braw|crm|ari|cine)$/i;
  const audio = /\.(wav|bwf|mp3|aac|flac|aif|aiff)$/i;
  const hasVideo = relativePaths.some((relative) => video.test(relative));
  const isPackage = (name: string) => packageNames.has(name.toUpperCase()) || /\.RDC$/i.test(name);
  // macOS canonical temporary paths start with /private; this is not a camera package.
  const packageRoot = sourcePath.split(/[\\/]/).some((name, index) =>
    !(index === 1 && name === "private" && sourcePath.startsWith("/private/")) && isPackage(name));
  const parent = relativePaths.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (left: number, right: number) => { parent[find(right)] = find(left); };
  const stems = new Map<string, number>(), packages = new Map<string, number>();
  relativePaths.forEach((relative, index) => {
    const parts = relative.split("/"), name = parts.at(-1)!;
    let stem = name.replace(/\.[^.]+$/, "").normalize("NFC").toLowerCase();
    const originalStem = stem;
    // Retain the earlier daily-delivery closure for explicitly named proxies,
    // previews, thumbnails and duplicate-name suffixes, now across directories.
    // Multiple suffixes (for example clip_proxy (1)) must not split a family.
    for (;;) {
      const stripped = stem.replace(/\s*\(\d+\)$/i, "")
        .replace(/(?:[_\-.](?:proxy|prox|preview|thumb|thumbnail))$/i, "");
      if (stripped === stem || !stripped) break;
      stem = stripped;
    }
    stem ||= originalStem;
    if (/\.xml$/i.test(name)) stem = stem.replace(/m\d{2}$/, "");
    // GoPro chapter numbers must not split a continuous recording.
    if (/^g[hpx]\d{6}$/i.test(stem)) stem = `gopro:${stem.slice(0, 2)}:${stem.slice(-4)}`;
    const prior = stems.get(stem);
    if (prior !== undefined) join(prior, index); else stems.set(stem, index);
    const packageIndex = parts.findIndex(isPackage);
    const key = packageRoot ? "." : packageIndex >= 0 ? parts.slice(0, packageIndex + 1).join("/") : undefined;
    if (key) { const first = packages.get(key); if (first !== undefined) join(first, index); else packages.set(key, index); }
  });
  const families = new Map<number, string[]>();
  relativePaths.forEach((relative, index) => { const key = find(index), family = families.get(key) || []; family.push(relative); families.set(key, family); });
  return [...families.values()].map((paths) => ({ relativePaths: paths.sort(),
    packageProtected: packageRoot || paths.some((relative) => relative.split("/").some(isPackage)),
    ...(hasVideo && paths.some((relative) => audio.test(relative)) && !paths.some((relative) => video.test(relative))
      ? { protectionReason: "独立录音与视频的关联无法可靠判定，保留音频及其伴随文件" } : {}) }));
}

export function validSelectionDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function backupSelectionSummary(plan: BackupSelectionPlan) {
  const excluded = new Set(plan.excludedFiles.map((file) => file.relativePath));
  return {
    includedFiles: plan.sourceFiles.length - excluded.size,
    includedBytes: plan.sourceFiles.reduce((sum, file) => sum + (excluded.has(file.relativePath) ? 0 : file.size), 0),
    excludedFiles: excluded.size,
    excludedBytes: plan.sourceFiles.reduce((sum, file) => sum + (excluded.has(file.relativePath) ? file.size : 0), 0),
    historicalFiles: plan.excludedFiles.filter((file) => file.reason === "history-verified").length,
    unprotectedFiles: plan.excludedFiles.filter((file) => file.reason === "user-date").length,
  };
}
