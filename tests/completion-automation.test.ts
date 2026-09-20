import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginCompletionAction,
  completionActionKey,
  createExclusiveArtifactDirectory,
  ensureCompletionActionPlan,
  failCompletionAction,
  finishCompletionAction,
  publishNewArtifact,
  recoverInterruptedCompletionActions,
  skipCompletionAction,
  syncArtifactExclusive,
  verifyPublishedArtifact,
  validateCompletionActionRecords,
} from "../src/main/completion-automation";
import type { BackupTask, ProjectConfig } from "../src/main/types";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const task = (): BackupTask => ({
  id: "task-a",
  name: "A001",
  projectId: "project-a",
  projectRuleSnapshotId: "rules-1",
  sourcePath: "/Volumes/CARD",
  devices: ["A"],
  destinations: [],
  hashAlgorithm: "sha256",
  namingTemplate: "A001",
  status: "completed",
  totalFiles: 0,
  completedFiles: 0,
  totalBytes: 0,
  transferredBytes: 0,
  speedBps: 0,
  eta: 0,
  currentFile: "",
  verifyLog: [],
  fileRecords: [],
});
const project = (): ProjectConfig => ({
  id: "project-a",
  name: "Film",
  devices: ["A"],
  volumePrefix: "A_",
  completionActions: ["eject"],
  activeRuleSnapshotId: "rules-2",
  ruleSnapshots: [
    {
      id: "rules-1",
      revision: 1,
      createdAt: 1,
      operator: "DIT",
      reason: "project-created",
      sha256: "frozen",
      rules: {
        projectFolderName: "Film",
        shootingDateStart: "2026-08-25",
        shootingDateEnd: "2026-08-25",
        devices: ["A"],
        volumePrefix: "A_",
        volumePrefixByDevice: {},
        devicePositions: {},
        destinationPaths: ["/tmp/backup"],
        requiredCopies: 2,
        namingRule: "{card}",
        completionActions: ["report", "proxy"],
        checklists: [],
      },
    },
  ],
});

