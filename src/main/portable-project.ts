import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  PortableProjectFile,
  PortableProjectInspection,
} from "../common/portable-project";
import type { BackupTask, ProjectConfig } from "./types";
import { taskOutputRoots } from "./backup/task-output-root";
import { taskDateContributions } from "../common/date-allocation";
import { isManifestName, readManifest } from "./production-lifecycle";
import { XxHash32 } from "./backup/XxHash32";
import { canonicalCalendarDate } from "../common/calendar-date";
import { assertProjectTimeRules, validTimeContext } from "../common/time-context";

export const PROJECT_FILE = ".kocpyproject";
const HISTORY = ".kocpyproject-history";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 200_000;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const plain = (v: unknown): v is Record<string, any> =>
  Boolean(
    v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) === Object.prototype,
  );
const text = (v: unknown, max = 512): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
const relative = (v: unknown): v is string =>
  text(v, 4096) &&
  !path.posix.isAbsolute(v) &&
  !v.includes("\\") &&
  !v.split("/").some((p) => !p || p === "." || p === "..") &&
  !/^[A-Za-z]:/.test(v);
const metadata = (name: string) =>
  name === PROJECT_FILE ||
  name === HISTORY ||
  name.startsWith(`${HISTORY}/`) ||
  name === ".kocpyproject.lock" ||
  name.startsWith(".kocpyproject.tmp-");
const algorithmLength = { sha256: 64, sha1: 40, md5: 32, xxhash32: 8 };
function validFile(file: any): boolean {
  return (
    plain(file) &&
    relative(file.path) &&
    !metadata(file.path) &&
    (file.size === undefined ||
      (Number.isSafeInteger(file.size) && file.size >= 0)) &&
    Object.hasOwn(algorithmLength, file.algorithm) &&
    typeof file.checksum === "string" &&
    (file.algorithm === "xxhash32"
      ? /^(?:0|[1-9]\d{0,9})$/.test(file.checksum) &&
        Number(file.checksum) <= 0xffffffff
      : new RegExp(
          `^[a-f0-9]{${algorithmLength[file.algorithm as keyof typeof algorithmLength]}}$`,
        ).test(file.checksum))
  );
}
export function validatePortableProject(value: unknown): PortableProjectFile {
  const d = value as PortableProjectFile;
  if (d?.project) assertProjectTimeRules(d.project);
  if (Array.isArray(d?.rolls) && d.rolls.some(r => r.timeContext !== undefined && !validTimeContext(r.timeContext))) throw new Error("随盘素材卷时间上下文无效");
  if (
    !plain(d) ||
    d.application !== "Kocpy portable project" ||
    d.schemaVersion !== 1 ||
    !text(d.revision, 80) ||
    !Number.isFinite(d.createdAt) ||
    d.createdAt <= 0 ||
    !text(d.operator, 120) ||
    !["recorded-history", "manifest-history", "current-baseline"].includes(
      d.provenance,
    ) ||
    (d.verification !== undefined &&
      !["full-read", "recorded-hashes"].includes(d.verification)) ||
    (d.previousSha256 !== undefined &&
      !/^[a-f0-9]{64}$/.test(d.previousSha256)) ||
    !plain(d.project) ||
    !text(d.project.id, 160) ||
    !text(d.project.name) ||
    !Array.isArray(d.project.devices) ||
    d.project.devices.length > 1000 ||
    !d.project.devices.every((v) => text(v, 120)) ||
    [d.project.plannedStart, d.project.plannedEnd].some(
      (v) =>
        v !== undefined &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(v) || canonicalCalendarDate(v) !== v),
    ) ||
    (d.project.plannedStart !== undefined &&
      d.project.plannedEnd !== undefined &&
      d.project.plannedEnd < d.project.plannedStart) ||
    !Array.isArray(d.files) ||
    d.files.length > MAX_FILES ||
    !d.files.every(validFile) ||
    !Array.isArray(d.exclusions) ||
    d.exclusions.length > MAX_FILES ||
    !d.exclusions.every(
      (e) =>
        plain(e) &&
        relative(e.path) &&
        Number.isFinite(e.at) &&
        text(e.operator, 120) &&
        text(e.reason, 2000) &&
        validFile(e.expected) &&
        e.expected.path === e.path,
    ) ||
    !Array.isArray(d.rolls) ||
    d.rolls.length > 100_000 ||
    !d.rolls.every(
      (r) =>
        plain(r) &&
        text(r.id, 160) &&
        text(r.name) &&
        text(r.status, 40) &&
        text(r.scope, 160) &&
        Number.isSafeInteger(r.files) &&
        r.files >= 0 &&
        Number.isSafeInteger(r.bytes) &&
        r.bytes >= 0 &&
        Array.isArray(r.devices) &&
        r.devices.length <= 1000 &&
        r.devices.every((v) => text(v, 120)) &&
        Array.isArray(r.dates) &&
        r.dates.length <= 10000 &&
        r.dates.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)),
    ) ||
    !/^[a-f0-9]{64}$/.test(d.integrity)
  )
    throw new Error("随盘项目文件格式无效或版本不支持，请勿自动导入");
  const all = [
    ...d.files.map((f) => f.path),
    ...d.exclusions.map((e) => e.path),
  ];
  if (
    new Set(all.map((p) => p.normalize("NFC").toLowerCase())).size !==
      all.length ||
    new Set(d.rolls.map((r) => r.id)).size !== d.rolls.length
  )
    throw new Error("随盘项目文件包含重复或歧义路径/素材卷身份");
  const { integrity, ...body } = d;
  if (digest(JSON.stringify(body)) !== integrity)
    throw new Error("随盘项目文件摘要不匹配，已停止");
  return d;
}

