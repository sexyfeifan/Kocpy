import { createHash } from "node:crypto";
import type {
  ArchiveChangeRecord,
  ArchiveEvidenceState,
  ArchiveHealthRecord,
  ArchiveReminder,
  ArchiveVerificationRun,
} from "./types";

export const ARCHIVE_EVIDENCE_SCHEMA = 1;

export type ArchiveEvidenceInput = Omit<ArchiveEvidenceState, "digest">;

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function archiveEvidenceDigest(value: ArchiveEvidenceInput) {
  return sha256(value);
}

export function sealArchiveEvidence(
  value: ArchiveEvidenceInput,
): ArchiveEvidenceState {
  assertArchiveEvidence(value);
  return { ...value, digest: archiveEvidenceDigest(value) };
}

export function emptyArchiveEvidence(at = Date.now()) {
  return sealArchiveEvidence({
    schemaVersion: ARCHIVE_EVIDENCE_SCHEMA,
    revision: 1,
    committedAt: at,
    healthRecords: [],
    changes: [],
    reminders: [],
    runs: [],
  });
}

function assertArchiveEvidence(value: ArchiveEvidenceInput) {
  if (
    value.schemaVersion !== ARCHIVE_EVIDENCE_SCHEMA ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isFinite(value.committedAt) ||
    !Array.isArray(value.healthRecords) ||
    !Array.isArray(value.changes) ||
    !Array.isArray(value.reminders) ||
    !Array.isArray(value.runs)
  )
    throw new Error("归档证据状态结构或版本不受支持");
  const unique = (values: Array<{ id: string }>, label: string) => {
    if (
      values.some((item) => !item || typeof item.id !== "string" || !item.id) ||
      new Set(values.map((item) => item.id)).size !== values.length
    )
      throw new Error(`归档证据包含重复或无效的${label}标识`);
  };
  unique(value.healthRecords, "健康记录");
  unique(value.changes, "变化记录");
  unique(value.reminders, "提醒");
  unique(value.runs, "核验运行");
  if (value.changes.length > 100_000 || value.runs.length > 10_000)
    throw new Error("归档证据数量超过当前版本的安全上限");
  const nonnegative = (input: unknown) =>
    typeof input === "number" && Number.isFinite(input) && input >= 0;
  if (
    value.healthRecords.some(
      (record) =>
        typeof record.projectId !== "string" ||
        !nonnegative(record.checkedAt) ||
        !nonnegative(record.taskCount) ||
        !nonnegative(record.healthyTasks) ||
        !nonnegative(record.failedTasks) ||
        !nonnegative(record.missingCopies) ||
        !Array.isArray(record.notes) ||
        record.notes.some((note) => typeof note !== "string"),
    ) ||
    value.changes.some(
      (record) =>
        typeof record.projectId !== "string" ||
        typeof record.operator !== "string" ||
        !record.operator.trim() ||
        !nonnegative(record.at) ||
        ![
          "verified",
          "missing",
          "damaged",
          "modified",
          "added",
          "moved",
          "disk-replaced",
          "repaired",
        ].includes(record.kind) ||
        typeof record.note !== "string" ||
        (record.recoveryEvents !== undefined &&
          (!Array.isArray(record.recoveryEvents) ||
            record.recoveryEvents.length > 1_000 ||
            record.recoveryEvents.some(
              (event) =>
                !event ||
                !nonnegative(event.at) ||
                typeof event.action !== "string" ||
                !event.action,
            ))),
    ) ||
    value.reminders.some(
      (reminder) =>
        typeof reminder.projectId !== "string" ||
        !reminder.projectId ||
        !Number.isSafeInteger(reminder.intervalDays) ||
        reminder.intervalDays < 1 ||
        reminder.intervalDays > 3650 ||
        !nonnegative(reminder.nextAt) ||
        typeof reminder.enabled !== "boolean",
    )
  )
    throw new Error("归档证据包含无效的健康、变化或提醒记录");
  for (const run of value.runs) {
    if (
      typeof run.projectId !== "string" ||
      !run.projectId ||
      typeof run.operator !== "string" ||
      !run.operator.trim() ||
      !nonnegative(run.startedAt) ||
      !nonnegative(run.completedAt) ||
      run.completedAt < run.startedAt ||
      !["completed", "partial", "failed"].includes(run.status) ||
      !Array.isArray(run.taskResults) ||
      !Array.isArray(run.notes) ||
      run.notes.some((note) => typeof note !== "string") ||
      !/^[a-f0-9]{64}$/.test(run.baselineDigest) ||
      run.resultDigest !== archiveResultDigest(run.taskResults)
    )
      throw new Error("归档证据包含无效的复校验运行记录");
    for (const result of run.taskResults) {
      const { evidenceDigest, ...body } = result;
      if (
        typeof result.taskId !== "string" ||
        !result.taskId ||
        typeof result.taskName !== "string" ||
        !/^[a-f0-9]{64}$/.test(result.baselineDigest) ||
        ![
          "healthy",
          "attention",
          "offline",
          "identity-unknown",
          "failed",
        ].includes(result.status) ||
        !Array.isArray(result.issues) ||
        result.issues.some((issue) => typeof issue !== "string") ||
        [
          result.checkedCopies,
          result.verifiedCopies,
          result.missingFiles,
          result.damagedFiles,
          result.offlineCopies,
          result.identityUnknownCopies,
          result.bytesVerified,
        ].some((count) => !nonnegative(count)) ||
        evidenceDigest !== archiveResultDigest(body)
      )
        throw new Error("归档证据包含无效的任务核验结果");
    }
  }
}

