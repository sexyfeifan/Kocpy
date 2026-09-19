import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BackupEngine, hashFile } from "../src/main/backup/BackupEngine";
import {
  expectedAutomaticReportTargets,
  runAutomaticReport,
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
    publish: vi.fn(publishNewArtifact),
  };
}

describe("automatic PDF report publication", () => {
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
});
