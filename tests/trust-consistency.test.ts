import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { projectCoverage } from "../src/main/production-lifecycle";
import {
  manifestRequirementMet,
  taskMeetsCopyRequirement,
} from "../src/main/project-closeout";
import type {
  BackupTask,
  InventoryExcludedEntry,
  ProjectConfig,
} from "../src/main/types";
import {
  taskTrustState,
  taskCompletionNotice,
  savedDestinationBytes,
} from "../src/common/task-trust";
import {
  generateReport,
  generateDailyReport,
  generateProjectReport,
} from "../src/main/backup/ReportGenerator";

const project: ProjectConfig = {
  id: "synthetic",
  name: "Synthetic",
  devices: ["A"],
  volumePrefix: "A",
  requiredCopies: 2,
  shootingDateStart: "2026-09-01",
  shootingDateEnd: "2026-09-01",
};
export function trustedFixture(): BackupTask {
  const task = new BackupEngine().createTask({
    name: "A001",
    sourcePath: "/synthetic/source",
    destinationPaths: ["/synthetic/one", "/synthetic/two"],
    devices: ["A"],
    hashAlgorithm: "sha256",
    namingTemplate: "A001",
    shootingDate: "2026-09-01",
  });
  task.projectId = project.id;
  task.status = "completed";
  task.destinations.forEach((d, i) => {
    d.verified = true;
    d.volumeUuid = `UUID-${i}`;
  });
  return task;
}
function recordExclusion(task: BackupTask, exclusion: InventoryExcludedEntry) {
  task.inventoryScope = {
    policy: structuredClone(task.inventoryPolicy!),
    capturedAt: 1,
    sourcePath: task.sourcePath,
    fingerprint: "a".repeat(64),
    includedFiles: task.totalFiles,
    includedBytes: task.totalBytes,
    includedDirectories: 0,
    includedDirectoryPaths: [],
    excludedFiles: exclusion.kind === "file" ? 1 : 0,
    excludedDirectories: exclusion.kind === "directory" ? 1 : 0,
    excludedBytes: exclusion.bytes,
    exclusions: [exclusion],
  };
}
function independentCopies(task: BackupTask) {
  task.destinations.forEach((destination, index) => {
    destination.storageEvidence = {
      assessmentId: "synthetic-assessment",
      checkedAt: 1,
      volumeUuid: destination.volumeUuid,
      kind: "local-physical",
      domains: [`disk${index + 1}`],
      reason: "generated fixture",
    };
  });
}
describe("one safety conclusion across consumers", () => {
  it("retains permission scope risk in both native and in-app completion notices", () => {
    const task = trustedFixture();
    independentCopies(task);
    recordExclusion(task, { relativePath: "restricted", kind: "directory", bytes: 0, modifiedAt: 0, reason: "permission-denied", permissionCode: "EACCES", bytesUnknown: true });
    expect(taskCompletionNotice(task)).toMatchObject({ attention: true });
    expect(taskCompletionNotice(task).title).toContain("权限排除 1 项");
    expect(taskCompletionNotice(task).body).toContain("源范围未完整，整卡达标副本 0 份");
    const complete = trustedFixture();
    expect(taskCompletionNotice(complete)).toMatchObject({ title: "内容校验通过", attention: false });
    complete.status = "failed";
    expect(taskCompletionNotice(complete)).toMatchObject({ title: "备份失败", attention: true });
  });
  it("does not turn two legacy volume identities into two independent copies", () => {
    const task = trustedFixture();
    expect(taskMeetsCopyRequirement(task, 2)).toBe(false);
    expect(projectCoverage(project, [task])).toMatchObject({
      verified: 1,
      compliant: 0,
      attention: 1,
    });
  });
  it("a failed task with old verified flags cannot satisfy closeout through coverage", () => {
    const task = trustedFixture();
    task.status = "failed";
    expect(
      projectCoverage({ ...project, requiredCopies: 1 }, [task]),
    ).toMatchObject({ compliant: 0, attention: 1 });
  });
  it("keeps included hashes valid but denies copy compliance when source permissions omit material", () => {
    const task = trustedFixture();
    task.totalFiles = 1;
    task.totalBytes = 4;
    task.fileRecords = [{
      name: "clip.mov",
      relativePath: "clip.mov",
      size: 4,
      srcChecksum: "a".repeat(64),
      destinations: task.destinations.map((destination) => ({
        path: `${destination.path}/clip.mov`,
        checksum: "a".repeat(64),
        verified: true,
      })),
    }];
    independentCopies(task);
    expect(taskMeetsCopyRequirement(task, 2)).toBe(true);
    recordExclusion(task, {
      relativePath: "DCIM/Unreadable",
      kind: "directory",
      bytes: 0,
      modifiedAt: 0,
      reason: "permission-denied",
      permissionCode: "EACCES",
      bytesUnknown: true,
    });
    const before = structuredClone(task),
      trust = taskTrustState(task);
    expect(trust).toMatchObject({
      status: "unverified",
      contentVerified: true,
      countableCopies: 0,
      copies: { verifiedTargets: 2, independentCopies: 2 },
    });
    expect(trust.label).toContain("范围内内容校验通过");
    expect(trust.label).toContain("权限排除 1 项");
    expect(trust.explanation).toContain("不能证明源范围完整");
    expect(taskMeetsCopyRequirement(task, 1)).toBe(false);
    expect(taskMeetsCopyRequirement(task, 2)).toBe(false);
    expect(projectCoverage(project, [task])).toMatchObject({
      verified: 1,
      compliant: 0,
      attention: 1,
    });
    expect(taskTrustState({ ...task, fileRecords: [] })).toEqual(trust);
    expect(task).toEqual(before);
  });
  it("keeps known system-directory omissions compatible with ordinary completed trust", () => {
    const task = trustedFixture();
    independentCopies(task);
    recordExclusion(task, {
      relativePath: ".Spotlight-V100",
      kind: "directory",
      bytes: 0,
      modifiedAt: 0,
      reason: "system-directory",
      bytesUnknown: true,
    });
    expect(taskTrustState(task)).toMatchObject({
      status: "completed",
      label: "内容校验通过",
      contentVerified: true,
      countableCopies: 2,
    });
    expect(taskMeetsCopyRequirement(task, 2)).toBe(true);
    expect(projectCoverage(project, [task])).toMatchObject({
      verified: 1,
      compliant: 1,
      attention: 0,
    });
  });
  it.each(["running", "failed", "cancelled"] as const)(
    "permission exclusions do not promote %s tasks into verified included content",
    (status) => {
      const task = trustedFixture();
      recordExclusion(task, {
        relativePath: "clip.mov",
        kind: "file",
        bytes: 0,
        modifiedAt: 0,
        reason: "permission-denied",
        permissionCode: "EPERM",
        bytesUnknown: true,
      });
      task.status = status;
      expect(taskTrustState(task)).toMatchObject({
        status,
        contentVerified: false,
        countableCopies: 0,
      });
    },
  );
  it.each(["missing", "checksumMismatches", "sizeMismatches"] as const)(
    "a stale extra-file waiver cannot waive %s",
    (key) => {
      const task = trustedFixture();
      task.confidence = "baseline";
      task.externalManifest = {
        path: "/synthetic/list.mhl",
        entries: 2,
        matched: 1,
        checkedAt: 1,
        status: "mismatch",
        missing: [],
        extra: ["new.mov"],
        sizeMismatches: [],
        checksumMismatches: [],
        resolution: {
          type: "accepted-extra",
          resolvedAt: 1,
          note: "synthetic confirmation",
        },
      };
      (task.externalManifest[key] as unknown[]) =
        key === "sizeMismatches"
          ? [{ relativePath: "clip.mov", expected: 10, actual: 0 }]
          : ["clip.mov"];
      expect(manifestRequirementMet(task)).toBe(false);
      expect(taskMeetsCopyRequirement(task, 1)).toBe(false);
    },
  );
});