describe("safe completion automation", () => {
  it("creates suggestions from the task's frozen rule without executing them", () => {
    const value = task();
    expect(ensureCompletionActionPlan(value, project(), 10)).toBe(true);
    expect(value.completionActionRecords?.map((item) => item.action)).toEqual([
      "report",
      "proxy",
    ]);
    expect(value.completionActionRecords?.every((item) => item.status === "suggested")).toBe(true);
    expect(ensureCompletionActionPlan(value, project(), 20)).toBe(false);
    expect(value.completionActionRecords).toHaveLength(2);
  });

  it("never applies source-card completion actions to adopted backup records", () => {
    const value = { ...task(), provenance: "external-baseline" as const };
    expect(ensureCompletionActionPlan(value, project(), 10)).toBe(false);
    expect(value.completionActionRecords).toBeUndefined();
  });

  it("requires an operator and makes completion idempotent", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    expect(() => beginCompletionAction(value, "report", " ", 20)).toThrow(/操作人/);
    const first = beginCompletionAction(value, "report", "DIT Li", 20);
    expect(first.shouldRun).toBe(true);
    expect(() => beginCompletionAction(value, "report", "DIT Li", 21)).toThrow(/正在执行/);
    finishCompletionAction(first.record, { result: "written", at: 30 });
    const repeated = beginCompletionAction(value, "report", "DIT Li", 40);
    expect(repeated.shouldRun).toBe(false);
    expect(repeated.record.attempts).toHaveLength(1);
    expect(repeated.record.key).toBe(completionActionKey(value, "report"));
  });

  it("keeps failed attempts visible and allows an explicit retry", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    const first = beginCompletionAction(value, "proxy", "DIT Li", 20);
    failCompletionAction(first.record, new Error("source offline"), 30);
    expect(first.record).toMatchObject({ status: "failed", error: "source offline" });
    const retry = beginCompletionAction(value, "proxy", "DIT Li", 40);
    expect(retry.shouldRun).toBe(true);
    expect(retry.record.attempts).toHaveLength(2);
  });

  it("marks a restart-interrupted action failed instead of successful", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    beginCompletionAction(value, "report", "DIT Li", 20);
    expect(recoverInterruptedCompletionActions(value, 30)).toBe(true);
    expect(value.completionActionRecords?.[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/中断/),
    });
  });

  it("audits a skipped suggestion and does not allow completed history to be rewritten", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    const skipped = skipCompletionAction(value, "report", "DIT Li", 20);
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(beginCompletionAction(value, "report", "DIT Li", 30).shouldRun).toBe(false);
  });

  it("rejects forged action keys before imported or local workspace state is trusted", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    validateCompletionActionRecords(value);
    value.completionActionRecords![0].key = "0".repeat(64);
    expect(() => validateCompletionActionRecords(value)).toThrow(/完成动作记录/);
  });

  it("rejects a claimed success without a matching completed authorization attempt", () => {
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    value.completionActionRecords![0].status = "completed";
    expect(() => validateCompletionActionRecords(value)).toThrow(/状态与授权记录/);
  });

  it("publishes a new artifact without replacing an existing file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-completion-"));
    roots.push(root);
    const target = path.join(root, "report.json");
    const first = await publishNewArtifact(target, "first");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
    await expect(publishNewArtifact(target, "second")).rejects.toThrow(/未覆盖/);
    expect(await fs.readFile(target, "utf8")).toBe("first");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("falls back to an exclusive copy when the destination filesystem has no hard links", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-completion-no-link-"));
    roots.push(root);
    const target = path.join(root, "report.pdf"),
      unsupported = Object.assign(new Error("hard links unsupported"), {
        code: "ENOTSUP",
      });
    vi.spyOn(fs, "link").mockRejectedValue(unsupported);
    const published = await publishNewArtifact(target, "portable report");
    expect(await fs.readFile(target, "utf8")).toBe("portable report");
    expect(published.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(publishNewArtifact(target, "preserve existing")).rejects.toThrow(
      /未覆盖/,
    );
    expect(await fs.readFile(target, "utf8")).toBe("portable report");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("rereads completion artifacts before success and leaves mismatched content failed without overwriting it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-completion-verify-")),
      target = path.join(root, "report.pdf"),
      expectedValue = Buffer.from("expected report");
    roots.push(root);
    const digest = (await publishNewArtifact(target, expectedValue)).sha256;
    await expect(verifyPublishedArtifact(target, digest)).resolves.toBe(digest);

    await fs.writeFile(target, "post-publication mismatch");
    const value = task();
    ensureCompletionActionPlan(value, project(), 10);
    const running = beginCompletionAction(value, "report", "DIT Li", 20).record;
    try {
      await verifyPublishedArtifact(target, digest);
      finishCompletionAction(running, { result: "must not complete", at: 30 });
    } catch (error) {
      failCompletionAction(running, error, 30);
    }
    expect(running.status).toBe("failed");
    expect(running.error).toContain("回读摘要不一致");
    await expect(publishNewArtifact(target, expectedValue)).rejects.toThrow(/未覆盖/);
    expect(await fs.readFile(target, "utf8")).toBe("post-publication mismatch");
  });

  it("syncs identical reports idempotently and never overwrites a conflicting report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-report-sync-")),
      sourceDirectory = path.join(root, "source"),
      syncDirectory = path.join(root, "sync"),
      source = path.join(sourceDirectory, "report.pdf"),
      target = path.join(syncDirectory, "report.pdf");
    roots.push(root);
    await fs.mkdir(sourceDirectory);
    await fs.writeFile(source, "verified report");
    await expect(syncArtifactExclusive(source, syncDirectory)).resolves.toMatchObject({
      path: target,
      reused: false,
    });
    await expect(syncArtifactExclusive(source, syncDirectory)).resolves.toMatchObject({
      path: target,
      reused: true,
    });
    await fs.writeFile(target, "do not overwrite");
    await expect(syncArtifactExclusive(source, syncDirectory)).rejects.toThrow(
      /未覆盖/,
    );
    expect(await fs.readFile(target, "utf8")).toBe("do not overwrite");
  });

  it("creates project artifact directories exclusively", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-project-bundle-")),
      name = "Kocpy_Film_项目归档包_1",
      target = path.join(root, name);
    roots.push(root);
    await expect(createExclusiveArtifactDirectory(root, name)).resolves.toBe(
      target,
    );
    await fs.writeFile(path.join(target, "preserve.txt"), "preserve");
    await expect(createExclusiveArtifactDirectory(root, name)).rejects.toThrow(
      /未覆盖/,
    );
    expect(await fs.readFile(path.join(target, "preserve.txt"), "utf8")).toBe(
      "preserve",
    );
  });
});
