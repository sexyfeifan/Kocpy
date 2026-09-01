import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginCompletionAction,
  completionActionKey,
  ensureCompletionActionPlan,
  failCompletionAction,
  finishCompletionAction,
  publishNewArtifact,
  recoverInterruptedCompletionActions,
  skipCompletionAction,
  validateCompletionActionRecords,
} from "../src/main/completion-automation";
import type { BackupTask, ProjectConfig } from "../src/main/types";

const roots: string[] = [];
afterEach(async () => {
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
    await expect(publishNewArtifact(target, "second")).rejects.toThrow(/未覆盖/);
    expect(await fs.readFile(target, "utf8")).toBe("first");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });
});