describe("trust truth table and historical compatibility", () => {
  it("distinguishes adopted existing bytes from zero new writes", () => {
    const task = trustedFixture();
    task.provenance = "external-baseline";
    task.totalBytes = 58;
    task.destinations[0].copiedBytes = 0;
    task.destinations[0].bytesWritten = 0;
    expect(savedDestinationBytes(task, task.destinations[0])).toBe(58);
    expect(task.destinations[0].bytesWritten).toBe(0);
  });
  it.each([
    "pending",
    "running",
    "paused",
    "verifying",
    "failed",
    "cancelled",
    "unverified",
  ] as const)(
    "%s never uses stale green destination flags as current success",
    (status) => {
      const task = trustedFixture();
      task.status = status;
      expect(taskTrustState(task).contentVerified).toBe(false);
      expect(taskTrustState(task).countableCopies).toBe(0);
    },
  );
  it("preserves old hash facts without inventing another disk and ignores omitted paged files", () => {
    const task = trustedFixture(),
      before = structuredClone(task);
    const full = taskTrustState(task),
      paged = taskTrustState({ ...task, fileRecords: [] });
    expect(full).toEqual(paged);
    expect(full).toMatchObject({
      contentVerified: true,
      countableCopies: 1,
      copies: { verifiedTargets: 2, independencePending: true },
    });
    expect(task).toEqual(before);
  });
  it("distinguishes first baseline, external proof and unidentified imports", () => {
    const task = trustedFixture();
    task.provenance = "external-baseline";
    task.confidence = "baseline";
    expect(taskTrustState(task).label).toBe("首次基线已建立");
    expect(taskTrustState(task).explanation).toContain("不证明接管前没有丢失");
    task.provenance = "manifest-import";
    task.confidence = "verified";
    expect(taskTrustState(task).contentVerified).toBe(false);
    task.externalManifest = {
      path: "/synthetic/list.mhl",
      status: "verified",
      entries: 1,
      matched: 1,
      missing: [],
      extra: [],
      sizeMismatches: [],
      checksumMismatches: [],
      checkedAt: 1,
    };
    expect(taskTrustState(task).label).toBe("外部清单校验通过");
    task.externalManifest.status = "structure-match";
    expect(taskTrustState(task).contentVerified).toBe(false);
    task.provenance = "unverified-import";
    task.confidence = "unverified";
    expect(taskTrustState(task).contentVerified).toBe(false);
  });
  it("requires actual verified destinations, never completed alone", () => {
    const task = trustedFixture();
    task.destinations.forEach((d) => (d.verified = false));
    expect(taskTrustState(task).contentVerified).toBe(false);
    expect(taskMeetsCopyRequirement(task, 1)).toBe(false);
  });
  it("report, daily and project use the identical baseline label and conservative count", async () => {
    const task = trustedFixture();
    task.provenance = "external-baseline";
    task.confidence = "baseline";
    task.fileRecords = [
      {
        name: "clip.mov",
        relativePath: "clip.mov",
        size: 1,
        srcChecksum: "abc",
        destinations: [
          { path: "/synthetic/one/clip.mov", checksum: "abc", verified: true },
        ],
      },
    ];
    const single = (await generateReport(task)).toString();
    expect(single).toContain('class="section destination-section"');
    expect(single).toContain('.destination-section { break-inside: avoid; }');
    expect(single).toContain('.section { box-shadow: none; border: 0; border-radius: 0; padding: 0; margin-bottom: 20px; }');
    expect(single).toContain('@page { size: A4; margin: 10mm 8mm; }');
    expect(single).toContain('class="section task-info-section"');
    expect(single).toContain('.file-section > p { break-after: avoid; }');
    for (const html of await Promise.all([
      generateReport(task),
      generateDailyReport([task], "2026-09-01"),
      generateProjectReport(project, [task]),
    ])) {
      expect(html.toString()).toContain(taskTrustState(task).label);
      expect(html.toString()).not.toContain("✓ 2 份");
      expect(html.toString()).toContain("可计数副本");
    }
  });
});
