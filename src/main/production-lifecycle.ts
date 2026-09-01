import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonical, inside, safeChild, scan } from "./backup/safety";
import { hashFile } from "./backup/BackupEngine";
export { projectCoverage } from "../common/task-trust";
import type {
  BackupTask,
  ExternalManifestComparison,
  ExistingImportPreview,
  ExistingCandidateDecision,
  HashAlgorithm,
  ProjectConfig,
  ProjectTemplate,
} from "./types";
import { mediaBreakdownFromFiles } from "./media-kind";

const isManifestName = (name: string) =>
  /(?:\.mhl|sha(?:1|256)sums\.txt|manifest.*\.json)$/i.test(name);

const normalizeManifestPath = (value: string) =>
  value
    .trim()
    .replace(/^file:\/\//i, "")
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+/g, path.sep)
    .normalize("NFC");

const decodeXml = (value: string) =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const syncDirectory = async (directory: string) => {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
  } finally {
    await handle.close();
  }
};

interface ManifestEntry {
  checksum: string;
  size?: number;
}

interface ParsedManifest {
  file?: string;
  algorithm?: HashAlgorithm;
  entries: Map<string, ManifestEntry>;
}

export interface ManifestRepairResult {
  files: number;
  bytes: number;
  sourceRoot: string;
  manifestRoot: string;
}

export interface ManifestRevisionResult {
  excluded: string[];
  originalManifestSha256: string;
  revisedManifestSha256: string;
  auditPath: string;
}

const datePattern =
  /(?:19|20)\d{2}[-_.]?(?:0[1-9]|1[0-2])[-_.]?(?:0[1-9]|[12]\d|3[01])/;
const dateFolderPattern =
  /^((?:19|20)\d{2})[-_.]?((?:0[1-9]|1[0-2]))[-_.]?((?:0[1-9]|[12]\d|3[01]))$/;
const cardPattern = /(?:card|roll|卷|卡|a|b|c|d|e)[-_ ]?\d{1,4}/i;
const cameraPattern =
  /(?:fx\d|a\d{3,4}|c\d{2,3}|r\d|ursa|komodo|venice|alexa|red|cam)[-_ ]?[a-e]?/i;
const normalizedDate = (value?: string) =>
  value?.replace(/[^0-9]/g, "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

type ExistingScope = "card" | "day" | "project" | "auto";

function parseDateFolder(value?: string): string | undefined {
  const match = value?.match(dateFolderPattern);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function canonicalDevice(value: string | undefined, project?: ProjectConfig) {
  if (!value) return undefined;
  return (
    project?.devices.find(
      (device) =>
        device.localeCompare(value, undefined, { sensitivity: "accent" }) === 0,
    ) || value
  );
}

function canonicalPosition(
  value: string | undefined,
  device: string | undefined,
  project?: ProjectConfig,
) {
  if (!value) return undefined;
  const configured = device ? project?.devicePositions?.[device] || [] : [];
  const match = configured.find(
    (position) =>
      position.localeCompare(value, undefined, { sensitivity: "accent" }) === 0,
  );
  if (match) return match;
  const conventional = value.match(
    /^([A-E])(?:[\s_-]?(?:机位|机|cam(?:era)?))?$/i,
  );
  return conventional?.[1].toUpperCase();
}

function inferCardMetadata(
  root: string,
  project?: ProjectConfig,
  selectedDate?: string,
) {
  const parts = path.resolve(root).split(path.sep).filter(Boolean);
  let dateIndex = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parseDateFolder(parts[index])) {
      dateIndex = index;
      break;
    }
  }
  if (dateIndex >= 0 && project) {
    const structured = inferStructuredMetadata(
      parts,
      undefined,
      project,
      selectedDate,
      dateIndex,
    );
    if (structured)
      return {
        shootingDate: structured.shootingDate,
        device: structured.device,
        cameraPosition: structured.cameraPosition,
        card: path.basename(root),
      };
  }
  let deviceIndex = dateIndex >= 0 ? dateIndex + 1 : -1;
  if (deviceIndex < 0 && project) {
    for (let index = parts.length - 2; index >= 0; index--) {
      if (
        project.devices.some(
          (device) =>
            device.localeCompare(parts[index], undefined, {
              sensitivity: "accent",
            }) === 0,
        )
      ) {
        deviceIndex = index;
        break;
      }
    }
  }
  const device = canonicalDevice(
    deviceIndex >= 0 && deviceIndex < parts.length - 1
      ? parts[deviceIndex]
      : undefined,
    project,
  );
  const cameraPosition = canonicalPosition(
    deviceIndex >= 0 ? parts[deviceIndex + 1] : undefined,
    device,
    project,
  );
  return {
    shootingDate:
      selectedDate ||
      (dateIndex >= 0 ? parseDateFolder(parts[dateIndex]) : undefined),
    device,
    cameraPosition,
    card: path.basename(root),
  };
}

function detectScope(
  root: string,
  relativePaths: string[],
  project?: ProjectConfig,
): Exclude<ExistingScope, "auto"> | "unknown" {
  if (parseDateFolder(path.basename(root))) return "day";
  const layout = projectFolderLayout(project);
  const layoutDateIndex = layout.indexOf("shootingDate");
  const layoutDeviceIndex = layout.indexOf("device");
  const projectStructure = relativePaths.some((relativePath) => {
    const directories = relativePath.split(path.sep).slice(0, -1);
    return directories.some((part, dateIndex) => {
      if (!parseDateFolder(part)) return false;
      if (!project?.devices.length) return dateIndex <= 1;
      const shift = dateIndex - layoutDateIndex;
      const device = directories[layoutDeviceIndex + shift];
      return project.devices.some(
        (configured) =>
          configured.localeCompare(device, undefined, {
            sensitivity: "accent",
          }) === 0,
      );
    });
  });
  if (projectStructure) return "project";
  return relativePaths.length ? "card" : "unknown";
}

type FolderRole = "shootingDate" | "device" | "position" | "card" | "other";

