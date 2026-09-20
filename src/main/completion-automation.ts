import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import type {
  BackupTask,
  CompletionActionKind,
  CompletionActionRecord,
  ProjectConfig,
} from "./types";

const ACTIONS: CompletionActionKind[] = ["report", "delivery", "proxy", "eject"];
const RECORD_STATUSES = ["suggested", "running", "completed", "failed", "skipped"];
const ATTEMPT_STATUSES = ["authorized", "running", "completed", "failed", "skipped"];

export function completionActionKey(
  task: Pick<BackupTask, "id" | "projectRuleSnapshotId">,
  action: CompletionActionKind,
) {
  return createHash("sha256")
    .update(`${task.id}\0${task.projectRuleSnapshotId || "legacy"}\0${action}\0v1`)
    .digest("hex");
}

export function validateCompletionActionRecords(task: BackupTask) {
  const records = task.completionActionRecords;
  if (records === undefined) return;
  if (!Array.isArray(records) || records.length > ACTIONS.length)
    throw new Error("任务完成动作记录无效");
  const keys = new Set<string>();
  for (const record of records) {
    if (
      !record ||
      !ACTIONS.includes(record.action) ||
      record.key !== completionActionKey(task, record.action) ||
      keys.has(record.key) ||
      !RECORD_STATUSES.includes(record.status) ||
      !Number.isFinite(record.suggestedAt) ||
      !Array.isArray(record.attempts) ||
      record.attempts.length > 100
    )
      throw new Error("任务完成动作记录无效");
    keys.add(record.key);
    const attemptIds = new Set<string>();
    for (const attempt of record.attempts) {
      if (
        !attempt ||
        typeof attempt.id !== "string" ||
        !attempt.id ||
        attemptIds.has(attempt.id) ||
        typeof attempt.operator !== "string" ||
        !attempt.operator.trim() ||
        attempt.operator.length > 120 ||
        !ATTEMPT_STATUSES.includes(attempt.status) ||
        !Number.isFinite(attempt.authorizedAt) ||
        (attempt.startedAt !== undefined && !Number.isFinite(attempt.startedAt)) ||
        (attempt.completedAt !== undefined && !Number.isFinite(attempt.completedAt))
      ) {
        throw new Error("任务完成动作授权记录无效");
      }
      attemptIds.add(attempt.id);
    }
    const expectedAttemptStatus =
      record.status === "running"
        ? "running"
        : record.status === "completed"
          ? "completed"
          : record.status === "failed"
            ? "failed"
            : record.status === "skipped"
              ? "skipped"
              : undefined;
    if (
      (record.status === "suggested" && record.attempts.length) ||
      (expectedAttemptStatus &&
        record.attempts.at(-1)?.status !== expectedAttemptStatus) ||
      (record.result !== undefined &&
        (typeof record.result !== "string" || record.result.length > 8192)) ||
      (record.error !== undefined &&
        (typeof record.error !== "string" || record.error.length > 8192))
    )
      throw new Error("任务完成动作状态与授权记录不一致");
    if (
      record.outputPaths &&
      (!Array.isArray(record.outputPaths) ||
        record.outputPaths.length > 16 ||
        record.outputPaths.some(
          (output) => typeof output !== "string" || !path.isAbsolute(output),
        ))
    )
      throw new Error("任务完成动作产物路径无效");
    if (
      record.outputSha256 &&
      Object.entries(record.outputSha256).some(
        ([output, digest]) =>
          !path.isAbsolute(output) ||
          !record.outputPaths?.includes(output) ||
          typeof digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(digest),
      )
    )
      throw new Error("任务完成动作产物摘要无效");
  }
}

export function configuredCompletionActions(
  task: BackupTask,
  project?: ProjectConfig,
): CompletionActionKind[] {
  if (
    !project ||
    (task.provenance && task.provenance !== "kocpy-transfer")
  )
    return [];
  const frozen = project.ruleSnapshots?.find(
    (snapshot) => snapshot.id === task.projectRuleSnapshotId,
  );
  const configured = frozen?.rules.completionActions || project.completionActions || [];
  return ACTIONS.filter((action) => configured.includes(action));
}