interface BoundRoot {
  root: string;
  dev: number;
  ino: number;
}
async function bind(input: string): Promise<BoundRoot> {
  if (
    typeof input !== "string" ||
    !path.isAbsolute(input) ||
    input.includes("\0")
  )
    throw new Error("请选择项目根目录");
  const root = await fs.realpath(input),
    stat = await fs.lstat(root);
  if (
    !stat.isDirectory() ||
    root === path.parse(root).root ||
    path.dirname(root) === "/Volumes"
  )
    throw new Error("请选择项目文件夹，不是磁盘根目录");
  return { root, dev: stat.dev, ino: stat.ino };
}
async function assertBound(b: BoundRoot) {
  const s = await fs.lstat(b.root);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.dev !== b.dev ||
    s.ino !== b.ino ||
    (await fs.realpath(b.root)) !== b.root
  )
    throw new Error("项目根目录已变化，已停止");
}
async function checkedPath(b: BoundRoot, rel: string) {
  if (!relative(rel)) throw new Error("项目文件路径越界");
  await assertBound(b);
  let current = b.root;
  for (const part of rel.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error("项目子目录已变化或含符号链接");
  }
  return path.join(b.root, rel);
}
const unchanged = (a: import("node:fs").Stats, b: import("node:fs").Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
async function readBound(
  b: BoundRoot,
  rel: string,
  max: number,
): Promise<Buffer> {
  const name = await checkedPath(b, rel),
    h = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await h.stat();
    if (!before.isFile() || before.size > max)
      throw new Error("项目记录文件类型或容量不支持");
    // Do not let a concurrently growing metadata file defeat the size bound.
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await h.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (
      bytes.length !== before.size ||
      bytes.length > max ||
      !unchanged(before, await h.stat()) ||
      !unchanged(before, await fs.lstat(await checkedPath(b, rel)))
    )
      throw new Error("读取时项目记录发生变化");
    return bytes;
  } finally {
    await h.close();
  }
}
export async function readPortableProject(root: string) {
  const b = await bind(root);
  try {
    const raw = await readBound(b, PROJECT_FILE, MAX_BYTES);
    return {
      document: validatePortableProject(JSON.parse(raw.toString("utf8"))),
      sha256: digest(raw.toString("utf8")),
    };
  } catch (e) {
    if (
      (e as NodeJS.ErrnoException).code === "ENOENT" &&
      !(await fs.lstat(path.join(b.root, PROJECT_FILE)).then(
        () => true,
        (err) => {
          if (err.code === "ENOENT") return false;
          throw err;
        },
      ))
    )
      return undefined;
    throw e;
  }
}

/** Follow immutable prior revisions, never names or current folder layout. */
export async function assertPortableRevisionDescends(
  root: string,
  incoming: NonNullable<Awaited<ReturnType<typeof readPortableProject>>>,
  previousSha256: string,
) {
  if (incoming.sha256 === previousSha256) return;
  const b = await bind(root),
    seen = new Set<string>();
  let d = incoming.document;
  for (let count = 0; count < 1000; count++) {
    if (d.previousSha256 === previousSha256) return;
    if (!d.previousSha256 || seen.has(d.previousSha256)) break;
    seen.add(d.previousSha256);
    const raw = await readBound(
      b,
      `${HISTORY}/${d.previousSha256}.json`,
      MAX_BYTES,
    );
    if (digest(raw.toString("utf8")) !== d.previousSha256)
      throw new Error("随盘项目旧修订摘要不匹配");
    d = validatePortableProject(JSON.parse(raw.toString("utf8")));
    if (d.project.id !== incoming.document.project.id)
      throw new Error("随盘项目修订链混入另一项目身份");
  }
  throw new Error(
    "随盘项目修订链与本机历史不连续或为旧修订，未覆盖；请核对最新备份，或使用工作站合并处理",
  );
}

