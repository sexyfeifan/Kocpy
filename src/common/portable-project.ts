import { assertProjectTimeRules, validTimeContext } from "./time-context";
/** Portable evidence is historical context, never a local verified-copy/eject grant. */
export interface PortableProjectFile {
  application: "Kocpy portable project";
  schemaVersion: 1;
  revision: string;
  previousSha256?: string;
  createdAt: number;
  operator: string;
  provenance: "recorded-history" | "manifest-history" | "current-baseline";
  /** Automatic publication reuses original hashes, never claims a fresh full read. */
  verification?: "full-read" | "recorded-hashes";
  project: {
    projectTimeZone?: string;
    shootingDayTimeZones?: Record<string, string>;
    shootingDayBoundaryHour?: number;
    id: string;
    name: string;
    plannedStart?: string;
    plannedEnd?: string;
    devices: string[];
  };
  rolls: Array<{
    timeContext?: import("./time-context").TimeContext;
    id: string;
    name: string;
    dates: string[];
    devices: string[];
    status: string;
    files: number;
    bytes: number;
    scope: string;
  }>;
  files: Array<{
    path: string;
    size?: number;
    algorithm: "sha256" | "sha1" | "md5" | "xxhash32";
    checksum: string;
  }>;
  exclusions: Array<{
    path: string;
    at: number;
    operator: string;
    reason: string;
    expected: PortableProjectFile["files"][number];
  }>;
  integrity: string;
}

export interface PortableProjectInspection {
  root: string;
  sha256?: string;
  project?: PortableProjectFile["project"];
  revision?: string;
  provenance?: PortableProjectFile["provenance"];
  rolls: PortableProjectFile["rolls"];
  expectedFiles: number;
  currentFiles: number;
  currentBytes: number;
  missing: string[];
  mismatches: string[];
  exclusions: number;
}

export function portableProvenanceText(
  provenance: PortableProjectFile["provenance"],
) {
  return provenance === "recorded-history"
    ? "原任务记录与当前范围核对"
    : provenance === "manifest-history"
      ? "外部清单与当前范围核对"
      : "当前范围首次基线（历史原卡完整性未知）";
}

export interface PortableProjectImportRecord {
  id: string;
  projectId: string;
  sha256: string;
  revision: string;
  root: string;
  operator: string;
  importedAt: number;
  project: PortableProjectFile["project"];
  rolls: PortableProjectFile["rolls"];
  provenance: PortableProjectFile["provenance"];
  files: number;
  bytes: number;
  exclusions: number;
}

/** Reject malformed exchanged history; these records cannot authorize filesystem writes. */
export function validatePortableHistory(
  value: unknown,
): asserts value is PortableProjectImportRecord[] {
  if (Array.isArray(value)) for (const entry of value) {
    if (entry?.project) assertProjectTimeRules(entry.project);
    if (Array.isArray(entry?.rolls) && entry.rolls.some((roll: PortableProjectFile["rolls"][number]) => roll?.timeContext !== undefined && !validTimeContext(roll.timeContext))) throw new Error("随盘历史时间上下文无效");
  }
  const safe = (v: unknown, max = 4096) =>
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= max &&
    !/[\x00-\x1f\x7f]/.test(v);
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (r) =>
        !r ||
        typeof r !== "object" ||
        !safe(r.id, 160) ||
        !safe(r.projectId, 160) ||
        !/^[a-f0-9]{64}$/.test(r.sha256) ||
        !safe(r.revision, 80) ||
        !safe(r.root) ||
        !safe(r.operator, 120) ||
        !Number.isFinite(r.importedAt) ||
        !["recorded-history", "manifest-history", "current-baseline"].includes(
          r.provenance,
        ) ||
        !r.project ||
        !safe(r.project.id, 160) ||
        r.project.id !== r.projectId ||
        !safe(r.project.name, 512) ||
        !Array.isArray(r.project.devices) ||
        r.project.devices.length > 1000 ||
        !r.project.devices.every((v: unknown) => safe(v, 120)) ||
        !Array.isArray(r.rolls) ||
        r.rolls.length > 100000 ||
        r.rolls.some(
          (v: any) =>
            !v ||
            !safe(v.id, 160) ||
            !safe(v.name, 512) ||
            !safe(v.scope, 160) ||
            !safe(v.status, 40) ||
            !Number.isSafeInteger(v.files) ||
            v.files < 0 ||
            !Number.isSafeInteger(v.bytes) ||
            v.bytes < 0 ||
            !Array.isArray(v.dates) ||
            v.dates.length > 10000 ||
            v.dates.some(
              (d: any) =>
                typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d),
            ) ||
            !Array.isArray(v.devices) ||
            v.devices.length > 1000 ||
            !v.devices.every((d: any) => safe(d, 120)),
        ) ||
        [r.files, r.bytes, r.exclusions].some(
          (v) => !Number.isSafeInteger(v) || v < 0,
        ),
    )
  )
    throw new Error("随盘项目历史记录无效");
  if (new Set(value.map((r) => r.id)).size !== value.length)
    throw new Error("随盘项目历史存在重复证据身份");
}