function projectFolderLayout(project?: ProjectConfig): FolderRole[] {
  const rule =
    project?.namingRule ||
    "{date}_{project}/{shootingDate}/{device}/{position}/{card}";
  const segments = rule.split(/[\\/]+/).filter(Boolean);
  const projectIndex = segments.findIndex((segment) =>
    segment.includes("{project}"),
  );
  const relevant =
    projectIndex >= 0 ? segments.slice(projectIndex + 1) : segments;
  const roles = relevant.map((segment): FolderRole => {
    if (segment.includes("{shootingDate}")) return "shootingDate";
    if (segment.includes("{device}")) return "device";
    if (segment.includes("{position}")) return "position";
    if (segment.includes("{card}")) return "card";
    return "other";
  });
  if (!roles.includes("card")) roles.push("card");
  return roles;
}

function inferStructuredMetadata(
  directoryParts: string[],
  rootDate: string | undefined,
  project?: ProjectConfig,
  selectedDate?: string,
  preferredDateIndex?: number,
) {
  const dateIndex =
    preferredDateIndex ??
    directoryParts.findIndex((part) => Boolean(parseDateFolder(part)));
  const shootingDate =
    dateIndex >= 0
      ? parseDateFolder(directoryParts[dateIndex])
      : rootDate || selectedDate;
  if (!shootingDate) return undefined;
  const layout = projectFolderLayout(project);
  const layoutDateIndex = layout.indexOf("shootingDate");
  const shift =
    layoutDateIndex >= 0
      ? dateIndex >= 0
        ? dateIndex - layoutDateIndex
        : -layoutDateIndex - 1
      : 0;
  const resolveIndex = (role: FolderRole) => {
    const index = layout.indexOf(role);
    return index < 0 ? -1 : index + shift;
  };
  let deviceIndex = resolveIndex("device");
  if (deviceIndex < 0 || deviceIndex >= directoryParts.length)
    deviceIndex = dateIndex + 1;
  const device = canonicalDevice(directoryParts[deviceIndex], project);
  if (!device) return undefined;
  const positionIndex = resolveIndex("position");
  const cameraPosition = canonicalPosition(
    directoryParts[positionIndex],
    device,
    project,
  );
  let cardIndex = resolveIndex("card");
  if (positionIndex >= 0 && !cameraPosition && cardIndex > positionIndex)
    cardIndex--;
  if (cardIndex < 0 || cardIndex >= directoryParts.length) {
    const fallbackPosition = canonicalPosition(
      directoryParts[deviceIndex + 1],
      device,
      project,
    );
    cardIndex = deviceIndex + (fallbackPosition ? 2 : 1);
  }
  const candidateEnd =
    cardIndex < directoryParts.length ? cardIndex + 1 : directoryParts.length;
  return {
    shootingDate,
    device,
    cameraPosition,
    relativeRoot: candidateEnd
      ? directoryParts.slice(0, candidateEnd).join(path.sep)
      : ".",
    card:
      cardIndex < directoryParts.length
        ? directoryParts[cardIndex]
        : directoryParts.at(-1),
  };
}

