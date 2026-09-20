import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupEngine, hashFile } from "../src/main/backup/BackupEngine";
import {
  automaticReportBlocksDestinationEject,
  automaticReportBlocksTaskMutation,
  expectedAutomaticReportTargets,
  reconcileAutomaticReportDestinations,
  runAutomaticReport,
  validateAutomaticReportRecord,
  verifiedAutomaticReportPaths,
} from "../src/main/automatic-report";
import {
  publishNewArtifact,
  sha256Bytes,
} from "../src/main/completion-automation";
import type {
  AutomaticReportTarget,
  BackupTask,
} from "../src/main/types";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-auto-report-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function completedTask(destinations = 2) {
  const roots = await Promise.all(
    Array.from({ length: destinations }, async (_, index) => {
      const directory = path.join(root, `copy-${index + 1}`);
      await fs.mkdir(directory);
      return directory;
    }),
  );
  const task = new BackupEngine().createTask({
    name: "A001",
    sourcePath: path.join(root, "source"),
    destinationPaths: roots,
    devices: ["A机"],
    hashAlgorithm: "sha256",
    namingTemplate: "A001",
    shootingDate: "2026-09-19",
    projectId: "project-1",
    projectName: "测试项目",
  });
  task.status = "completed";
  task.operationAttempts![0].status = "completed";
  task.operationAttempts![0].completedAt = Date.now();
  task.destinations.forEach((destination, index) => {
    destination.verified = true;
    destination.resolvedPath = roots[index];
  });
  return task;
}

const existingSha256 = async (outputPath: string) => {
  const exists = await fs.access(outputPath).then(
    () => true,
    () => false,
  );
  return exists ? hashFile(outputPath, "sha256") : undefined;
};

function dependencies(value: Uint8Array, persist = vi.fn(async () => {})) {
  return {
    render: vi.fn(async () => value),
    persist,
    authorizeTarget: vi.fn(
      async (
        _destination: BackupTask["destinations"][number],
        _target: AutomaticReportTarget,
      ) => {},
    ),
    existingSha256,
    readArtifact: (outputPath: string) => fs.readFile(outputPath),
    publish: vi.fn(publishNewArtifact),
  };
}

