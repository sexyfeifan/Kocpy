import { describe, expect, it } from "vitest";
import {
  archiveResultDigest,
  archiveTaskBaselineDigest,
  dueArchiveReminders,
  emptyArchiveEvidence,
  projectArchiveReport,
  recordArchiveNotifications,
  recordProjectArchiveRun,
  updateArchiveEvidence,
  validateArchiveEvidence,
} from "../src/main/archive-evidence";
import type {
  ArchiveReminder,
  ArchiveVerificationRun,
} from "../src/main/types";

function run(status: ArchiveVerificationRun["status"] = "completed") {
  const resultBody = {
      taskId: "task-1",
      taskName: "A001",
      baselineDigest: archiveTaskBaselineDigest("baseline"),
      status: status === "completed" ? ("healthy" as const) : ("offline" as const),
      checkedCopies: status === "completed" ? 1 : 0,
      verifiedCopies: status === "completed" ? 1 : 0,
      missingFiles: 0,
      damagedFiles: 0,
      offlineCopies: status === "completed" ? 0 : 1,
      identityUnknownCopies: 0,
      bytesVerified: status === "completed" ? 1024 : 0,
      issues: status === "completed" ? [] : ["目标离线"],
    },
    taskResult = {
      ...resultBody,
      evidenceDigest: archiveResultDigest(resultBody),
    },
    taskResults = [taskResult];
  return {
    id: `run-${status}`,
    projectId: "project-1",
    scope: "project" as const,
    scopeLabel: "测试项目",
    operator: "DIT 测试员",
    startedAt: 100,
    completedAt: 200,
    status,
    taskResults,
    baselineDigest: archiveTaskBaselineDigest("project-baseline"),
    resultDigest: archiveResultDigest(taskResults),
    notes: taskResult.issues,
  } satisfies ArchiveVerificationRun;
}

const reminder: ArchiveReminder = {
  id: "reminder-1",
  projectId: "project-1",
  intervalDays: 180,
  nextAt: 100,
  enabled: true,
};

describe("archive evidence authority", () => {
  it("seals a hash-chained change log and rejects tampering", () => {
    const first = updateArchiveEvidence(emptyArchiveEvidence(1), {
      changes: [
        {
          id: "change-1",
          projectId: "project-1",
          operator: "DIT 测试员",
          at: 2,
          kind: "verified",
          outcome: "completed",
          note: "通过",
        },
      ],
    }, 2);
    const second = updateArchiveEvidence(first, {
      changes: [
        {
          id: "change-2",
          projectId: "project-1",
          operator: "DIT 测试员",
          at: 3,
          kind: "moved",
          outcome: "pending-verification",
          note: "位置变化待复校验",
        },
      ],
    }, 3);
    expect(second.changes[1].previousDigest).toBe(second.changes[0].digest);
    expect(validateArchiveEvidence(second).digest).toBe(second.digest);
    const tampered = structuredClone(second);
    tampered.changes[0].note = "被篡改";
    expect(() => validateArchiveEvidence(tampered)).toThrow("摘要不匹配");
  });

  it("does not advance verification dates when only notifying or when a run fails", () => {
    expect(dueArchiveReminders([reminder], 101)).toHaveLength(1);
    const notified = recordArchiveNotifications([reminder], [reminder.id], 101);
    expect(notified[0].nextAt).toBe(100);
    expect(notified[0].lastSuccessfulVerificationAt).toBeUndefined();
    expect(dueArchiveReminders(notified, 102)).toHaveLength(0);

    const failed = recordProjectArchiveRun(notified, run("failed"), "critical");
    expect(failed[0].lastRunId).toBe("run-failed");
    expect(failed[0].lastTargetState).toBe("offline");
    expect(failed[0].nextAt).toBe(100);
    expect(failed[0].lastSuccessfulVerificationAt).toBeUndefined();

    const completed = recordProjectArchiveRun(failed, run(), "healthy");
    expect(completed[0].lastSuccessfulVerificationAt).toBe(200);
    expect(completed[0].nextAt).toBe(200 + 180 * 86_400_000);
    expect(completed[0].lastTargetState).toBe("online");
  });

  it("exports contextual evidence with a reproducible report checksum", () => {
    const verification = run(),
      evidence = updateArchiveEvidence(emptyArchiveEvidence(1), {
        reminders: [reminder],
        runs: [verification],
      }, 200),
      report = projectArchiveReport(
        { id: "project-1", name: "测试项目" },
        evidence,
        300,
      );
    expect(report.summary.latestRunId).toBe(verification.id);
    expect(report.evidence.digest).toBe(evidence.digest);
    expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projectArchiveReport(
      { id: "project-1", name: "测试项目" },
      evidence,
      300,
    ).sha256).toBe(report.sha256);
  });

  it("keeps historical issues but closes current risk after repair or full verification", () => {
    const base = emptyArchiveEvidence(1),
      first = updateArchiveEvidence(base, {
        changes: [
          {
            id: "missing-1",
            projectId: "project-1",
            taskId: "task-1",
            operator: "DIT 测试员",
            at: 2,
            kind: "missing",
            relativePath: "DCIM/A001.mov",
            path: "/archive/DCIM/A001.mov",
            outcome: "failed",
            note: "缺失",
          },
          {
            id: "added-1",
            projectId: "project-1",
            taskId: "task-2",
            operator: "DIT 测试员",
            at: 3,
            kind: "added",
            path: "/archive/untracked.txt",
            outcome: "pending-verification",
            note: "未登记",
          },
        ],
      }, 3),
      repaired = updateArchiveEvidence(first, {
        changes: [
          {
            id: "repair-1",
            projectId: "project-1",
            taskId: "task-1",
            operator: "DIT 测试员",
            at: 4,
            kind: "repaired",
            relativePath: "DCIM/A001.mov",
            path: "/archive/DCIM/A001.mov",
            outcome: "completed",
            note: "已修复并回读",
          },
        ],
      }, 4),
      afterRepair = projectArchiveReport(
        { id: "project-1", name: "测试项目" },
        repaired,
        5,
      );
    expect(afterRepair.changes).toHaveLength(3);
    expect(afterRepair.unresolvedIssues.map((item) => item.id)).toEqual([
      "added-1",
    ]);

    const verified = updateArchiveEvidence(repaired, {
        changes: [
          {
            id: "verify-2",
            projectId: "project-1",
            taskId: "task-2",
            operator: "DIT 测试员",
            at: 6,
            kind: "verified",
            outcome: "completed",
            note: "完整复校验通过",
          },
        ],
      }, 6),
      afterVerification = projectArchiveReport(
        { id: "project-1", name: "测试项目" },
        verified,
        7,
      );
    expect(afterVerification.unresolvedIssues).toHaveLength(0);
  });
});