export interface PortableProgress {
  currentFile: string;
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}
export interface PortableOptions {
  signal?: AbortSignal;
  progress?: (value: PortableProgress) => void;
  recordedHashesOnly?: boolean;
  authorizeRoot?: (root: string) => Promise<void>;
}
function abort(options: PortableOptions) {
  if (options.signal?.aborted)
    throw new Error("已取消随盘项目操作，未提交新基线");
}
async function inventory(b: BoundRoot, options: PortableOptions) {
  const files: Array<{
    path: string;
    size: number;
    mtime: number;
    ctime: number;
    dev: number;
    ino: number;
  }> = [];
  async function walk(rel = "") {
    abort(options);
    const dir = rel ? await checkedPath(b, `${rel}/_`) : b.root;
    const entries = await fs.readdir(rel ? path.dirname(dir) : dir, {
      withFileTypes: true,
    });
    for (const item of entries) {
      const name = rel ? `${rel}/${item.name}` : item.name;
      if (metadata(name)) continue;
      const st = await fs.lstat(await checkedPath(b, name));
      if (st.isSymbolicLink())
        throw new Error(`项目含符号链接，不能安全建立基线：${name}`);
      if (st.isDirectory()) await walk(name);
      else if (st.isFile()) {
        files.push({
          path: name,
          size: st.size,
          mtime: st.mtimeMs,
          ctime: st.ctimeMs,
          dev: st.dev,
          ino: st.ino,
        });
        if (files.length > MAX_FILES)
          throw new Error("随盘项目超过当前 20 万文件上限，请分范围处理");
      } else throw new Error(`项目含不支持的文件类型：${name}`);
    }
    await assertBound(b);
  }
  await walk();
  return files.sort((a, c) => a.path.localeCompare(c.path, "en"));
}
async function checksum(
  b: BoundRoot,
  rel: string,
  algorithm: string,
  options: PortableOptions,
  onBytes?: (bytes: number) => void,
) {
  const filename = await checkedPath(b, rel),
    h = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await h.stat();
    if (!before.isFile()) throw new Error(`不是普通文件：${rel}`);
    const hash =
        algorithm === "xxhash32" ? new XxHash32() : createHash(algorithm),
      buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    while (true) {
      abort(options);
      const { bytesRead } = await h.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      if (offset > before.size) throw new Error(`核对期间文件增长：${rel}`);
      onBytes?.(offset);
    }
    if (
      !unchanged(before, await h.stat()) ||
      !unchanged(before, await fs.lstat(await checkedPath(b, rel)))
    )
      throw new Error(`核对期间文件发生变化：${rel}`);
    return hash instanceof XxHash32 ? hash.digestDecimal() : hash.digest("hex");
  } finally {
    await h.close();
  }
}