/** Adds suggestions only. This function never performs an external side effect. */
export function ensureCompletionActionPlan(
  task: BackupTask,
  project?: ProjectConfig,
  at = Date.now(),
) {
  if (task.status !== "completed" || !project) return false;
  const records = task.completionActionRecords || [];
  let changed = false;
  for (const action of configuredCompletionActions(task, project)) {
    const key = completionActionKey(task, action);
    if (records.some((record) => record.key === key)) continue;
    records.push({
      key,
      action,
      ruleSnapshotId: task.projectRuleSnapshotId,
      suggestedAt: at,
      status: "suggested",
      attempts: [],
    });
    changed = true;
  }
  if (changed) task.completionActionRecords = records;
  return changed;
}

export function beginCompletionAction(
  task: BackupTask,
  action: CompletionActionKind,
  operator: string,
  at = Date.now(),
) {
  if (task.status !== "completed") throw new Error("只有完成并校验的任务才能执行完成动作");
  const name = typeof operator === "string" ? operator.trim() : "";
  if (!name) throw new Error("请填写本次完成动作的操作人");
  if (name.length > 120) throw new Error("操作人最多 120 个字符");
  const key = completionActionKey(task, action);
  const record = task.completionActionRecords?.find((item) => item.key === key);
  if (!record) throw new Error("该动作不在任务完成时冻结的建议计划中");
  if (record.status === "completed" || record.status === "skipped")
    return { record, shouldRun: false };
  if (record.status === "running") throw new Error("该完成动作正在执行，请勿重复触发");
  const attempt = {
    id: randomUUID(),
    authorizedAt: at,
    operator: name,
    startedAt: at,
    status: "running" as const,
  };
  record.status = "running";
  record.error = undefined;
  record.result = undefined;
  record.attempts = [...record.attempts, attempt];
  return { record, shouldRun: true };
}

export function finishCompletionAction(
  record: CompletionActionRecord,
  input: {
    result: string;
    outputPaths?: string[];
    outputSha256?: Record<string, string>;
    at?: number;
  },
) {
  const attempt = record.attempts.at(-1);
  if (!attempt || attempt.status !== "running") throw new Error("完成动作缺少运行中的授权尝试");
  const at = input.at || Date.now();
  attempt.status = "completed";
  attempt.completedAt = at;
  attempt.result = input.result;
  record.status = "completed";
  record.result = input.result;
  record.error = undefined;
  record.outputPaths = input.outputPaths;
  record.outputSha256 = input.outputSha256;
}

export function failCompletionAction(
  record: CompletionActionRecord,
  error: unknown,
  at = Date.now(),
) {
  const message = error instanceof Error ? error.message : String(error);
  const attempt = record.attempts.at(-1);
  if (attempt?.status === "running") {
    attempt.status = "failed";
    attempt.completedAt = at;
    attempt.error = message;
  }
  record.status = "failed";
  record.error = message;
  record.result = undefined;
}

export function skipCompletionAction(
  task: BackupTask,
  action: CompletionActionKind,
  operator: string,
  at = Date.now(),
) {
  const name = typeof operator === "string" ? operator.trim() : "";
  if (!name) throw new Error("请填写跳过动作的操作人");
  if (name.length > 120) throw new Error("操作人最多 120 个字符");
  const record = task.completionActionRecords?.find(
    (item) => item.key === completionActionKey(task, action),
  );
  if (!record) throw new Error("该动作不在任务完成时冻结的建议计划中");
  if (record.status === "running") throw new Error("动作执行中，不能标记跳过");
  if (record.status === "completed") throw new Error("已完成的动作不能改为跳过");
  record.status = "skipped";
  record.error = undefined;
  record.result = `${name} 已确认本任务不执行此建议`;
  record.attempts = [
    ...record.attempts,
    {
      id: randomUUID(),
      authorizedAt: at,
      operator: name,
      startedAt: at,
      completedAt: at,
      status: "skipped",
      result: record.result,
    },
  ];
  return record;
}