export function validateArchiveEvidence(value: unknown): ArchiveEvidenceState {
  if (!value || typeof value !== "object")
    throw new Error("归档证据状态不是有效对象");
  const candidate = value as ArchiveEvidenceState;
  if (!/^[a-f0-9]{64}$/.test(candidate.digest || ""))
    throw new Error("归档证据状态结构或版本不受支持");
  const { digest, ...body } = candidate;
  assertArchiveEvidence(body);
  if (archiveEvidenceDigest(body) !== digest)
    throw new Error("归档证据状态摘要不匹配");
  verifyChangeChain(body.changes);
  return candidate;
}

export function sealArchiveChange(
  change: Omit<ArchiveChangeRecord, "previousDigest" | "digest">,
  previousDigest?: string,
): ArchiveChangeRecord {
  const body = { ...change, previousDigest },
    digest = sha256(body);
  return { ...body, digest };
}

export function verifyChangeChain(changes: ArchiveChangeRecord[]) {
  let previousDigest: string | undefined;
  for (const change of changes) {
    if (!change.digest) throw new Error("归档变化记录缺少摘要");
    const { digest, ...body } = change;
    if (body.previousDigest !== previousDigest || sha256(body) !== digest)
      throw new Error("归档变化记录链摘要不匹配");
    previousDigest = digest;
  }
}

function normalizeLegacyChanges(changes: ArchiveChangeRecord[]) {
  let previousDigest: string | undefined;
  return changes.map((change) => {
    const { previousDigest: _previous, digest: _digest, ...legacy } = change,
      sealed = sealArchiveChange(
        {
          ...legacy,
          operator: legacy.operator || "旧版本未记录",
          outcome:
            legacy.outcome ||
            (legacy.kind === "moved" ? "pending-verification" : "completed"),
        },
        previousDigest,
      );
    previousDigest = sealed.digest;
    return sealed;
  });
}

export function migrateLegacyArchiveEvidence(
  input: {
    healthRecords?: ArchiveHealthRecord[];
    changes?: ArchiveChangeRecord[];
    reminders?: ArchiveReminder[];
    runs?: ArchiveVerificationRun[];
  },
  at = Date.now(),
) {
  return sealArchiveEvidence({
    schemaVersion: ARCHIVE_EVIDENCE_SCHEMA,
    revision: 1,
    committedAt: at,
    healthRecords: input.healthRecords || [],
    changes: normalizeLegacyChanges(input.changes || []),
    reminders: input.reminders || [],
    runs: input.runs || [],
  });
}

export function updateArchiveEvidence(
  previous: ArchiveEvidenceState,
  update: {
    healthRecords?: ArchiveHealthRecord[];
    changes?: Array<Omit<ArchiveChangeRecord, "previousDigest" | "digest">>;
    reminders?: ArchiveReminder[];
    runs?: ArchiveVerificationRun[];
  },
  at = Date.now(),
) {
  validateArchiveEvidence(previous);
  let previousDigest = previous.changes.at(-1)?.digest;
  const additions = (update.changes || []).map((change) => {
    const sealed = sealArchiveChange(change, previousDigest);
    previousDigest = sealed.digest;
    return sealed;
  });
  return sealArchiveEvidence({
    schemaVersion: ARCHIVE_EVIDENCE_SCHEMA,
    revision: previous.revision + 1,
    committedAt: at,
    healthRecords: (update.healthRecords || previous.healthRecords).slice(-10_000),
    changes: [...previous.changes, ...additions],
    reminders: update.reminders || previous.reminders,
    runs: (update.runs || previous.runs).slice(-10_000),
  });
}