interface Prepared {
  bound: BoundRoot;
  current?: Awaited<ReturnType<typeof readPortableProject>>;
  document: PortableProjectFile;
  inspection: PortableProjectInspection;
  inventoryDigest: string;
  authorizeRoot?: (root: string) => Promise<void>;
}
/** Full read, not a size-only baseline. Recorded history/MHL expectations are retained. */
export async function preparePortableProject(
  root: string,
  project?: ProjectConfig,
  tasks: BackupTask[] = [],
  options: PortableOptions = {},
): Promise<Prepared> {
  const bound = await bind(root),
    current = await readPortableProject(bound.root);
  await options.authorizeRoot?.(bound.root);
  if (!project && !current)
    throw new Error("此目录没有随盘项目文件，请先选择或接管项目，再补生成");
  if (project && current && current.document.project.id !== project.id)
    throw new Error("目录属于另一项目身份，不能覆盖");
  const actual = await inventory(bound, options),
    expected = new Map<string, PortableProjectFile["files"][number]>();
  const evidencePaths = new Map<string, Promise<string>>();
  function evidencePath(p: string): Promise<string> {
    const resolved = path.resolve(p),
      cached = evidencePaths.get(resolved);
    if (cached) return cached;
    const value = fs.realpath(resolved).catch(async (e) => {
      if (e.code !== "ENOENT") throw e;
      const parent = path.dirname(resolved);
      if (parent === resolved) throw e;
      return path.join(await evidencePath(parent), path.basename(resolved));
    });
    evidencePaths.set(resolved, value);
    return value;
  }
  const relevant: BackupTask[] = [];
  for (const t of tasks.filter((t) => t.projectId === project?.id)) {
    for (const output of taskOutputRoots(t)) {
      const r = path.relative(bound.root, await evidencePath(output));
      if (
        r === "" ||
        (r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r))
      ) {
        relevant.push(t);
        break;
      }
    }
  }
  const secondary: PortableProjectFile["files"] = [];
  let hasManifest = false;
  const add = (file: PortableProjectFile["files"][number]) => {
    if (!validFile(file))
      throw new Error(`历史记录包含无效路径/校验值：${file.path}`);
    const previous = expected.get(file.path);
    if (
      previous &&
      ((previous.size !== undefined &&
        file.size !== undefined &&
        previous.size !== file.size) ||
        (previous.algorithm === file.algorithm &&
          previous.checksum !== file.checksum))
    )
      throw new Error(`历史证据冲突：${file.path}`);
    if (!previous) expected.set(file.path, { ...file });
    else if (previous.algorithm !== file.algorithm) secondary.push(file);
  };
  for (const file of current?.document.files || []) add(file);
  const excluded = new Set(
    current?.document.exclusions.map((e) => e.path) || [],
  );
  for (const t of relevant)
    for (const f of t.fileRecords) {
      const matching = f.destinations.filter(
        (d) =>
          d.verified &&
          d.checksum &&
          d.checksum === f.srcChecksum &&
          path.isAbsolute(d.path),
      );
      for (const d of matching) {
        const rel = path
          .relative(bound.root, await evidencePath(d.path))
          .split(path.sep)
          .join("/");
        if (relative(rel) && !metadata(rel) && !excluded.has(rel))
          add({
            path: rel,
            size: f.size,
            algorithm: t.hashAlgorithm
              .toLowerCase()
              .replace("-", "") as "sha256",
            checksum: d.checksum.toLowerCase(),
          });
      }
    }
  // Embedded MHL/SHA evidence belongs to its own directory, not the project root.
  for (const f of actual.filter((f) =>
    isManifestName(path.posix.basename(f.path)),
  )) {
    const parsed = await readManifest(
      await checkedPath(bound, f.path),
      (await readBound(bound, f.path, MAX_BYTES)).toString("utf8"),
    );
    hasManifest = true;
    if (!parsed.algorithm || !parsed.entries.size)
      throw new Error(`外部清单无法解释：${f.path}`);
    for (const [rel, entry] of parsed.entries) {
      const name = path.posix.join(path.posix.dirname(f.path), rel);
      if (!excluded.has(name))
        add({
          path: name,
          size: entry.size,
          algorithm: parsed.algorithm
            .toLowerCase()
            .replace("-", "") as "sha256",
          checksum: entry.checksum.toLowerCase(),
        });
    }
  }
  const actualPaths = new Set(actual.map((f) => f.path)),
    missing = [...expected.keys()].filter((p) => !actualPaths.has(p));
  const mismatches: string[] = [];
  const totalBytes = actual.reduce((n, f) => n + f.size, 0);
  let processedBytes = 0,
    processedFiles = 0;
  for (const f of actual) {
    abort(options);
    const prior = expected.get(f.path),
      algorithm = prior?.algorithm || "sha256";
    if (excluded.has(f.path))
      mismatches.push(`有意排除的路径重新出现：${f.path}`);
    const hash =
      options.recordedHashesOnly && prior
        ? prior.checksum
        : await checksum(bound, f.path, algorithm, options, (n) =>
            options.progress?.({
              currentFile: f.path,
              files: processedFiles,
              totalFiles: actual.length,
              bytes: processedBytes + n,
              totalBytes,
            }),
          );
    if (
      prior &&
      (prior.checksum !== hash ||
        (prior.size !== undefined && prior.size !== f.size))
    )
      mismatches.push(f.path);
    if (prior && prior.size === undefined)
      expected.set(f.path, { ...prior, size: f.size });
    if (!prior) add({ path: f.path, size: f.size, algorithm, checksum: hash });
    processedBytes += f.size;
    processedFiles++;
    options.progress?.({
      currentFile: f.path,
      files: processedFiles,
      totalFiles: actual.length,
      bytes: processedBytes,
      totalBytes,
    });
  }
  if (!options.recordedHashesOnly)
    for (const file of secondary)
      if (
        actualPaths.has(file.path) &&
        (await checksum(bound, file.path, file.algorithm, options)) !==
          file.checksum
      )
        mismatches.push(`外部清单校验值不符：${file.path}`);
  const after = await inventory(bound, options);
  if (JSON.stringify(actual) !== JSON.stringify(after))
    throw new Error("核对期间项目目录范围发生变化");
  const projectMeta = project
    ? {
        id: project.id,
        name: project.name,
        plannedStart: project.shootingDateStart || project.shootingDate,
        plannedEnd: project.shootingDateEnd,
        devices: [...project.devices],
        ...(project.projectTimeZone ? { projectTimeZone: project.projectTimeZone } : {}),
        ...(project.shootingDayTimeZones ? { shootingDayTimeZones: structuredClone(project.shootingDayTimeZones) } : {}),
        ...(project.shootingDayBoundaryHour !== undefined ? { shootingDayBoundaryHour: project.shootingDayBoundaryHour } : {}),
      }
    : current!.document.project;
  const rolls = new Map((current?.document.rolls || []).map((r) => [r.id, r]));
  for (const t of relevant)
    rolls.set(t.id, {
      ...(t.timeContext ? { timeContext: structuredClone(t.timeContext) } : {}),
      id: t.id,
      name: t.name,
      dates: [
        ...new Set(taskDateContributions(t).map((d) => d.shootingDate)),
      ].sort(),
      devices: [...t.devices],
      status: t.status,
      files: t.totalFiles,
      bytes: t.totalBytes,
      scope: t.selection
        ? "选定范围（不是整卡完成证明）"
        : "原任务记录（不是当前独立副本证明）",
    });
  const provenance =
    relevant.length || current?.document.provenance === "recorded-history"
      ? "recorded-history"
      : hasManifest || current?.document.provenance === "manifest-history"
        ? "manifest-history"
        : "current-baseline";
  const document: PortableProjectFile = {
    application: "Kocpy portable project",
    schemaVersion: 1,
    revision: randomUUID(),
    previousSha256: current?.sha256,
    createdAt: Date.now(),
    operator: "待确认",
    provenance,
    verification: options.recordedHashesOnly ? "recorded-hashes" : "full-read",
    project: projectMeta,
    rolls: [...rolls.values()],
    files: [...expected.values()].sort((a, b) =>
      a.path.localeCompare(b.path, "en"),
    ),
    exclusions: current?.document.exclusions || [],
    integrity: "",
  };
  await options.authorizeRoot?.(bound.root);
  return {
    bound,
    current,
    document,
    authorizeRoot: options.authorizeRoot,
    inventoryDigest: digest(JSON.stringify(actual)),
    inspection: {
      root: bound.root,
      sha256: current?.sha256,
      project: projectMeta,
      revision: current?.document.revision,
      provenance: document.provenance,
      rolls: document.rolls,
      expectedFiles: expected.size,
      currentFiles: actual.length,
      currentBytes: totalBytes,
      missing,
      mismatches,
      exclusions: document.exclusions.length,
    },
  };
}