export function recoverInterruptedCompletionActions(task: BackupTask, at = Date.now()) {
  let changed = false;
  for (const record of task.completionActionRecords || []) {
    if (record.status !== "running") continue;
    failCompletionAction(
      record,
      "上次完成动作在结果提交前中断。没有按成功处理；请核对已生成产物或设备状态后显式重试。",
      at,
    );
    changed = true;
  }
  return changed;
}

export function sha256Bytes(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Reread one newly published completion artifact from its opened file handle.
 * A matching in-memory digest is not proof that the durable target contains the
 * same bytes, especially on removable and network filesystems.
 */
export async function verifyPublishedArtifact(
  target: string,
  expectedSha256: string,
) {
  if (!path.isAbsolute(target) || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error("完成动作产物校验参数无效");
  const handle = await fs.open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("完成动作产物不是安全的普通文件");
    const digest = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const actual = digest.digest("hex");
    if (actual !== expectedSha256)
      throw new Error("完成动作产物落盘后回读摘要不一致，未记录为完成");
    return actual;
  } finally {
    await handle.close();
  }
}

/** Publishes one new artifact without replacing an existing path. */
export async function publishNewArtifact(target: string, value: Uint8Array | string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.partial`,
  );
  const handle = await fs.open(temporary, "wx", 0o644);
  try {
    await handle.writeFile(value);
    await handle.chmod(0o644);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await fs.link(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        ![
          "EACCES",
          "EINVAL",
          "ENOTSUP",
          "EOPNOTSUPP",
          "EPERM",
          "EXDEV",
        ].includes(code || "")
      )
        throw error;
      // exFAT and a number of SMB/NAS implementations do not support hard
      // links. COPYFILE_EXCL preserves the same no-overwrite guarantee.
      await fs.copyFile(temporary, target, constants.COPYFILE_EXCL);
      const published = await fs.open(target, "r+");
      try {
        await published.sync();
      } finally {
        await published.close();
      }
    }
    const directory = await fs.open(path.dirname(target), "r");
    try {
      await directory.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code || "")) throw error;
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`目标产物已存在，Kocpy 未覆盖：${target}`);
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
  return { path: target, sha256: sha256Bytes(value) };
}

export async function syncArtifactExclusive(source: string, directory: string) {
  const target = path.join(directory, path.basename(source));
  if (path.resolve(target) === path.resolve(source))
    return { path: target, reused: true };
  const value = await fs.readFile(source),
    expected = sha256Bytes(value),
    existing = await fs.lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(`同步目标不是安全的普通文件：${target}`);
    const actual = sha256Bytes(await fs.readFile(target));
    if (actual !== expected)
      throw new Error(`同步目标已有不同内容，Kocpy 未覆盖：${target}`);
    return { path: target, reused: true };
  }
  const published = await publishNewArtifact(target, value);
  if (sha256Bytes(await fs.readFile(target)) !== published.sha256)
    throw new Error("同步报告落盘后回读摘要不一致");
  return { path: target, reused: false };
}

export async function createExclusiveArtifactDirectory(
  parent: string,
  name: string,
) {
  if (
    !path.isAbsolute(parent) ||
    !name ||
    name !== path.basename(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error("产物目录路径无效");
  const target = path.join(parent, name);
  try {
    await fs.mkdir(target, { recursive: false, mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`目标归档包已存在，Kocpy 未覆盖：${target}`);
    throw error;
  }
  const directory = await fs.open(parent, "r");
  try {
    await directory.sync().catch((error) => {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error.code || "")) throw error;
    });
  } finally {
    await directory.close();
  }
  return target;
}
