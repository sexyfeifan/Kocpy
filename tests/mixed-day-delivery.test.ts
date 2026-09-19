import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupTask } from "../src/main/types";
import { hashFile } from "../src/main/backup/BackupEngine";
import { volumeIdentity } from "../src/main/system";
import {
  applyCardDateAllocationDecisions,
  authorizeDailyDeliveryArtifact,
  buildCardDateAllocation,
  dailyDeliveryReportHtml,
  executeDailyDeliveryRun,
  prepareDailyDeliveryRun,
} from "../src/main/mixed-day-delivery";

let root: string,
  verifiedCard: string,
  deliveryParent: string,
  task: BackupTask;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mixed-day-"));
  verifiedCard = path.join(root, "verified-card");
  deliveryParent = path.join(root, "delivery");
  await fs.mkdir(path.join(verifiedCard, "DCIM", "20260915"), {
    recursive: true,
  });
  await fs.mkdir(deliveryParent);
  const files = [
    ["DCIM/20260915/C001.MOV", "video"],
    ["DCIM/20260915/C001.XML", "sidecar"],
    ["DCIM/20260915/C002.MOV", "video-two"],
  ] as const;
  const identity = await volumeIdentity(verifiedCard);
  const records = [];
  for (const [relativePath, content] of files) {
    const absolute = path.join(verifiedCard, relativePath);
    await fs.writeFile(absolute, content);
    records.push({
      name: path.basename(relativePath),
      relativePath,
      size: Buffer.byteLength(content),
      srcChecksum: await hashFile(absolute, "sha256"),
      destinations: [
        {
          path: absolute,
          checksum: await hashFile(absolute, "sha256"),
          verified: true,
        },
      ],
    });
  }
  task = {
    id: "task-mixed-day",
    provenance: "kocpy-transfer",
    name: "A001",
    projectId: "project-one",
    sourcePath: path.join(root, "ejected-source"),
    devices: ["FX3"],
    destinations: [
      {
        id: "verified-copy",
        path: verifiedCard,
        resolvedPath: verifiedCard,
        label: "工作盘",
        verified: true,
        bytesWritten: records.reduce((sum, item) => sum + item.size, 0),
        volumeId: identity.id,
        volumeUuid: identity.uuid,
      },
    ],
    hashAlgorithm: "sha256",
    namingTemplate: "A001",
    status: "completed",
    totalFiles: records.length,
    completedFiles: records.length,
    totalBytes: records.reduce((sum, item) => sum + item.size, 0),
    transferredBytes: records.reduce((sum, item) => sum + item.size, 0),
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords: records,
  };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("mixed-day full-card allocation and delivery", () => {
  it("keeps date detection advisory and preserves clip sidecars as one group", async () => {
    const plan = await buildCardDateAllocation(task, verifiedCard, {
      now: 100,
      readEmbeddedDate: async () => "2026-09-15T18:20:00Z",
    });
    expect(plan.groups).toHaveLength(2);
    const first = plan.groups.find((group) => group.label === "C001")!;
    expect(first.relativePaths).toEqual([
      "DCIM/20260915/C001.MOV",
      "DCIM/20260915/C001.XML",
    ]);
    expect(first.suggestedDate).toBe("2026-09-15");
    expect(first.suggestionConfidence).toBe("high");
    expect(first.assignedDate).toBeUndefined();
    expect(() =>
      applyCardDateAllocationDecisions(
        task,
        plan,
        [{ groupId: first.id, shootingDate: "2026-09-15" }],
        "",
      ),
    ).toThrow(/确认人/);
    const confirmed = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate: "2026-09-15",
      })),
      "DIT",
      200,
    );
    expect(confirmed.groups.every((group) => group.confirmedBy === "DIT")).toBe(
      true,
    );
  });

  it("analyzes the actual verified suffix copy instead of a conflicting relative path", async () => {
    const record = task.fileRecords.find(
        (item) => item.relativePath === "DCIM/20260915/C002.MOV",
      )!,
      original = record.destinations[0].path,
      suffixCopy = path.join(path.dirname(original), "C002_1.MOV");
    await fs.rename(original, suffixCopy);
    await fs.writeFile(original, "conflict!");
    record.destinations[0].path = suffixCopy;
    let probed = "";
    await buildCardDateAllocation(task, verifiedCard, {
      readEmbeddedDate: async (absolute) => {
        if (absolute.includes("C002")) probed = absolute;
        return "2026-09-15T18:20:00Z";
      },
    });
    expect(probed).toBe(await fs.realpath(suffixCopy));
  });

  it("rejects same-size content drift before offering date suggestions", async () => {
    const file = path.join(verifiedCard, "DCIM", "20260915", "C001.MOV");
    await fs.writeFile(file, "wrong");
    await expect(buildCardDateAllocation(task, verifiedCard)).rejects.toThrow(
      /偏离原始校验记录/,
    );
  });

  it("copies only the confirmed day, re-reads SHA-256 and leaves the full card unchanged", async () => {
    const before = await Promise.all(
      task.fileRecords.map((record) =>
        hashFile(path.join(verifiedCard, record.relativePath), "sha256"),
      ),
    );
    let plan = await buildCardDateAllocation(task, verifiedCard, {
      readEmbeddedDate: async () => "2026-09-15T18:20:00Z",
    });
    plan = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate:
          group.label === "C001" ? "2026-09-15" : "2026-09-14",
      })),
      "DIT",
    );
    const run = await prepareDailyDeliveryRun(task, plan, {
      shootingDate: "2026-09-15",
      sourceDestinationId: "verified-copy",
      destinationParent: deliveryParent,
      operator: "DIT",
      projectName: "测试项目",
    });
    const checkpoints: string[] = [];
    const completed = await executeDailyDeliveryRun(
      task,
      plan,
      run,
      async (value) => {
        checkpoints.push(`${value.status}:${value.completedFiles}`);
      },
    );
    expect(completed.status).toBe("completed");
    expect(completed.totalFiles).toBe(2);
    expect(completed.files.every((file) => file.verified)).toBe(true);
    await expect(
      fs.access(path.join(completed.finalPath, "Media", "DCIM", "20260915", "C002.MOV")),
    ).rejects.toThrow();
    expect(completed.manifestPaths).toHaveLength(2);
    expect(checkpoints).toContain("running:1");
    expect(checkpoints.at(-1)).toBe("completed:2");
    expect(dailyDeliveryReportHtml(task, completed).toString("utf8")).toContain(
      "测试项目",
    );
    const after = await Promise.all(
      task.fileRecords.map((record) =>
        hashFile(path.join(verifiedCard, record.relativePath), "sha256"),
      ),
    );
    expect(after).toEqual(before);
  });

  it("refuses to merge into an unrelated existing delivery directory", async () => {
    let plan = await buildCardDateAllocation(task, verifiedCard);
    plan = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate: "2026-09-15",
      })),
      "DIT",
    );
    const run = await prepareDailyDeliveryRun(task, plan, {
      shootingDate: "2026-09-15",
      sourceDestinationId: "verified-copy",
      destinationParent: deliveryParent,
      operator: "DIT",
    });
    await fs.mkdir(run.finalPath);
    await fs.writeFile(path.join(run.finalPath, "unrelated.txt"), "keep");
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /禁止覆盖或合并/,
    );
    expect(await fs.readFile(path.join(run.finalPath, "unrelated.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("resumes only its own interrupted directory and rechecks completed files", async () => {
    let plan = await buildCardDateAllocation(task, verifiedCard);
    plan = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate: "2026-09-15",
      })),
      "DIT",
    );
    const run = await prepareDailyDeliveryRun(task, plan, {
      shootingDate: "2026-09-15",
      sourceDestinationId: "verified-copy",
      destinationParent: deliveryParent,
      operator: "DIT",
    });
    const broken = path.join(verifiedCard, "DCIM", "20260915", "C002.MOV"),
      original = await fs.readFile(broken);
    await fs.writeFile(broken, "changed after verification");
    let latest = run;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/大小与记录不一致|偏离原始校验记录/);
    expect(latest.status).toBe("failed");
    expect(latest.completedFiles).toBe(2);
    await fs.writeFile(broken, original);
    const resumed = await executeDailyDeliveryRun(
      task,
      plan,
      latest,
      async (checkpoint) => {
        latest = structuredClone(checkpoint);
      },
    );
    expect(resumed.status).toBe("completed");
    expect(resumed.completedFiles).toBe(3);
    expect(
      await fs.readFile(
        path.join(resumed.finalPath, "Media", "DCIM", "20260915", "C001.MOV"),
        "utf8",
      ),
    ).toBe("video");
  });

  it("continues idempotently when the JSON manifest was published before an interruption", async () => {
    let plan = await buildCardDateAllocation(task, verifiedCard);
    plan = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate: "2026-09-15",
      })),
      "DIT",
    );
    const run = await prepareDailyDeliveryRun(task, plan, {
      shootingDate: "2026-09-15",
      sourceDestinationId: "verified-copy",
      destinationParent: deliveryParent,
      operator: "DIT",
    });
    let latest = run;
    const originalWrite = fs.writeFile.bind(fs),
      write = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (String(args[0]).includes("当日交付清单.mhl"))
          throw Object.assign(new Error("simulated interruption"), {
            code: "EIO",
          });
        return originalWrite(...args);
      });
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/simulated interruption/);
    write.mockRestore();
    expect(latest.status).toBe("failed");
    expect(latest.completedFiles).toBe(3);
    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    expect(resumed.manifestPaths).toHaveLength(2);
  });

  it("rejects a report directory replaced by a symlink", async () => {
    let plan = await buildCardDateAllocation(task, verifiedCard);
    plan = applyCardDateAllocationDecisions(
      task,
      plan,
      plan.groups.map((group) => ({
        groupId: group.id,
        shootingDate: "2026-09-15",
      })),
      "DIT",
    );
    const run = await prepareDailyDeliveryRun(task, plan, {
        shootingDate: "2026-09-15",
        sourceDestinationId: "verified-copy",
        destinationParent: deliveryParent,
        operator: "DIT",
      }),
      completed = await executeDailyDeliveryRun(task, plan, run),
      reportDirectory = path.join(completed.finalPath, "Kocpy报告"),
      outside = path.join(root, "outside-reports");
    await fs.rm(reportDirectory, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, reportDirectory);
    await expect(
      authorizeDailyDeliveryArtifact(completed, "report.pdf"),
    ).rejects.toThrow(/真实目录|符号链接/);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