export function replaceArchiveEvidence(
  previous: ArchiveEvidenceState,
  replacement: {
    healthRecords: ArchiveHealthRecord[];
    changes: ArchiveChangeRecord[];
    reminders: ArchiveReminder[];
    runs: ArchiveVerificationRun[];
  },
  at = Date.now(),
) {
  validateArchiveEvidence(previous);
  return sealArchiveEvidence({
    schemaVersion: ARCHIVE_EVIDENCE_SCHEMA,
    revision: previous.revision + 1,
    committedAt: at,
    healthRecords: replacement.healthRecords,
    changes: normalizeLegacyChanges(replacement.changes),
    reminders: replacement.reminders,
    runs: replacement.runs,
  });
}

export function archiveTaskBaselineDigest(value: unknown) {
  return sha256(value);
}

export function archiveResultDigest(value: unknown) {
  return sha256(value);
}

export function dueArchiveReminders(
  reminders: ArchiveReminder[],
  now = Date.now(),
) {
  return reminders.filter(
    (item) =>
      item.enabled &&
      item.nextAt <= now &&
      (!item.lastNotifiedAt || now - item.lastNotifiedAt >= 86_400_000),
  );
}

export function recordArchiveNotifications(
  reminders: ArchiveReminder[],
  reminderIds: Iterable<string>,
  notifiedAt = Date.now(),
) {
  const ids = new Set(reminderIds);
  return reminders.map((item) =>
    ids.has(item.id) ? { ...item, lastNotifiedAt: notifiedAt } : item,
  );
}

export function recordProjectArchiveRun(
  reminders: ArchiveReminder[],
  run: ArchiveVerificationRun,
  risk: ArchiveHealthRecord["risk"],
) {
  const offline = run.taskResults.some((item) => item.offlineCopies > 0),
    identityUnknown = run.taskResults.some(
      (item) => item.identityUnknownCopies > 0,
    ),
    targetState: NonNullable<ArchiveReminder["lastTargetState"]> =
      identityUnknown ? "identity-unknown" : offline ? "offline" : "online";
  return reminders.map((reminder) => {
    if (reminder.projectId !== run.projectId || run.scope !== "project")
      return reminder;
    const result: ArchiveReminder = {
      ...reminder,
      lastRunId: run.id,
      lastRisk: risk,
      lastTargetState: targetState,
    };
    if (run.status === "completed") {
      result.lastSuccessfulVerificationAt = run.completedAt;
      result.nextAt = run.completedAt + reminder.intervalDays * 86_400_000;
    }
    return result;
  });
}

export function projectArchiveReport(
  project: { id: string; name: string },
  evidence: ArchiveEvidenceState,
  generatedAt = Date.now(),
) {
  validateArchiveEvidence(evidence);
  const runs = evidence.runs.filter((item) => item.projectId === project.id),
    healthRecords = evidence.healthRecords.filter(
      (item) => item.projectId === project.id,
    ),
    changes = evidence.changes.filter((item) => item.projectId === project.id),
    reminders = evidence.reminders.filter(
      (item) => item.projectId === project.id,
    );
  const unresolvedById = new Map<string, ArchiveChangeRecord>();
  for (const change of changes) {
    const unresolvedKind = [
      "missing",
      "damaged",
      "modified",
      "added",
      "moved",
      "disk-replaced",
    ].includes(change.kind);
    if (unresolvedKind && change.outcome !== "completed")
      unresolvedById.set(change.id, change);
    if (change.outcome !== "completed") continue;
    if (change.kind === "verified" && change.taskId)
      for (const [id, issue] of unresolvedById)
        if (issue.taskId === change.taskId) unresolvedById.delete(id);
    if (change.kind === "repaired")
      for (const [id, issue] of unresolvedById) {
        const sameTask = !change.taskId || issue.taskId === change.taskId,
          sameFile = change.relativePath
            ? issue.relativePath === change.relativePath
            : change.path
              ? issue.path === change.path
              : false;
        if (sameTask && sameFile) unresolvedById.delete(id);
      }
  }
  const unresolvedIssues = [...unresolvedById.values()];
  const reportBody = {
    application: "Kocpy",
    reportSchema: 1,
    generatedAt,
    project,
    evidence: {
      schemaVersion: evidence.schemaVersion,
      revision: evidence.revision,
      digest: evidence.digest,
    },
    summary: {
      runs: runs.length,
      latestRunId: runs.at(-1)?.id,
      latestRisk: healthRecords.at(-1)?.risk,
      unresolvedIssues: unresolvedIssues.length,
    },
    runs,
    healthRecords,
    changes,
    reminders,
    unresolvedIssues,
  };
  return { ...reportBody, sha256: sha256(reportBody) };
}