/** No original media/manifests are changed. Only the Kocpy metadata pointer is replaced. */
export async function publishPortableProject(
  prepared: Prepared,
  operator: string,
  acceptedMissing: string[] = [],
  reason = "",
  options: PortableOptions = {},
) {
  if (!text(operator.trim(), 120))
    throw new Error("请填写实际操作人（最多120字）");
  if (prepared.inspection.mismatches.length)
    throw new Error("存在内容/大小差异，不能建立或修订基线；请先核对健康副本");
  if (
    !Array.isArray(acceptedMissing) ||
    new Set(acceptedMissing).size !== acceptedMissing.length ||
    acceptedMissing.some((p) => !prepared.inspection.missing.includes(p)) ||
    prepared.inspection.missing.some((p) => !acceptedMissing.includes(p))
  )
    throw new Error("仍有未经逐项确认的缺失文件，未发布新基线");
  if (acceptedMissing.length && !text(reason.trim(), 2000))
    throw new Error("有意移除须填写原因");
  if (
    acceptedMissing.length &&
    prepared.document.verification === "recorded-hashes"
  )
    throw new Error("有意移除修订必须先完整读取核对，不能只汇编历史校验值");
  const b = prepared.bound;
  const authorize = async () => {
    await assertBound(b);
    await prepared.authorizeRoot?.(b.root);
  };
  await authorize();
  await assertBound(b);
  abort(options);
  const lockPath = path.join(b.root, ".kocpyproject.lock"),
    lock = await fs.open(lockPath, "wx", 0o600);
  const lockIdentity = await lock.stat();
  let temp: string | undefined;
  try {
    const current = await readPortableProject(b.root);
    if (
      current?.sha256 !== prepared.current?.sha256 ||
      digest(JSON.stringify(await inventory(b, options))) !==
        prepared.inventoryDigest
    )
      throw new Error("预览后项目记录或目录范围已变化，请重新核对");
    const doc = structuredClone(prepared.document);
    doc.operator = operator.trim();
    for (const p of acceptedMissing) {
      const expected = doc.files.find((f) => f.path === p)!;
      doc.exclusions.push({
        path: p,
        at: Date.now(),
        operator: doc.operator,
        reason: reason.trim(),
        expected,
      });
    }
    doc.files = doc.files.filter((f) => !acceptedMissing.includes(f.path));
    const { integrity: _unused, ...body } = doc;
    doc.integrity = digest(JSON.stringify(body));
    validatePortableProject(doc);
    const raw = JSON.stringify(doc, null, 2) + "\n";
    if (Buffer.byteLength(raw) > MAX_BYTES)
      throw new Error("随盘项目文件超过64MiB上限");
    const history = path.join(b.root, HISTORY);
    await fs.mkdir(history, { recursive: false }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const hs = await fs.lstat(history);
    if (!hs.isDirectory() || hs.isSymbolicLink())
      throw new Error("项目修订记录目录不安全");
    async function writeNew(rel: string, bytes: Buffer | string) {
      await authorize();
      const name = await checkedPath(b, rel),
        h = await fs.open(
          name,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      try {
        await h.writeFile(bytes);
        await h.sync();
      } finally {
        await h.close();
      }
      const actual = await readBound(b, rel, MAX_BYTES);
      if (digest(actual.toString("utf8")) !== digest(bytes.toString()))
        throw new Error("项目记录写后回读失败");
      await authorize();
    }
    if (current) {
      const previousRel = `${HISTORY}/${current.sha256}.json`;
      const previous = await readBound(b, PROJECT_FILE, MAX_BYTES);
      try {
        await writeNew(previousRel, previous);
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== "EEXIST" ||
          digest(
            (await readBound(b, previousRel, MAX_BYTES)).toString("utf8"),
          ) !== current.sha256
        )
          throw e;
      }
    }
    await writeNew(`${HISTORY}/${doc.revision}.json`, raw);
    temp = `.kocpyproject.tmp-${randomUUID()}`;
    await writeNew(temp, raw);
    await authorize();
    abort(options);
    if ((await readPortableProject(b.root))?.sha256 !== current?.sha256)
      throw new Error("项目记录被并发修改，未替换");
    await fs.rename(
      await checkedPath(b, temp),
      path.join(b.root, PROJECT_FILE),
    );
    temp = undefined;
    const dir = await fs.open(b.root, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    await authorize();
    const result = await readPortableProject(b.root);
    if (result?.sha256 !== digest(raw))
      throw new Error("项目记录最终回读失败，请保留修订记录检查");
    return result;
  } finally {
    await lock.close();
    // Only our own temporary metadata and lock may be removed, never payload.
    await authorize();
    if (temp)
      await fs.unlink(await checkedPath(b, temp)).catch(() => undefined);
    const st = await fs.lstat(lockPath);
    if (st.ino === lockIdentity.ino && st.dev === lockIdentity.dev)
      await fs.unlink(lockPath);
  }
}

export async function verifyPortablePayload(
  root: string,
  expectedSha256: string,
  options: PortableOptions = {},
) {
  const current = await readPortableProject(root);
  if (!current || current.sha256 !== expectedSha256)
    throw new Error("随盘项目文件已变化或丢失，请重新预检");
  const prepared = await preparePortableProject(root, undefined, [], {
    ...options,
    recordedHashesOnly: false,
  });
  if (
    prepared.inspection.missing.length ||
    prepared.inspection.mismatches.length ||
    prepared.inspection.currentFiles !== current.document.files.length
  )
    throw new Error(
      `随盘项目基线不匹配：缺少 ${prepared.inspection.missing.length}、内容/排除差异 ${prepared.inspection.mismatches.length}；新增文件也需重新核对后更新项目文件`,
    );
  return current;
}