export async function previewExistingBackup(
  root: string,
  project?: ProjectConfig,
  requestedScope: ExistingScope = "auto",
  selectedDate?: string,
): Promise<ExistingImportPreview> {
  root = await canonical(root);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error("接管路径必须是文件夹");
  const result = await scan(root, false),
    groupMap = new Map<string, ExistingImportPreview["groups"][number]>();
  for (const file of result.files) {
    const parts = file.relativePath.split(path.sep),
      relativeRoot = parts.length > 1 ? parts[0] : ".",
      current = groupMap.get(relativeRoot) || {
        key: relativeRoot,
        relativeRoot,
        files: 0,
        bytes: 0,
      };
    current.files++;
    current.bytes += file.size;
    const sample = parts.join("/");
    current.suggestedDate ||= normalizedDate(sample.match(datePattern)?.[0]);
    current.suggestedDevice ||= sample.match(cameraPattern)?.[0]?.toUpperCase();
    current.suggestedCard ||= sample.match(cardPattern)?.[0];
    groupMap.set(relativeRoot, current);
  }
  // A card-level manifest must live at the selected card root. Picking a
  // nested manifest made a date/device parent look like a single media roll.
  const manifestFile = result.files.find(
    (file) =>
      isManifestName(file.name) && path.dirname(file.relativePath) === ".",
  );
  const sample = result.files
    .slice(0, 200)
    .map((file) => file.relativePath)
    .join("/");
  const candidateMap = new Map<
      string,
      Omit<ExistingImportPreview["candidates"][number], "id" | "issues">
    >(),
    mediaFiles = result.files.filter((file) => !isManifestName(file.name));
  const detectedStructure = detectScope(
    root,
    mediaFiles.map((file) => file.relativePath),
    project,
  );
  const scope = requestedScope === "auto" ? detectedStructure : requestedScope;
  const rootDate = parseDateFolder(path.basename(root));
  const cardMetadata = inferCardMetadata(root, project, selectedDate);
  for (const file of mediaFiles) {
    const allParts = file.relativePath.split(path.sep);
    const directoryParts = allParts.slice(0, -1);
    let relativeRoot = ".";
    let shootingDate: string | undefined;
    let device: string | undefined;
    let cameraPosition: string | undefined;
    let card: string | undefined;
    if (scope === "card" || scope === "unknown") {
      ({ shootingDate, device, cameraPosition, card } = cardMetadata);
    } else {
      const inferred = inferStructuredMetadata(
        directoryParts,
        rootDate,
        project,
        selectedDate,
      );
      if (!inferred) continue;
      ({ shootingDate, device, cameraPosition, card, relativeRoot } = inferred);
      if (scope === "day" && selectedDate && shootingDate !== selectedDate)
        continue;
    }
    const value = candidateMap.get(relativeRoot) || {
      relativeRoot,
      files: 0,
      bytes: 0,
      shootingDate,
      device,
      cameraPosition,
      card: card || path.basename(relativeRoot === "." ? root : relativeRoot),
    };
    value.files++;
    value.bytes += file.size;
    candidateMap.set(relativeRoot, value);
  }
  const candidates = [...candidateMap.values()]
    .sort((a, b) => a.relativeRoot.localeCompare(b.relativeRoot))
    .map((candidate) => ({
      ...candidate,
      id: createHash("sha256")
        .update(`${path.resolve(root).normalize("NFC")}\0${candidate.relativeRoot.normalize("NFC")}`)
        .digest("hex")
        .slice(0, 24),
      issues: [] as ExistingImportPreview["candidates"][number]["issues"],
    }));
  const warnings: string[] = [];
  if (!candidates.length && mediaFiles.length)
    warnings.push("所选范围内没有识别到符合层级的素材卷");
  const unknownDevices = [
    ...new Set(
      candidates
        .map((candidate) => candidate.device)
        .filter((device): device is string =>
          Boolean(device && project && !project.devices.includes(device)),
        ),
    ),
  ];
  if (unknownDevices.length)
    warnings.push(`发现项目配置外的设备：${unknownDevices.join("、")}`);
  if (
    (scope === "project" || scope === "day") &&
    !candidates.every((candidate) => candidate.shootingDate)
  )
    warnings.push("部分目录没有可识别的拍摄日期");
  const duplicateKeys = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.shootingDate) candidate.issues.push("missing-date");
    if (!candidate.device) candidate.issues.push("missing-device");
    if (!candidate.card) candidate.issues.push("missing-card");
    const key = [
      candidate.shootingDate || "",
      candidate.device || "",
      candidate.cameraPosition || "",
      candidate.card || "",
    ].join("\0");
    duplicateKeys.set(key, (duplicateKeys.get(key) || 0) + 1);
  }
  for (const candidate of candidates) {
    const key = [
      candidate.shootingDate || "",
      candidate.device || "",
      candidate.cameraPosition || "",
      candidate.card || "",
    ].join("\0");
    if ((duplicateKeys.get(key) || 0) > 1)
      candidate.issues.push("duplicate-mapping");
  }
  const blockingIssues: ExistingImportPreview["blockingIssues"] = [];
  if (scope === "unknown")
    blockingIssues.push({
      code: "unknown-structure",
      message: "无法确定所选目录是单卷、单日还是整个项目，请明确选择接管范围",
    });
  const issueLabels = {
    "missing-date": "拍摄日期未识别",
    "missing-device": "设备 / 机位未识别",
    "missing-card": "素材卷名称未识别",
    "duplicate-mapping": "与另一目录映射到同一素材卷",
  } as const;
  for (const candidate of candidates)
    for (const code of candidate.issues)
      blockingIssues.push({
        code,
        relativeRoot: candidate.relativeRoot,
        message: `${candidate.relativeRoot === "." ? path.basename(root) : candidate.relativeRoot}：${issueLabels[code]}`,
      });
  const scannedAt = Date.now(),
    scanDigest = createHash("sha256")
      .update(
        JSON.stringify({
          root: path.resolve(root).normalize("NFC"),
          scope,
          selectedDate,
          files: result.files
            .map((file) => [
              file.relativePath.normalize("NFC"),
              file.size,
              file.mtimeMs,
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          directories: result.directoryMetadata
            .map((directory) => [
              directory.relativePath.normalize("NFC"),
              directory.mtimeMs,
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          candidates: candidates.map((candidate) => [
            candidate.relativeRoot,
            candidate.shootingDate,
            candidate.device,
            candidate.cameraPosition,
            candidate.card,
          ]),
        }),
      )
      .digest("hex");
  return {
    root,
    scannedAt,
    scanDigest,
    files: result.files.length,
    bytes: result.totalBytes,
    detectedStructure,
    warnings,
    blockingIssues,
    canImport: candidates.length > 0 && blockingIssues.length === 0,
    manifest: manifestFile?.absolutePath,
    suggestedDate:
      candidates[0]?.shootingDate ||
      normalizedDate(sample.match(datePattern)?.[0]),
    suggestedDevice:
      candidates[0]?.device || sample.match(cameraPattern)?.[0]?.toUpperCase(),
    suggestedCard: candidates[0]?.card || sample.match(cardPattern)?.[0],
    groups: [...groupMap.values()].sort((a, b) =>
      a.relativeRoot.localeCompare(b.relativeRoot),
    ),
    candidates,
  };
}

export function resolveExistingCandidates(
  preview: ExistingImportPreview,
  decisions: ExistingCandidateDecision[] = [],
): ExistingCandidateDecision[] {
  const byRoot = new Map(decisions.map((item) => [item.relativeRoot, item]));
  const resolved = preview.candidates.map((candidate) => {
    const decision = byRoot.get(candidate.relativeRoot);
    return {
      relativeRoot: candidate.relativeRoot,
      shootingDate: (decision?.shootingDate || candidate.shootingDate || "").trim(),
      device: (decision?.device || candidate.device || "").trim(),
      cameraPosition: (decision?.cameraPosition || candidate.cameraPosition || "").trim() || undefined,
      card: (decision?.card || candidate.card || "").trim(),
    };
  });
  for (const item of resolved) {
    if (!parseDateFolder(item.shootingDate))
      throw new Error(`请为 ${item.relativeRoot} 确认有效拍摄日期`);
    if (!item.device || item.device.length > 160 || /[\\/]/.test(item.device))
      throw new Error(`请为 ${item.relativeRoot} 确认设备 / 机位名称`);
    if (
      item.cameraPosition &&
      (item.cameraPosition.length > 160 || /[\\/]/.test(item.cameraPosition))
    )
      throw new Error(`请为 ${item.relativeRoot} 确认有效机位名称`);
    if (!item.card || item.card.length > 160 || /[\\/]/.test(item.card))
      throw new Error(`请为 ${item.relativeRoot} 确认素材卷名称`);
  }
  const identities = resolved.map((item) =>
    [item.shootingDate, item.device, item.cameraPosition || "", item.card].join("\0"),
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("仍有多个目录映射到同一个日期 / 设备 / 机位 / 素材卷，请修正后再接管");
  return resolved;
}

function checksumAlgorithm(
  tag: string | undefined,
  checksum: string,
): HashAlgorithm | undefined {
  const normalized = tag?.toLowerCase();
  if (normalized === "xxhash" || normalized === "xxhash32") return "xxhash32";
  if (normalized === "md5" || normalized === "sha1" || normalized === "sha256")
    return normalized;
  if (/^\d{1,10}$/.test(checksum)) return "xxhash32";
  if (/^[a-f0-9]{32}$/i.test(checksum)) return "md5";
  if (/^[a-f0-9]{40}$/i.test(checksum)) return "sha1";
  if (/^[a-f0-9]{64}$/i.test(checksum)) return "sha256";
  return undefined;
}

function normalizeChecksum(value: string, algorithm?: HashAlgorithm) {
  const trimmed = value.trim();
  return algorithm === "xxhash32"
    ? String(Number(trimmed) >>> 0)
    : trimmed.toLowerCase();
}

async function readManifest(file?: string): Promise<ParsedManifest> {
  const result: ParsedManifest = { file, entries: new Map() };
  if (!file) return result;
  const text = await fs.readFile(file, "utf8");
  const add = (
    name: unknown,
    checksum: unknown,
    tag?: string,
    size?: unknown,
  ) => {
    if (typeof name !== "string" || typeof checksum !== "string") return;
    const algorithm = checksumAlgorithm(tag, checksum);
    if (!algorithm) return;
    if (result.algorithm && result.algorithm !== algorithm)
      throw new Error("外部清单混用了多种哈希算法，无法可靠解释");
    const decodedName = decodeXml(name).replace(/^file:\/\//i, ""),
      normalizedInput = decodedName.replaceAll("\\", "/");
    if (
      normalizedInput.split("/").includes("..") ||
      normalizedInput.includes("\0")
    )
      throw new Error("外部清单包含越界或无效路径");
    const relativePath = normalizeManifestPath(decodedName);
    if (!relativePath) return;
    if (result.entries.has(relativePath))
      throw new Error(`外部清单包含重复路径：${relativePath}`);
    result.algorithm = algorithm;
    const parsedSize = Number(size);
    result.entries.set(relativePath, {
      checksum: normalizeChecksum(checksum, algorithm),
      size: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : undefined,
    });
  };
  for (const match of text.matchAll(/<hash(?:\s[^>]*)?>([\s\S]*?)<\/hash>/gi)) {
    const block = match[1];
    const nameMatch = block.match(
      /<(path|file)(?:\s[^>]*)?>([^<]+)<\/\1>/i,
    );
    const checksumMatch = block.match(
      /<(md5|sha1|sha256|xxhash(?:32)?)(?:\s[^>]*)?>([a-f0-9]+)<\/\1>/i,
    );
    const sizeText =
      block.match(/<size(?:\s[^>]*)?>(\d+)<\/size>/i)?.[1] ||
      nameMatch?.[0].match(/\bsize=["'](\d+)["']/i)?.[1];
    add(nameMatch?.[2], checksumMatch?.[2], checksumMatch?.[1], sizeText);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{32,64}|\d{1,10})\s+\*?(.+)$/i);
    if (match) add(match[2], match[1]);
  }
  if (/\.json$/i.test(file)) {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return result;
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed.files || parsed.entries || [];
    for (const row of rows) {
      const name = row.path || row.file || row.relativePath;
      const tagged = ["sha256", "sha1", "md5", "xxhash32", "xxhash"].find(
        (key) => typeof row[key] === "string",
      );
      add(name, tagged ? row[tagged] : row.checksum, tagged, row.size);
    }
  }
  return result;
}

function compareManifestStructure(
  manifest: ParsedManifest,
  files: Array<{ relativePath: string; size: number }>,
): ExternalManifestComparison | undefined {
  if (!manifest.file) return undefined;
  const actual = new Map(
    files
      .filter((file) => !isManifestName(path.basename(file.relativePath)))
      .map((file) => [normalizeManifestPath(file.relativePath), file]),
  );
  const missing: string[] = [],
    extra: string[] = [],
    sizeMismatches: ExternalManifestComparison["sizeMismatches"] = [];
  let matched = 0;
  for (const [relativePath, expected] of manifest.entries) {
    const file = actual.get(relativePath);
    if (!file) missing.push(relativePath);
    else if (expected.size !== undefined && expected.size !== file.size)
      sizeMismatches.push({ relativePath, expected: expected.size, actual: file.size });
    else matched++;
  }
  for (const relativePath of actual.keys())
    if (!manifest.entries.has(relativePath)) extra.push(relativePath);
  const collisionKey = (relativePath: string) => {
      const parsed = path.parse(relativePath),
        stem = parsed.name.replace(/\s*\(\d+\)$/u, "");
      return path
        .join(parsed.dir, `${stem}${parsed.ext}`)
        .normalize("NFC")
        .toLocaleLowerCase();
    },
    extrasByCollisionKey = new Map<string, string[]>();
  for (const relativePath of extra) {
    const key = collisionKey(relativePath),
      values = extrasByCollisionKey.get(key) || [];
    values.push(relativePath);
    extrasByCollisionKey.set(key, values);
  }
  const pathCollisionHints = missing.flatMap((missingPath) => {
    const candidates = extrasByCollisionKey.get(collisionKey(missingPath)) || [];
    if (candidates.length !== 1 || candidates[0] === missingPath) return [];
    const extraPath = candidates[0],
      current = actual.get(extraPath),
      expected = manifest.entries.get(missingPath);
    return current
      ? [{
          missingPath,
          extraPath,
          expectedSize: expected?.size,
          actualSize: current.size,
        }]
      : [];
  });
  const mismatch = Boolean(missing.length || extra.length || sizeMismatches.length);
  return {
    path: manifest.file,
    algorithm: manifest.algorithm,
    status: !manifest.entries.size
      ? "unsupported"
      : mismatch
        ? "mismatch"
        : "structure-match",
    entries: manifest.entries.size,
    matched,
    missing,
    extra,
    sizeMismatches,
    checksumMismatches: [],
    pathCollisionHints,
    checkedAt: Date.now(),
  };
}

export async function inspectExternalManifest(
  root: string,
): Promise<ExternalManifestComparison | undefined> {
  const scanned = await scan(root, false);
  const manifestFile = scanned.files.find(
    (file) => isManifestName(file.name) && path.dirname(file.relativePath) === ".",
  );
  if (!manifestFile) return undefined;
  return compareManifestStructure(
    await readManifest(manifestFile.absolutePath),
    scanned.files,
  );
}

export async function reviseMhlMissingEntries(
  manifestPath: string,
  missing: string[],
  auditRoot: string,
): Promise<ManifestRevisionResult> {
  if (!/\.mhl$/i.test(manifestPath))
    throw new Error("只有 MHL 清单支持经审计的缺失项修订");
  const originalPathInfo = await fs.lstat(manifestPath);
  if (!originalPathInfo.isFile() || originalPathInfo.isSymbolicLink())
    throw new Error("MHL 必须是普通文件，不能是符号链接");
  manifestPath = await canonical(manifestPath);
  const original = await readManifest(manifestPath);
  if (!original.algorithm || !original.entries.size)
    throw new Error("MHL 不含可用于修订的有效校验记录");
  const excluded = [
    ...new Set(missing.map((relativePath) => normalizeManifestPath(relativePath))),
  ].sort();
  if (!excluded.length) throw new Error("当前 MHL 没有可排除的缺失记录");
  for (const relativePath of excluded)
    if (!original.entries.has(relativePath))
      throw new Error(`MHL 中找不到待排除记录：${relativePath}`);

  const originalManifestSha256 = await hashFile(manifestPath, "sha256"),
    text = await fs.readFile(manifestPath, "utf8"),
    textSha256 = createHash("sha256").update(text).digest("hex"),
    excludedSet = new Set(excluded),
    hashBlockPattern = /<hash(?:\s[^>]*)?>([\s\S]*?)<\/hash>\s*/gi;
  if (textSha256 !== originalManifestSha256)
    throw new Error("MHL 在读取期间发生变化，请重新完整核对后再修订");
  let removedBlocks = 0;
  const revisedText = text.replace(hashBlockPattern, (whole, block: string) => {
    const nameMatch = block.match(
        /<(path|file)(?:\s[^>]*)?>([^<]+)<\/\1>/i,
      ),
      relativePath = nameMatch?.[2]
        ? normalizeManifestPath(decodeXml(nameMatch[2]))
        : "";
    if (!excludedSet.has(relativePath)) return whole;
    removedBlocks++;
    return "";
  });
  if (removedBlocks !== excluded.length)
    throw new Error(
      `MHL 结构与解析记录不一致：应排除 ${excluded.length} 项，实际定位 ${removedBlocks} 项，未修改清单`,
    );

  auditRoot = await canonical(auditRoot);
  await fs.mkdir(auditRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-"),
    auditPath = path.join(
      auditRoot,
      `${stamp}-${originalManifestSha256.slice(0, 16)}-${randomUUID().slice(0, 8)}-${path.basename(manifestPath)}`,
    );
  await fs.copyFile(manifestPath, auditPath, constants.COPYFILE_EXCL);
  const auditHandle = await fs.open(auditPath, "r");
  try {
    await auditHandle.sync();
  } finally {
    await auditHandle.close();
  }
  if ((await hashFile(auditPath, "sha256")) !== originalManifestSha256)
    throw new Error("原始 MHL 审计副本校验失败，未修改生效清单");
  await syncDirectory(path.dirname(auditPath));

  const temporary = `${manifestPath}.kocpy-revision-${randomUUID()}.partial`;
  try {
    const handle = await fs.open(temporary, "wx", originalPathInfo.mode);
    try {
      await handle.writeFile(revisedText, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const revised = await readManifest(temporary);
    if (
      revised.algorithm !== original.algorithm ||
      revised.entries.size !== original.entries.size - excluded.length ||
      excluded.some((relativePath) => revised.entries.has(relativePath))
    )
      throw new Error("修订后的 MHL 自检失败，生效清单保持不变");
    const revisedManifestSha256 = await hashFile(temporary, "sha256");
    if ((await hashFile(manifestPath, "sha256")) !== originalManifestSha256)
      throw new Error("MHL 在修订期间被其他程序修改，已停止替换");
    await fs.chmod(temporary, originalPathInfo.mode);
    await fs.rename(temporary, manifestPath);
    await syncDirectory(path.dirname(manifestPath));
    return {
      excluded,
      originalManifestSha256,
      revisedManifestSha256,
      auditPath,
    };
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

interface ManifestRepairCandidate {
  sourceRoot: string;
  manifestRoot: string;
}

interface PlannedManifestRepair {
  relativePath: string;
  source: string;
  target: string;
  size: number;
  checksum: string;
  mode: number;
  atimeMs: number;
  mtimeMs: number;
}

const repairPathKey = (value: string) => value.normalize("NFC").toLowerCase();

function commonManifestDirectory(relativePaths: string[]) {
  const directories = relativePaths.map((relativePath) =>
    normalizeManifestPath(relativePath).split(path.sep).filter(Boolean).slice(0, -1),
  );
  if (!directories.length) return "";
  const common = [...directories[0]];
  for (const directory of directories.slice(1)) {
    let index = 0;
    while (
      index < common.length &&
      index < directory.length &&
      repairPathKey(common[index]) === repairPathKey(directory[index])
    )
      index++;
    common.length = index;
  }
  return common.join(path.sep);
}

function endsWithPath(value: string, suffix: string[]) {
  const components = path.resolve(value).split(path.sep).filter(Boolean);
  if (suffix.length > components.length) return false;
  return suffix.every(
    (component, index) =>
      repairPathKey(component) ===
      repairPathKey(components[components.length - suffix.length + index]),
  );
}

async function manifestRepairCandidates(
  healthyRoot: string,
  missing: string[],
): Promise<ManifestRepairCandidate[]> {
  const commonRoot = commonManifestDirectory(missing),
    candidates = new Map<string, ManifestRepairCandidate>();
  const add = async (sourceRoot: string, manifestRoot: string) => {
    const canonicalRoot = await canonical(sourceRoot),
      key = `${canonicalRoot.normalize("NFC")}\0${manifestRoot.normalize("NFC")}`;
    candidates.set(key, { sourceRoot: canonicalRoot, manifestRoot });
  };
  await add(healthyRoot, "");
  if (!commonRoot) return [...candidates.values()];

  const commonComponents = commonRoot.split(path.sep).filter(Boolean),
    suffixes = commonComponents.map((_, index) => commonComponents.slice(index)),
    queue: Array<{ directory: string; depth: number }> = [
      { directory: healthyRoot, depth: 0 },
    ];
  while (queue.length) {
    const current = queue.shift()!;
    if (suffixes.some((suffix) => endsWithPath(current.directory, suffix)))
      await add(current.directory, commonRoot);
    if (current.depth >= 4) continue;
    const entries = await fs
      .readdir(current.directory, { withFileTypes: true })
      .catch((error) => {
        if (current.depth === 0) throw error;
        return [];
      });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith(".") ||
        [".Spotlight-V100", ".Trashes", ".fseventsd"].includes(entry.name)
      )
        continue;
      queue.push({
        directory: path.join(current.directory, entry.name),
        depth: current.depth + 1,
      });
    }
  }
  return [...candidates.values()];
}

async function ensureRepairSpace(targetRoot: string, files: PlannedManifestRepair[]) {
  const statfs = await fs
    .statfs(targetRoot, { bigint: true })
    .catch(() => undefined);
  if (!statfs) return;
  const bytes = files.reduce((sum, file) => sum + BigInt(file.size), 0n),
    largest = files.reduce(
      (result, file) => (BigInt(file.size) > result ? BigInt(file.size) : result),
      0n,
    ),
    reserve = 64n * 1024n * 1024n,
    required = bytes + largest + reserve,
    available = statfs.bavail * statfs.bsize;
  if (available < required)
    throw new Error(
      `目标空间不足：安全修复至少需要 ${required} 字节，当前可用 ${available} 字节`,
    );
}

export async function repairMissingManifestFiles(
  targetRoot: string,
  healthyRoot: string,
  manifestPath: string,
  missing: string[],
  progress?: {
    onPlan?: (
      files: number,
      bytes: number,
      mapping: { sourceRoot: string; manifestRoot: string },
    ) => void;
    onBytes?: (bytes: number, file: string) => void;
    onFile?: (file: string) => void;
  },
): Promise<ManifestRepairResult> {
  targetRoot = await canonical(targetRoot);
  healthyRoot = await canonical(healthyRoot);
  if (inside(healthyRoot, targetRoot) || inside(targetRoot, healthyRoot))
    throw new Error("健康副本与待修复目录不能相同或互相包含");
  const manifest = await readManifest(manifestPath);
  if (!manifest.algorithm || !manifest.entries.size)
    throw new Error("外部清单不含可用于修复的校验值");
  if (!missing.length) throw new Error("这份素材卷没有待补回的缺失文件");

  const normalizedMissing = [
    ...new Set(missing.map((relativePath) => normalizeManifestPath(relativePath))),
  ];
  for (const relativePath of normalizedMissing) {
    const target = await safeChild(targetRoot, relativePath);
    if (
      await fs
        .access(target)
        .then(() => true, () => false)
    )
      throw new Error(`目标中已出现文件，请先重新完整核对：${relativePath}`);
  }

  const candidates = await manifestRepairCandidates(healthyRoot, normalizedMissing),
    evaluated: Array<{
      candidate: ManifestRepairCandidate;
      planned: PlannedManifestRepair[];
      found: number;
      wrongSize: number;
    }> = [];
  for (const candidate of candidates) {
    const planned: PlannedManifestRepair[] = [];
    let found = 0,
      wrongSize = 0;
    for (const relativePath of normalizedMissing) {
      const sourceRelative = candidate.manifestRoot
          ? path.relative(candidate.manifestRoot, relativePath)
          : relativePath,
        expected = manifest.entries.get(relativePath);
      if (!expected || sourceRelative.startsWith(`..${path.sep}`) || sourceRelative === "..")
        continue;
      const source = await safeChild(candidate.sourceRoot, sourceRelative),
        target = await safeChild(targetRoot, relativePath),
        stat = await fs.stat(source).catch(() => undefined),
        sourceInfo = stat ? await fs.lstat(source).catch(() => undefined) : undefined;
      if (!stat?.isFile() || sourceInfo?.isSymbolicLink()) continue;
      found++;
      if (expected.size !== undefined && expected.size !== stat.size) {
        wrongSize++;
        continue;
      }
      planned.push({
        relativePath,
        source,
        target,
        size: stat.size,
        checksum: expected.checksum,
        mode: stat.mode,
        atimeMs: stat.atimeMs,
        mtimeMs: stat.mtimeMs,
      });
    }
    evaluated.push({ candidate, planned, found, wrongSize });
  }
  const complete = evaluated.filter(
      (item) => item.planned.length === normalizedMissing.length,
    ),
    unique = new Map<
      string,
      (typeof complete)[number]
    >();
  for (const item of complete) {
    const signature = item.planned
      .map((file) => file.source.normalize("NFC"))
      .sort()
      .join("\0");
    if (!unique.has(signature)) unique.set(signature, item);
  }
  if (!unique.size) {
    const best = evaluated.sort(
      (left, right) =>
        right.planned.length - left.planned.length || right.found - left.found,
    )[0];
    const expectedRoot = commonManifestDirectory(normalizedMissing) || "素材卷根目录";
    throw new Error(
      `所选健康副本无法唯一对应清单路径：最多找到 ${best?.found || 0}/${normalizedMissing.length} 个文件${best?.wrongSize ? `，其中 ${best.wrongSize} 个大小不符` : ""}。请选择包含「${expectedRoot}」或其末级目录的上级文件夹`,
    );
  }
  if (unique.size > 1)
    throw new Error(
      `所选目录中发现 ${unique.size} 套均可匹配的健康副本，无法安全判断。请改为选择其中一套素材卷或末级素材目录`,
    );
  const selected = [...unique.values()][0],
    planned = selected.planned,
    mapping = selected.candidate;
  await ensureRepairSpace(targetRoot, planned);
  progress?.onPlan?.(
    planned.length,
    planned.reduce((sum, file) => sum + file.size, 0),
    mapping,
  );

  for (const file of planned) {
    const checksum = await hashFile(
      file.source,
      manifest.algorithm,
      undefined,
      (count) => progress?.onBytes?.(count, file.relativePath),
    );
    if (normalizeChecksum(checksum, manifest.algorithm) !== file.checksum)
      throw new Error(`健康副本校验值不符：${file.relativePath}`);
    progress?.onFile?.(file.relativePath);
  }

  for (const file of planned)
    if (
      await fs
        .access(file.target)
        .then(() => true, () => false)
    )
      throw new Error(`目标中已出现文件，请先重新完整核对：${file.relativePath}`);

  const stagingRoot = path.join(
      targetRoot,
      `.kocpy-repair-${randomUUID()}.partial`,
    ),
    staged: Array<PlannedManifestRepair & { stagedPath: string }> = [],
    committed: string[] = [];
  let copiedBytes = 0;
  await fs.mkdir(stagingRoot, { recursive: false });
  try {
    for (const file of planned) {
      const stagedPath = await safeChild(stagingRoot, file.relativePath);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true });
      await fs.copyFile(file.source, stagedPath, constants.COPYFILE_EXCL);
      const handle = await fs.open(stagedPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const checksum = await hashFile(
        stagedPath,
        manifest.algorithm,
        undefined,
        (count) => progress?.onBytes?.(count, file.relativePath),
      );
      if (normalizeChecksum(checksum, manifest.algorithm) !== file.checksum)
        throw new Error(`补回文件写入暂存区后校验失败：${file.relativePath}`);
      staged.push({ ...file, stagedPath });
      progress?.onFile?.(file.relativePath);
    }

    for (const file of staged)
      if (
        await fs
          .access(file.target)
          .then(() => true, () => false)
      )
        throw new Error(`提交前目标中出现同名文件：${file.relativePath}`);

    for (const file of staged) {
      await fs.mkdir(path.dirname(file.target), { recursive: true });
      try {
        await fs.link(file.stagedPath, file.target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          ![
            "EPERM",
            "EACCES",
            "EINVAL",
            "ENOTSUP",
            "EOPNOTSUPP",
            "EXDEV",
          ].includes(code || "")
        )
          throw error;
        await fs.copyFile(file.stagedPath, file.target, constants.COPYFILE_EXCL);
      }
      committed.push(file.target);
      await fs.chmod(file.target, file.mode);
      await fs.utimes(file.target, new Date(file.atimeMs), new Date(file.mtimeMs));
      const handle = await fs.open(file.target, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(path.dirname(file.target));
      copiedBytes += file.size;
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const target of committed.reverse())
      await fs.unlink(target).catch(() => {
        rollbackFailed = true;
      });
    if (rollbackFailed)
      throw new Error(
        `${String(error).replace(/^Error: /, "")}；部分新文件无法自动回滚，请先重新完整核对目标目录`,
      );
    throw error;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    files: planned.length,
    bytes: copiedBytes,
    sourceRoot: mapping.sourceRoot,
    manifestRoot: mapping.manifestRoot || ".",
  };
}

export async function importExistingBackup(
  project: ProjectConfig,
  root: string,
  mode: "manifest-import" | "external-baseline" | "unverified-import",
  metadata: {
    shootingDate?: string;
    device?: string;
    cameraPosition?: string;
    card?: string;
  } = {},
  progress?: {
    onBytes?: (bytes: number, file: string) => void;
    onFile?: (file: string) => void;
  },
): Promise<BackupTask> {
  const preview = await previewExistingBackup(
      root,
      project,
      "card",
      metadata.shootingDate,
    ),
    scanned = await scan(root, false),
    manifest = await readManifest(preview.manifest),
    mediaFiles = scanned.files.filter((file) => !isManifestName(file.name)),
    comparison = compareManifestStructure(manifest, scanned.files),
    algorithm: HashAlgorithm =
      mode === "manifest-import" && manifest.algorithm
        ? manifest.algorithm
        : "sha256",
    destinationId = randomUUID(),
    verifiedMode =
      mode === "external-baseline" ||
      (mode === "manifest-import" && Boolean(manifest.algorithm));
  const records = [];
  for (const file of mediaFiles) {
    const normalizedPath = normalizeManifestPath(file.relativePath),
      expected = manifest.entries.get(normalizedPath),
      checksum = verifiedMode
        ? await hashFile(file.absolutePath, algorithm, undefined, (count) =>
            progress?.onBytes?.(count, file.relativePath),
          )
        : "";
    const verified =
      mode === "external-baseline" ||
      (mode === "manifest-import" &&
        Boolean(expected) &&
        (expected?.size === undefined || expected.size === file.size) &&
        expected?.checksum === checksum);
    if (
      mode === "manifest-import" &&
      expected &&
      (expected.size === undefined || expected.size === file.size) &&
      expected.checksum !== checksum
    )
      comparison?.checksumMismatches.push(normalizedPath);
    records.push({
      name: file.name,
      relativePath: file.relativePath,
      size: file.size,
      srcChecksum: checksum || expected?.checksum || "",
      destinations: [
        { path: file.absolutePath, checksum: checksum || "", verified },
      ],
    });
    progress?.onFile?.(file.relativePath);
  }
  if (comparison && mode === "manifest-import") {
    comparison.matched = records.filter(
      (record) => record.destinations[0].verified,
    ).length;
    comparison.status =
      comparison.entries > 0 &&
      !comparison.missing.length &&
      !comparison.extra.length &&
      !comparison.sizeMismatches.length &&
      !comparison.checksumMismatches.length
        ? "verified"
        : comparison.entries
          ? "mismatch"
          : "unsupported";
  }
  const verified =
      records.length > 0 &&
      records.every((file) => file.destinations[0].verified) &&
      (mode !== "manifest-import" || comparison?.status === "verified"),
    now = Date.now();
  const differenceSummary = comparison
    ? [
        comparison.missing.length && `缺少 ${comparison.missing.length}`,
        comparison.extra.length && `额外 ${comparison.extra.length}`,
        comparison.sizeMismatches.length &&
          `大小不同 ${comparison.sizeMismatches.length}`,
        comparison.checksumMismatches.length &&
          `校验值不同 ${comparison.checksumMismatches.length}`,
      ]
        .filter(Boolean)
        .join("、")
    : "";
  const taskId = randomUUID();
  return {
    id: taskId,
    logicalVolumeId: taskId,
    operationAttemptId: taskId,
    operationAttempts: [
      {
        id: taskId,
        startedAt: now,
        reason: "initial",
        status: verified
          ? "completed"
          : mode === "unverified-import"
            ? "unverified"
            : "failed",
        completedAt: now,
      },
    ],
    projectRuleSnapshotId: project.activeRuleSnapshotId,
    projectId: project.id,
    projectFolderName: project.projectFolderName,
    shootingDate: metadata.shootingDate || preview.suggestedDate,
    cameraPosition:
      metadata.cameraPosition || preview.candidates[0]?.cameraPosition,
    createdAt: now,
    importedAt: now,
    provenance: mode,
    confidence:
      mode === "manifest-import" && verified
        ? "verified"
        : mode === "external-baseline"
          ? "baseline"
          : "unverified",
    externalManifest: comparison,
    name: metadata.card || preview.suggestedCard || path.basename(root),
    sourcePath: root,
    devices: [metadata.device || preview.suggestedDevice || "未分类设备"],
    destinations: [
      {
        id: destinationId,
        path: root,
        resolvedPath: root,
        label: path.basename(root),
        verified,
        bytesWritten: 0,
        copiedBytes: 0,
        verifiedBytes: verified
          ? records.reduce((sum, file) => sum + file.size, 0)
          : 0,
        copyProgress: 100,
        verifyProgress: verified ? 100 : 0,
      },
    ],
    hashAlgorithm: algorithm,
    namingTemplate: path.basename(root),
    status:
      mode === "unverified-import"
        ? "unverified"
        : verified
          ? "completed"
          : "failed",
    totalFiles: records.length,
    completedFiles: records.length,
    totalBytes: records.reduce((sum, file) => sum + file.size, 0),
    mediaBreakdown: mediaBreakdownFromFiles(records),
    transferredBytes: records.reduce((sum, file) => sum + file.size, 0),
    physicalWrittenBytes: 0,
    verifiedBytes: verified
      ? records.reduce((sum, file) => sum + file.size, 0)
      : 0,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [
      mode === "manifest-import"
        ? `根据外部清单接管：${verified ? "全部匹配" : differenceSummary || "清单格式暂不支持"}`
        : mode === "external-baseline"
          ? `已在接管时建立首次哈希基线；不代表原始现场接收校验${differenceSummary ? `；外部清单结构差异：${differenceSummary}` : ""}`
          : "目录结构已导入，尚未建立可信校验",
    ],
    errorMessage: verified
      ? undefined
      : mode === "unverified-import"
        ? "目录结构已识别，尚未建立哈希基线"
        : differenceSummary
          ? `外部清单差异：${differenceSummary}`
          : "外部清单格式暂不支持或没有可读取的校验条目",
    fileRecords: records,
  };
}

export const builtInProductionTemplates = (): ProjectTemplate[] =>
  [
    [
      "commercial",
      "广告",
      "双机位、三份独立副本，适合客户监看与规范交付。",
      ["A Cam", "B Cam"],
      3,
      ["report", "delivery"],
    ],
    [
      "documentary",
      "纪录片",
      "轻量摄影机与独立录音，两份副本并保留长期可追溯记录。",
      ["A Cam", "Audio"],
      2,
      ["report", "proxy"],
    ],
    [
      "short",
      "短片",
      "双机位与独立录音，三份副本并生成代理和交付清单。",
      ["A Cam", "B Cam", "Audio"],
      3,
      ["report", "delivery", "proxy"],
    ],
    [
      "variety",
      "综艺",
      "三机位与独立录音，两份副本并优先生成代理供快速整理。",
      ["Cam 1", "Cam 2", "Cam 3", "Audio"],
      2,
      ["report", "proxy"],
    ],
    [
      "feature",
      "电影",
      "双摄影机与现场录音，三份副本、代理和完整交付记录。",
      ["A Cam", "B Cam", "Sound"],
      3,
      ["report", "delivery", "proxy"],
    ],
  ].map(([id, name, description, devices, copies, actions]) => ({
    id: `builtin-${id}`,
    name: `${name}制作`,
    description: String(description),
    kind: "builtin" as const,
    productionType: id as ProjectTemplate["productionType"],
    devices: devices as string[],
    volumePrefix: "ROLL_",
    volumePrefixByDevice: Object.fromEntries(
      (devices as string[]).map((device) => [
        device,
        `${device.replaceAll(" ", "_").toUpperCase()}_`,
      ]),
    ),
    requiredCopies: Number(copies),
    namingRule: "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    completionActions: actions as ProjectTemplate["completionActions"],
    checklists: [
      {
        id: `builtin-${id}-source`,
        phase: "start" as const,
        label: "确认项目、拍摄日期、设备与独立目的地",
        required: true,
      },
      {
        id: `builtin-${id}-copies`,
        phase: "close" as const,
        label: `每个素材卷达到 ${copies} 份物理独立校验副本`,
        required: true,
      },
      {
        id: `builtin-${id}-handoff`,
        phase: "close" as const,
        label: "报告、异常与交接信息已经记录",
        required: true,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
    revision: 1,
  }));