describe("automatic PDF report publication", () => {
  it("keeps a completed report bound to its completed historical transfer attempt", async () => {
    const task = await completedTask(1);
    await runAutomaticReport(task, dependencies(Buffer.from("attempt evidence")));
    const originalAttempt = task.automaticReport!.operationAttemptId,
      nextAttempt = "11111111-2222-4333-8444-555555555555";
    task.operationAttemptId = nextAttempt;
    task.operationAttempts!.push({
      id: nextAttempt,
      startedAt: Date.now(),
      completedAt: Date.now() + 1,
      reason: "retry-failed",
      status: "completed",
    });
    expect(task.automaticReport!.operationAttemptId).toBe(originalAttempt);
    expect(() => validateAutomaticReportRecord(task)).not.toThrow();
    task.automaticReport!.status = "pending";
    expect(() => validateAutomaticReportRecord(task)).toThrow(/尝试引用/);
  });

  it("keeps historical report provenance valid during a later verified relocation", async () => {
    const task = await completedTask(1);
    await runAutomaticReport(task, dependencies(Buffer.from("first snapshot")));
    const historicalAttempt = task.automaticReport!.operationAttemptId,
      laterAttempt = "22222222-3333-4444-8555-666666666666",
      movedRoot = path.join(root, "relocated-after-retry");
    task.operationAttemptId = laterAttempt;
    task.operationAttempts!.push({
      id: laterAttempt,
      startedAt: Date.now(),
      completedAt: Date.now() + 1,
      reason: "retry-failed",
      status: "completed",
    });
    await fs.mkdir(movedRoot);
    task.destinations[0].path = movedRoot;
    task.destinations[0].resolvedPath = movedRoot;
    reconcileAutomaticReportDestinations(task);
    expect(task.automaticReport!.operationAttemptId).toBe(historicalAttempt);
    expect(task.automaticReport!.targets[0].rebindOnly).toBe(true);
    expect(() => validateAutomaticReportRecord(task)).not.toThrow();
  });

  it("rejects a claimed completed report without one target per destination", async () => {
    const task = await completedTask(1);
    task.automaticReport!.status = "completed";
    task.automaticReport!.targets = [];
    expect(() => validateAutomaticReportRecord(task)).toThrow(/状态不一致/);
  });

  it("blocks ejecting a report destination until the automatic report is complete", async () => {
    const task = await completedTask(1),
      destination = task.destinations[0].resolvedPath!;
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(true);
    expect(
      automaticReportBlocksDestinationEject(task, path.join(root, "unrelated")),
    ).toBe(false);
    task.automaticReport!.status = "completed";
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(false);
  });

  it("does not mislabel failed or cancelled transfers as blocked by a pending report", async () => {
    const task = await completedTask(1),
      destination = task.destinations[0].resolvedPath!;
    task.status = "failed";
    task.automaticReport!.status = "pending";
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(false);
    task.status = "cancelled";
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(false);
    task.automaticReport!.status = "running";
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(true);
    task.automaticReport!.status = "failed";
    task.automaticReport!.targets = expectedAutomaticReportTargets(task);
    task.automaticReport!.targets[0].status = "publishing";
    expect(automaticReportBlocksDestinationEject(task, destination)).toBe(true);
  });

  it("blocks task mutation while a completed task still has a pending or publishing report", async () => {
    const task = await completedTask(1);
    expect(automaticReportBlocksTaskMutation(task)).toBe(true);
    task.automaticReport!.status = "running";
    expect(automaticReportBlocksTaskMutation(task)).toBe(true);
    task.automaticReport!.status = "failed";
    expect(automaticReportBlocksTaskMutation(task)).toBe(false);
    expect(automaticReportBlocksTaskMutation(task, true)).toBe(true);
  });

  it("publishes one exclusive, verified report inside every actual backup root", async () => {
    const task = await completedTask(2),
      value = Buffer.from("synthetic pdf"),
      deps = dependencies(value);
    const result = await runAutomaticReport(task, deps);
    expect(result?.status).toBe("completed");
    expect(task.status).toBe("completed");
    expect(result?.targets).toHaveLength(2);
    for (const target of result!.targets) {
      expect(target.status).toBe("completed");
      expect(path.dirname(target.outputPath)).toBe(
        path.join(target.destinationPath, "Kocpy报告"),
      );
      expect(await fs.readFile(target.outputPath)).toEqual(value);
      expect(target.expectedSha256).toBe(sha256Bytes(value));
    }
    const firstPaths = result!.targets.map((target) => target.outputPath);
    const publishCalls = deps.publish.mock.calls.length;
    await runAutomaticReport(task, deps);
    expect(result!.targets.map((target) => target.outputPath)).toEqual(
      firstPaths,
    );
    expect(deps.publish).toHaveBeenCalledTimes(publishCalls);
  });

  it("does not publish and remains retryable when the initial running checkpoint cannot be saved", async () => {
    const task = await completedTask(1),
      value = Buffer.from("must wait for a durable checkpoint"),
      persist = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("workspace disk full"))
        .mockResolvedValue(undefined),
      deps = dependencies(value, persist);
    const failed = await runAutomaticReport(task, deps);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("启动检查点保存失败");
    expect(automaticReportBlocksTaskMutation(task)).toBe(false);
    expect(deps.render).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
    await expect(
      fs.access(failed!.targets[0].outputPath),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const retried = await runAutomaticReport(task, deps);
    expect(retried?.status).toBe("completed");
    expect(await fs.readFile(retried!.targets[0].outputPath)).toEqual(value);
  });

  it("keeps data completed when one report target fails and retries only unfinished targets", async () => {
    const task = await completedTask(2),
      value = Buffer.from("pdf bytes"),
      deps = dependencies(value);
    deps.authorizeTarget.mockImplementation(async (destination) => {
      if (destination.id === task.destinations[1].id)
        throw new Error("destination offline");
    });
    const first = await runAutomaticReport(task, deps);
    expect(first?.status).toBe("failed");
    expect(first?.error).toContain("数据已校验");
    expect(task.status).toBe("completed");
    expect(first?.targets.map((target) => target.status)).toEqual([
      "completed",
      "failed",
    ]);
    deps.authorizeTarget.mockImplementation(async () => {});
    const second = await runAutomaticReport(task, deps);
    expect(second?.status).toBe("completed");
    expect(second?.targets.map((target) => target.attempts)).toEqual([1, 2]);
  });

  it("recovers a report published before its completion checkpoint by digest", async () => {
    const task = await completedTask(1),
      value = Buffer.from("already published"),
      target = expectedAutomaticReportTargets(task)[0];
    task.automaticReport!.targets = [
      {
        ...target,
        status: "publishing",
        attempts: 1,
        expectedSha256: sha256Bytes(value),
      },
    ];
    task.automaticReport!.status = "running";
    await publishNewArtifact(target.outputPath, value);
    // A fresh render deliberately differs, like a PDF renderer adding current
    // metadata. Recovery must recognize the durable artifact without rendering.
    const deps = dependencies(Buffer.from(`different-${Date.now()}`));
    const result = await runAutomaticReport(task, deps);
    expect(result?.status).toBe("completed");
    expect(result?.targets[0].status).toBe("completed");
    expect(deps.render).not.toHaveBeenCalled();
    expect(await fs.readFile(target.outputPath)).toEqual(value);
  });

  it("never overwrites a conflicting existing report", async () => {
    const task = await completedTask(1),
      value = Buffer.from("planned report"),
      target = expectedAutomaticReportTargets(task)[0];
    await fs.mkdir(target.reportDirectory, { recursive: true });
    await fs.writeFile(target.outputPath, "preserve me");
    const result = await runAutomaticReport(task, dependencies(value));
    expect(result?.status).toBe("failed");
    expect(result?.targets[0].error).toContain("未覆盖");
    expect(await fs.readFile(target.outputPath, "utf8")).toBe("preserve me");
    expect(task.status).toBe("completed");
  });

  it("does not retroactively create reports for legacy tasks", async () => {
    const task = await completedTask(1),
      deps = dependencies(Buffer.from("pdf"));
    delete task.automaticReport;
    expect(await runAutomaticReport(task, deps)).toBeUndefined();
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("does not replay a pending automatic write imported from another workstation", async () => {
    const task = await completedTask(1),
      deps = dependencies(Buffer.from("pdf"));
    task.workstationSources = [
      {
        id: "remote-source",
        displayName: "Remote DIT",
        packageSha256: "a".repeat(64),
        importedAt: 1,
      },
    ];
    expect((await runAutomaticReport(task, deps))?.status).toBe("pending");
    expect(deps.render).not.toHaveBeenCalled();
  });

  it("recognizes only the exact registered report with a matching digest", async () => {
    const task = await completedTask(1),
      value = Buffer.from("registered");
    await runAutomaticReport(task, dependencies(value));
    const extra = path.join(
      task.destinations[0].resolvedPath!,
      "Kocpy报告",
      "unregistered.pdf",
    );
    await fs.writeFile(extra, "extra");
    expect(
      await verifiedAutomaticReportPaths(task, existingSha256),
    ).toEqual([task.automaticReport!.targets[0].outputPath]);
    await fs.writeFile(task.automaticReport!.targets[0].outputPath, "tampered");
    expect(
      await verifiedAutomaticReportPaths(task, existingSha256),
    ).toEqual([]);
  });

  it("rebinds moved and newly associated destinations only after rereading the known report digest", async () => {
    const task = await completedTask(1),
      value = Buffer.from("portable verified report");
    await runAutomaticReport(task, dependencies(value));
    const original = task.automaticReport!.targets[0],
      associatedRoot = path.join(root, "associated-copy"),
      associatedReport = path.join(
        associatedRoot,
        "Kocpy报告",
        path.basename(original.outputPath),
      );
    await fs.mkdir(associatedRoot);
    task.destinations.push({
      ...structuredClone(task.destinations[0]),
      id: "associated-destination",
      path: associatedRoot,
      resolvedPath: associatedRoot,
    });
    reconcileAutomaticReportDestinations(task);
    validateAutomaticReportRecord(task);
    expect(task.automaticReport?.targets.map((target) => target.status)).toEqual([
      "completed",
      "publishing",
    ]);
    const associatedDeps = dependencies(Buffer.from("must not be rendered"));
    await runAutomaticReport(task, associatedDeps);
    expect(associatedDeps.render).not.toHaveBeenCalled();
    expect(await fs.readFile(associatedReport)).toEqual(value);
    expect(task.automaticReport?.targets).toHaveLength(2);
    expect(
      task.automaticReport?.targets.every((target) => target.status === "completed"),
    ).toBe(true);

    const movedRoot = path.join(root, "moved-copy"),
      movedReport = path.join(
        movedRoot,
        "Kocpy报告",
        path.basename(original.outputPath),
      );
    await fs.mkdir(movedRoot);
    task.destinations[0].path = movedRoot;
    task.destinations[0].resolvedPath = movedRoot;
    task.destinations[0].verified = false;
    reconcileAutomaticReportDestinations(task);
    validateAutomaticReportRecord(task);
    expect(task.automaticReport?.status).toBe("pending");
    expect(task.automaticReport?.targets[0].outputPath).toBe(movedReport);
    expect(task.automaticReport?.targets[1].status).toBe("completed");
    task.destinations[0].verified = true;
    const movedDeps = dependencies(Buffer.from("must not be rendered either"));
    await runAutomaticReport(task, movedDeps);
    expect(movedDeps.render).not.toHaveBeenCalled();
    expect(await fs.readFile(movedReport)).toEqual(value);
    expect(task.automaticReport?.status).toBe("completed");
  });

  it("never regenerates historical evidence when neither the moved report nor its verified source is available", async () => {
    const task = await completedTask(1),
      value = Buffer.from("historical evidence");
    await runAutomaticReport(task, dependencies(value));
    const original = task.automaticReport!.targets[0],
      movedRoot = path.join(root, "moved-without-evidence");
    await fs.mkdir(movedRoot);
    await fs.unlink(original.outputPath);
    task.destinations[0].path = movedRoot;
    task.destinations[0].resolvedPath = movedRoot;
    reconcileAutomaticReportDestinations(task);
    const deps = dependencies(Buffer.from("newly rendered bytes are forbidden"));
    const result = await runAutomaticReport(task, deps);
    expect(result?.status).toBe("failed");
    expect(result?.targets[0].error).toContain("原已验证报告");
    expect(deps.render).not.toHaveBeenCalled();
    expect(
      await fs
        .access(result!.targets[0].outputPath)
        .then(() => true, () => false),
    ).toBe(false);
  });
});
