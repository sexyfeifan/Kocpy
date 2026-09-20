import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { BackupTask } from "../src/main/types";
import { hashFile } from "../src/main/backup/BackupEngine";
import * as system from "../src/main/system";
import {
  applyCardDateAllocationDecisions,
  authorizeDailyDeliveryArtifact,
  buildCardDateAllocation,
  dailyDeliveryReportFileName,
  dailyDeliveryReportHtml,
  estimateDailyDeliveryJournalBytes,
  estimateDailyDeliveryMarkerBytes,
  publishDailyDeliveryReport,
  verifyPublishedDailyDeliveryReport,
  executeDailyDeliveryRun,
  prepareDailyDeliveryRun,
  reauthorizeRecordedDailyDeliveryReport,
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
  const identity = await system.volumeIdentity(verifiedCard);
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

async function completedDeliveryRun() {
  const { plan, run } = await preparedDeliveryRun();
  return executeDailyDeliveryRun(task, plan, run);
}

async function preparedDeliveryRun() {
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
  return { plan, run };
}

function ownershipSidecar(run: {
  finalPath: string;
  destinationParent: string;
  id: string;
}) {
  return path.join(
    run.destinationParent,
    `.${path.basename(run.finalPath)}.${run.id}.kocpy-owner.json`,
  );
}

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
        shootingDate: group.label === "C001" ? "2026-09-15" : "2026-09-14",
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
      fs.access(
        path.join(completed.finalPath, "Media", "DCIM", "20260915", "C002.MOV"),
      ),
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

  it("does not deliver xxhash32 content changed at the former two-read boundary", async () => {
    task.hashAlgorithm = "xxhash32";
    for (const record of task.fileRecords) {
      const digest = await hashFile(record.destinations[0].path, "xxhash32");
      record.srcChecksum = digest;
      record.destinations[0].checksum = digest;
    }
    const { plan, run } = await preparedDeliveryRun();
    let injections = 0;
    const relativePath = "DCIM/20260915/C001.MOV",
      source = path.join(verifiedCard, relativePath),
      output = path.join(run.finalPath, "Media", relativePath),
      staging = `${output}.partial-${run.id}`;

    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterSourceEvidenceRead: async (sourceFile, currentRelativePath) => {
          if (currentRelativePath !== relativePath || injections) return;
          injections++;
          expect(sourceFile).toBe(await fs.realpath(source));
          // Same-size mutation at the exact boundary where the previous
          // implementation started its second, SHA-256-only source read.
          await fs.writeFile(sourceFile, "muted");
        },
      }),
    ).rejects.toThrow(/复制发布前发生变化|交付写入后校验失败/);

    expect(injections).toBe(1);
    await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source, "utf8")).toBe("muted");
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
    expect(
      await fs.readFile(path.join(run.finalPath, "unrelated.txt"), "utf8"),
    ).toBe("keep");
  });

  it("does not adopt an unknown empty delivery directory without an ownership sidecar", async () => {
    const { plan, run } = await preparedDeliveryRun();
    await fs.mkdir(run.finalPath);

    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /不属于本次任务/,
    );
    expect(await fs.readdir(run.finalPath)).toEqual([]);
  });

  it("resumes the exact mkdir-before-marker crash boundary and removes its sidecar", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      sidecar = ownershipSidecar(run),
      marker = path.join(run.finalPath, ".kocpy-daily-delivery.json");

    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterFinalDirectoryCreated: () => {
          throw new Error("simulated crash after mkdir");
        },
      }),
    ).rejects.toThrow(/simulated crash after mkdir/);
    expect((await fs.lstat(run.finalPath)).isDirectory()).toBe(true);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toMatchObject({
      runId: run.id,
      finalPath: run.finalPath,
      destinationVolumeId: run.destinationVolumeId,
      destinationVolumeUuid: run.destinationVolumeUuid,
    });

    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
    expect(resumed.completedFiles).toBe(run.totalFiles);
    await expect(fs.access(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes an owned empty Media directory created before the first marker", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      sidecar = ownershipSidecar(run),
      marker = path.join(run.finalPath, ".kocpy-daily-delivery.json"),
      media = path.join(run.finalPath, "Media");
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterMediaDirectoryCreated: () => {
          throw new Error("simulated crash after Media ownership");
        },
      }),
    ).rejects.toThrow(/simulated crash after Media ownership/);
    expect(await fs.readdir(media)).toEqual([]);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await fs.readFile(sidecar, "utf8")).directoryBindings.mediaRoot,
    ).toMatchObject({
      dev: expect.any(Number),
      ino: expect.any(Number),
    });

    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
    await expect(fs.access(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it.each([
    [
      "run identity",
      (value: Record<string, unknown>) => ({ ...value, runId: "another-run" }),
    ],
    [
      "final path",
      (value: Record<string, unknown>) => ({
        ...value,
        finalPath: path.join(root, "another-delivery"),
      }),
    ],
    [
      "destination volume",
      (value: Record<string, unknown>) =>
        value.destinationVolumeUuid
          ? { ...value, destinationVolumeUuid: "another-volume-uuid" }
          : { ...value, destinationVolumeId: "another-volume-id" },
    ],
  ])("rejects a bootstrap sidecar with changed %s", async (_label, mutate) => {
    const { plan, run } = await preparedDeliveryRun(),
      sidecar = ownershipSidecar(run);
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterFinalDirectoryCreated: () => {
          throw new Error("simulated crash after mkdir");
        },
      }),
    ).rejects.toThrow(/simulated crash after mkdir/);
    const valid = JSON.parse(await fs.readFile(sidecar, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(sidecar, JSON.stringify(mutate(valid)));

    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /所有权标记.*不一致/,
    );
    expect(await fs.readdir(run.finalPath)).toEqual([]);
  });

  it("refuses a symlinked bootstrap sidecar without changing its target", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      sidecar = ownershipSidecar(run),
      outside = path.join(root, "outside-owner.json");
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterFinalDirectoryCreated: () => {
          throw new Error("simulated crash after mkdir");
        },
      }),
    ).rejects.toThrow(/simulated crash after mkdir/);
    const valid = await fs.readFile(sidecar);
    await fs.unlink(sidecar);
    await fs.writeFile(outside, valid);
    await fs.symlink(outside, sidecar);

    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /所有权标记不可安全读取/,
    );
    expect(await fs.readFile(outside)).toEqual(valid);
    expect(await fs.readdir(run.finalPath)).toEqual([]);
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

  it("rejects a staging file replaced by a symlink before publication", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
        if (checkpoint.publicationInProgress)
          throw new Error("simulated crash before publication");
      }),
    ).rejects.toThrow(/simulated crash before publication/);
    const publication = latest.publicationInProgress!;
    await fs.unlink(publication.stagingPath);
    const source = task.fileRecords.find(
      (record) => record.relativePath === publication.relativePath,
    )!.destinations[0].path;
    await fs.symlink(source, publication.stagingPath);

    await expect(executeDailyDeliveryRun(task, plan, latest)).rejects.toThrow(
      /不是安全的普通文件|符号链接|不可安全打开/,
    );
    expect((await fs.lstat(publication.stagingPath)).isSymbolicLink()).toBe(true);
    await expect(fs.access(publication.finalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("rejects a publication output replaced by a symlink", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
        if (checkpoint.publicationInProgress)
          throw new Error("simulated crash before publication");
      }),
    ).rejects.toThrow(/simulated crash before publication/);
    const publication = latest.publicationInProgress!,
      outside = path.join(root, "outside-publication.mov");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, publication.finalPath);

    await expect(executeDailyDeliveryRun(task, plan, latest)).rejects.toThrow(
      /不是安全的普通文件|符号链接|不可安全打开/,
    );
    expect((await fs.lstat(publication.finalPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  }, 60_000);

  it("moves an interrupted partial Media output outside Media before retrying", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = structuredClone(run);
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
        if (checkpoint.publicationInProgress)
          throw new Error("crash before fallback publication");
      }),
    ).rejects.toThrow(/crash before fallback publication/);
    const publication = latest.publicationInProgress!;
    await fs.writeFile(publication.finalPath, "partial fallback output");

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    const recoveryDirectory = path.join(
        resumed.finalPath,
        `Kocpy恢复-${resumed.id}`,
      ),
      recovered = await fs.readdir(recoveryDirectory);
    expect(recovered).toHaveLength(1);
    expect(
      await fs.readFile(path.join(recoveryDirectory, recovered[0]), "utf8"),
    ).toBe("partial fallback output");
    expect(resumed.recoveryArtifacts).toEqual([
      path.join(recoveryDirectory, recovered[0]),
    ]);
    const mediaEntries = await fs.readdir(
      path.dirname(publication.finalPath),
    );
    expect(mediaEntries).toContain(path.basename(publication.finalPath));
    expect(
      mediaEntries.some((entry) => /\.(?:incomplete|invalid)-/.test(entry)),
    ).toBe(false);
  }, 60_000);

  it("rejects a staging hardlink to the verified source", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
        if (checkpoint.publicationInProgress)
          throw new Error("simulated crash before publication");
      }),
    ).rejects.toThrow(/simulated crash before publication/);
    const publication = latest.publicationInProgress!,
      source = task.fileRecords.find(
        (record) => record.relativePath === publication.relativePath,
      )!.destinations[0].path;
    await fs.unlink(publication.stagingPath);
    await fs.link(source, publication.stagingPath);

    await expect(executeDailyDeliveryRun(task, plan, latest)).rejects.toThrow(
      /额外硬链接|共用同一 inode/,
    );
    await expect(fs.access(publication.finalPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 60_000);

  it("recovers the exact linked-before-unlink publication boundary", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run,
      injected = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterPublicationLinked: () => {
            if (injected) return;
            injected = true;
            throw new Error("simulated crash after link");
          },
        },
      ),
    ).rejects.toThrow(/simulated crash after link/);
    const publication = latest.publicationInProgress!,
      staged = await fs.lstat(publication.stagingPath),
      output = await fs.lstat(publication.finalPath);
    expect(staged.ino).toBe(output.ino);
    expect(staged.nlink).toBe(2);
    expect(output.nlink).toBe(2);

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    await expect(fs.access(publication.stagingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await fs.lstat(publication.finalPath)).nlink).toBe(1);
  }, 60_000);

  it("reuses one journaled publication intent across two crashes", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = structuredClone(run),
      firstCrash = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterPublicationIntentPersisted: () => {
            if (firstCrash) return;
            firstCrash = true;
            throw new Error("first crash after intent");
          },
        },
      ),
    ).rejects.toThrow(/first crash after intent/);
    let secondCrash = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        latest,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterPublicationLinked: () => {
            if (secondCrash) return;
            secondCrash = true;
            throw new Error("second crash after publication");
          },
        },
      ),
    ).rejects.toThrow(/second crash after publication/);

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    const journal = await fs.readFile(
      path.join(
        run.finalPath,
        ".kocpy-daily-delivery.journal.ndjson",
      ),
      "utf8",
    );
    const firstPath = resumed.files[0].relativePath;
    expect(
      journal
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter(
          (event) =>
            event.type === "publication-intent" &&
            event.payload.relativePath === firstPath,
        ),
    ).toHaveLength(1);
  }, 60_000);

  it("reuses the publication intent after moving a wrong output and crashing again", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = structuredClone(run),
      firstCrash = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterPublicationIntentPersisted: () => {
            if (firstCrash) return;
            firstCrash = true;
            throw new Error("first crash before wrong output");
          },
        },
      ),
    ).rejects.toThrow(/first crash before wrong output/);
    await fs.writeFile(
      latest.publicationInProgress!.finalPath,
      "wrong interrupted output",
    );
    let secondCrash = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        latest,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterPublicationLinked: () => {
            if (secondCrash) return;
            secondCrash = true;
            throw new Error("second crash after wrong output recovery");
          },
        },
      ),
    ).rejects.toThrow(/second crash after wrong output recovery/);

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    expect(resumed.recoveryArtifacts).toHaveLength(1);
    expect(await fs.readFile(resumed.recoveryArtifacts![0], "utf8")).toBe(
      "wrong interrupted output",
    );
  }, 60_000);

  it("rejects final-directory replacement during the next source read", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      displaced = `${run.finalPath}-displaced`;
    let reads = 0;
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterSourceEvidenceRead: async () => {
          reads++;
          if (reads !== 2) return;
          await fs.rename(run.finalPath, displaced);
          await fs.mkdir(run.finalPath);
        },
      }),
    ).rejects.toThrow(/被替换|发生变化|不存在|ENOENT/);
    expect(await fs.readdir(run.finalPath)).toEqual([]);
    expect(await fs.readdir(displaced)).toContain("Media");
  }, 60_000);

  it("rejects an internal symlink in the Media parent chain", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let injected = false;
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterSourceEvidenceRead: async () => {
          if (injected) return;
          injected = true;
          const media = path.join(run.finalPath, "Media"),
            alternate = path.join(media, "ALT");
          await fs.mkdir(alternate);
          await fs.symlink(alternate, path.join(media, "DCIM"));
        },
      }),
    ).rejects.toThrow(/没有持久化身份|符号链接|父链/);
    expect(await fs.readdir(path.join(run.finalPath, "Media", "ALT"))).toEqual(
      [],
    );
  }, 60_000);

  it("rejects a same-name nested parent replacement", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let changed = false;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        if (
          changed ||
          checkpoint.completedFiles !== 1 ||
          checkpoint.publicationInProgress
        )
          return;
        changed = true;
        const media = path.join(run.finalPath, "Media"),
          parent = path.join(media, "DCIM");
        await fs.rename(parent, path.join(media, "DCIM-original"));
        await fs.mkdir(parent);
      }),
    ).rejects.toThrow(/同名目录替换|被替换/);
    expect(await fs.readdir(path.join(run.finalPath, "Media", "DCIM"))).toEqual(
      [],
    );
  }, 60_000);

  it("terminally rehashes every delivered file before writing manifests", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let changed = false;
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        if (
          changed ||
          checkpoint.completedFiles !== 1 ||
          checkpoint.publicationInProgress
        )
          return;
        changed = true;
        const first = checkpoint.files[0];
        await fs.writeFile(
          path.join(run.finalPath, "Media", first.relativePath),
          "muted",
        );
      }),
    ).rejects.toThrow(/终检 SHA-256 不一致/);
    await expect(
      fs.access(path.join(run.finalPath, "Kocpy报告")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("rechecks delivered file identities after publishing the manifests", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let changed = false;
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        const result = await originalLink(...args);
        if (!changed && String(args[1]).includes("当日交付清单.json")) {
          changed = true;
          await fs.writeFile(
            path.join(run.finalPath, "Media", "DCIM/20260915/C001.MOV"),
            "changed after terminal SHA-256",
          );
        }
        return result;
      });
    try {
      await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
        /终检后发生变化/,
      );
    } finally {
      link.mockRestore();
    }
  }, 60_000);

  it("rechecks the JSON manifest after publishing the MHL", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let changed = false;
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        const result = await originalLink(...args);
        if (!changed && String(args[1]).includes("当日交付清单.mhl")) {
          changed = true;
          const reportDirectory = path.join(run.finalPath, "Kocpy报告"),
            jsonName = (await fs.readdir(reportDirectory)).find((name) =>
              name.endsWith("当日交付清单.json"),
            )!;
          await fs.writeFile(path.join(reportDirectory, jsonName), "changed");
        }
        return result;
      });
    try {
      await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
        /生成产物.*终检失败|生成产物在终检后发生变化/,
      );
    } finally {
      link.mockRestore();
    }
  }, 60_000);

  it("rejects an extra Media file inserted after the first terminal verification", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      injected = path.join(run.finalPath, "Media", "unexpected-old-day.mov");
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterInitialTerminalVerification: async () => {
          await fs.writeFile(injected, "old day");
        },
      }),
    ).rejects.toThrow(/未登记或非独立文件|确认范围不一致/);
    expect((await fs.lstat(injected)).isFile()).toBe(true);
  }, 60_000);

  it("rejects oversized recovery metadata before reading it into memory", async () => {
    const { plan, run } = await preparedDeliveryRun();
    await fs.mkdir(run.finalPath);
    const markerPath = path.join(
      run.finalPath,
      ".kocpy-daily-delivery.json",
    );
    await fs.writeFile(markerPath, "");
    await fs.truncate(markerPath, 128 * 1024 * 1024 + 1);
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /恢复标记不可安全读取/,
    );

    await fs.rm(run.finalPath, { recursive: true });
    await fs.mkdir(run.finalPath);
    await fs.writeFile(ownershipSidecar(run), "");
    await fs.truncate(ownershipSidecar(run), 128 * 1024 * 1024 + 1);
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /所有权标记损坏|安全读取上限/,
    );
  }, 60_000);

  it("rejects a changed frozen mount-source identity", async () => {
    const { plan, run } = await preparedDeliveryRun();
    delete run.destinationVolumeIdentity!.uuid;
    run.destinationVolumeIdentity!.mountSourceDigest = "f".repeat(64);
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /完整磁盘身份.*不一致/,
    );
  });

  it("keeps full volume probes at execution stages instead of per file", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      identity = vi.spyOn(system, "volumeIdentity");
    try {
      const completed = await executeDailyDeliveryRun(task, plan, run);
      expect(completed.status).toBe("completed");
      expect(identity.mock.calls.length).toBeLessThanOrEqual(10);
    } finally {
      identity.mockRestore();
    }
  }, 60_000);

  it("keeps 10k recovery metadata growth linear and the marker bounded", async () => {
    const { run } = await preparedDeliveryRun(),
      makeRecords = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          name: `C${String(index).padStart(5, "0")}.MOV`,
          relativePath: `DCIM/DAY01/C${String(index).padStart(5, "0")}.MOV`,
          size: index + 1,
          srcChecksum: "a".repeat(64),
          destinations: [],
        })),
      fiveThousand = makeRecords(5_000),
      tenThousand = makeRecords(10_000),
      fiveSize =
        estimateDailyDeliveryJournalBytes(run, fiveThousand) +
        estimateDailyDeliveryMarkerBytes(run),
      tenSize =
        estimateDailyDeliveryJournalBytes(run, tenThousand) +
        estimateDailyDeliveryMarkerBytes(run);
    expect(tenSize).toBeGreaterThan(fiveSize);
    expect(tenSize).toBeLessThan(fiveSize * 2.1);
    expect(tenSize).toBeLessThan(128 * 1024 * 1024);
    expect(estimateDailyDeliveryMarkerBytes({
      ...run,
      files: tenThousand.map((record) => ({
        relativePath: record.relativePath,
        size: record.size,
        sourceChecksum: "b".repeat(64),
        sourceVerifiedAt: Date.now(),
        deliveredChecksum: "b".repeat(64),
        verified: true,
      })),
    })).toBe(estimateDailyDeliveryMarkerBytes(run));
  }, 60_000);

  it("recovers when the journal was created before the first marker", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let interrupted = false;
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterJournalCreated: () => {
          if (interrupted) return;
          interrupted = true;
          throw new Error("crash after journal creation");
        },
      }),
    ).rejects.toThrow(/crash after journal creation/);
    await expect(
      fs.access(path.join(run.finalPath, ".kocpy-daily-delivery.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
  }, 60_000);

  it("creates the recovery journal when the destination denies hardlinks", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (String(args[1]).endsWith(".kocpy-daily-delivery.journal.ndjson"))
          throw Object.assign(new Error("journal hardlinks unsupported"), {
            code: "EINVAL",
          });
        return originalLink(...args);
      });
    try {
      const completed = await executeDailyDeliveryRun(task, plan, run);
      expect(completed.status).toBe("completed");
      expect(
        (
          await fs.lstat(
            path.join(
              run.finalPath,
              ".kocpy-daily-delivery.journal.ndjson",
            ),
          )
        ).nlink,
      ).toBe(1);
    } finally {
      link.mockRestore();
    }
  }, 60_000);

  it("recovers an exact journal link-before-temporary-cleanup boundary", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let interrupted = false;
    const originalUnlink = fs.unlink.bind(fs),
      unlink = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (
          !interrupted &&
          String(target).endsWith(
            `.kocpy-daily-delivery.journal.ndjson.partial-${run.id}`,
          )
        ) {
          interrupted = true;
          throw Object.assign(new Error("crash before journal temp cleanup"), {
            code: "EIO",
          });
        }
        return originalUnlink(target);
      });
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /crash before journal temp cleanup/,
    );
    unlink.mockRestore();
    const journal = path.join(
        run.finalPath,
        ".kocpy-daily-delivery.journal.ndjson",
      ),
      temporary = `${journal}.partial-${run.id}`;
    expect((await fs.lstat(journal)).nlink).toBe(2);
    expect((await fs.lstat(temporary)).nlink).toBe(2);
    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
    expect((await fs.lstat(journal)).nlink).toBe(1);
    await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("preserves an interrupted journal fallback target and publishes the valid temp", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let interrupted = false;
    const originalUnlink = fs.unlink.bind(fs),
      unlink = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
        if (
          !interrupted &&
          String(target).endsWith(
            `.kocpy-daily-delivery.journal.ndjson.partial-${run.id}`,
          )
        ) {
          interrupted = true;
          throw new Error("crash with valid journal temp");
        }
        return originalUnlink(target);
      });
    await expect(executeDailyDeliveryRun(task, plan, run)).rejects.toThrow(
      /crash with valid journal temp/,
    );
    unlink.mockRestore();
    const journal = path.join(
        run.finalPath,
        ".kocpy-daily-delivery.journal.ndjson",
      ),
      temporary = `${journal}.partial-${run.id}`;
    await fs.unlink(journal);
    await fs.writeFile(journal, "partial fallback journal target");

    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
    const recovery = (await fs.readdir(run.finalPath)).find((entry) =>
      entry.startsWith(".kocpy-daily-delivery.journal.ndjson.recovery-"),
    );
    expect(recovery).toBeTruthy();
    expect(await fs.readFile(path.join(run.finalPath, recovery!), "utf8")).toBe(
      "partial fallback journal target",
    );
    await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("preserves a torn journal creation temp and safely recreates it", async () => {
    const { plan, run } = await preparedDeliveryRun();
    await expect(
      executeDailyDeliveryRun(task, plan, run, undefined, {
        afterMediaDirectoryCreated: () => {
          throw new Error("crash before journal creation");
        },
      }),
    ).rejects.toThrow(/crash before journal creation/);
    const journal = path.join(
        run.finalPath,
        ".kocpy-daily-delivery.journal.ndjson",
      ),
      temporary = `${journal}.partial-${run.id}`;
    await fs.writeFile(temporary, '{"partial":');
    const resumed = await executeDailyDeliveryRun(task, plan, run);
    expect(resumed.status).toBe("completed");
    const recovery = (await fs.readdir(run.finalPath)).find((entry) =>
      entry.startsWith(".kocpy-daily-delivery.journal.ndjson.recovery-"),
    );
    expect(recovery).toBeTruthy();
    expect(await fs.readFile(path.join(run.finalPath, recovery!), "utf8")).toBe(
      '{"partial":',
    );
  }, 60_000);

  it("replays completed evidence from the journal when workspace state is stale", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let stale = structuredClone(run),
      interrupted = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          if (checkpoint.completedFiles === 0 && !checkpoint.publicationInProgress)
            stale = structuredClone(checkpoint);
        },
        {
          afterFileCompleted: () => {
            if (interrupted) return;
            interrupted = true;
            throw new Error("crash after journaled file completion");
          },
        },
      ),
    ).rejects.toThrow(/crash after journaled file completion/);
    expect(stale.completedFiles).toBe(0);
    const resumed = await executeDailyDeliveryRun(task, plan, stale);
    expect(resumed.status).toBe("completed");
    expect(resumed.completedFiles).toBe(resumed.totalFiles);
  }, 60_000);

  it("preserves and truncates only an unauthorized torn journal tail", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = structuredClone(run),
      interrupted = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterFileCompleted: () => {
            if (interrupted) return;
            interrupted = true;
            throw new Error("crash before torn tail injection");
          },
        },
      ),
    ).rejects.toThrow(/crash before torn tail injection/);
    const journal = path.join(
      run.finalPath,
      ".kocpy-daily-delivery.journal.ndjson",
    );
    await fs.appendFile(journal, '{"uncommitted":');
    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    const tail = (await fs.readdir(run.finalPath)).find((entry) =>
      entry.startsWith(".kocpy-daily-delivery.journal.ndjson.torn-tail-"),
    );
    expect(tail).toBeTruthy();
    expect(await fs.readFile(path.join(run.finalPath, tail!), "utf8")).toBe(
      '{"uncommitted":',
    );
  }, 60_000);

  it("rejects a modified complete journal event without truncating evidence", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = structuredClone(run),
      interrupted = false;
    await expect(
      executeDailyDeliveryRun(
        task,
        plan,
        run,
        async (checkpoint) => {
          latest = structuredClone(checkpoint);
        },
        {
          afterFileCompleted: () => {
            if (interrupted) return;
            interrupted = true;
            throw new Error("crash before journal tamper");
          },
        },
      ),
    ).rejects.toThrow(/crash before journal tamper/);
    const journal = path.join(
        run.finalPath,
        ".kocpy-daily-delivery.journal.ndjson",
      ),
      before = await fs.readFile(journal, "utf8"),
      tampered = before.replace('"verified":true', '"verified":null');
    expect(tampered).not.toBe(before);
    await fs.writeFile(journal, tampered);
    await expect(executeDailyDeliveryRun(task, plan, latest)).rejects.toThrow(
      /中段被修改/,
    );
    expect(await fs.readFile(journal, "utf8")).toBe(tampered);
  }, 60_000);

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
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (String(args[1]).includes("当日交付清单.mhl"))
          throw Object.assign(new Error("simulated interruption"), {
            code: "EIO",
          });
        return originalLink(...args);
      });
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/simulated interruption/);
    link.mockRestore();
    expect(latest.status).toBe("failed");
    expect(latest.completedFiles).toBe(3);
    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    expect(resumed.manifestPaths).toHaveLength(2);
  });

  it("publishes generated artifacts when the destination does not support hardlinks", async () => {
    const { plan, run } = await preparedDeliveryRun();
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (String(args[1]).includes("Kocpy报告"))
          throw Object.assign(new Error("hardlinks unsupported"), {
            code: "EXDEV",
          });
        return originalLink(...args);
      });
    try {
      const completed = await executeDailyDeliveryRun(task, plan, run);
      expect(completed.status).toBe("completed");
      expect(completed.manifestPaths).toHaveLength(2);
      for (const manifest of completed.manifestPaths || [])
        expect((await fs.lstat(manifest)).nlink).toBe(1);
    } finally {
      link.mockRestore();
    }
  }, 60_000);

  it("publishes Media with the exclusive-copy fallback when hardlinks are denied", async () => {
    const { plan, run } = await preparedDeliveryRun(),
      originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (String(args[1]).includes(`${path.sep}Media${path.sep}`))
          throw Object.assign(new Error("hardlink permission denied"), {
            code: "EACCES",
          });
        return originalLink(...args);
      });
    try {
      const completed = await executeDailyDeliveryRun(task, plan, run);
      expect(completed.status).toBe("completed");
      for (const evidence of completed.files)
        expect(
          (
            await fs.lstat(
              path.join(completed.finalPath, "Media", evidence.relativePath),
            )
          ).nlink,
        ).toBe(1);
    } finally {
      link.mockRestore();
    }
  }, 60_000);

  it("recovers a generated artifact linked before temporary cleanup", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run,
      interrupted = false;
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        const result = await originalLink(...args);
        if (!interrupted && String(args[1]).includes("当日交付清单.mhl")) {
          interrupted = true;
          throw Object.assign(new Error("crash after manifest link"), {
            code: "EIO",
          });
        }
        return result;
      });
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/crash after manifest link/);
    link.mockRestore();
    const reportDirectory = path.join(run.finalPath, "Kocpy报告"),
      mhlName = (await fs.readdir(reportDirectory)).find((name) =>
        name.endsWith("当日交付清单.mhl"),
      )!,
      mhlPath = path.join(reportDirectory, mhlName),
      temporary = `${mhlPath}.kocpy-publish-partial`;
    expect((await fs.lstat(mhlPath)).nlink).toBe(2);
    expect((await fs.lstat(temporary)).nlink).toBe(2);

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    expect((await fs.lstat(mhlPath)).nlink).toBe(1);
    await expect(fs.access(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("preserves an interrupted fallback output before retrying publication", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run,
      interrupted = false;
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (!interrupted && String(args[1]).includes("当日交付清单.mhl")) {
          interrupted = true;
          throw Object.assign(new Error("fallback copy interrupted"), {
            code: "EIO",
          });
        }
        return originalLink(...args);
      });
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/fallback copy interrupted/);
    link.mockRestore();
    const reportDirectory = path.join(run.finalPath, "Kocpy报告"),
      temporaryName = (await fs.readdir(reportDirectory)).find((name) =>
        name.endsWith("当日交付清单.mhl.kocpy-publish-partial"),
      )!,
      mhlPath = path.join(
        reportDirectory,
        temporaryName.replace(/\.kocpy-publish-partial$/, ""),
      );
    await fs.writeFile(mhlPath, "partial fallback bytes");

    const resumed = await executeDailyDeliveryRun(task, plan, latest);
    expect(resumed.status).toBe("completed");
    const recoveryDirectory = (await fs.readdir(reportDirectory)).find((name) =>
      name.startsWith(`${path.basename(mhlPath)}.recovery-`),
    )!;
    expect(
      await fs.readFile(
        path.join(reportDirectory, recoveryDirectory, path.basename(mhlPath)),
        "utf8",
      ),
    ).toBe("partial fallback bytes");
  }, 60_000);

  it("refuses to accept an idempotent manifest with an added hardlink", async () => {
    const { plan, run } = await preparedDeliveryRun();
    let latest = run;
    const originalLink = fs.link.bind(fs),
      link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (String(args[1]).includes("当日交付清单.mhl"))
          throw Object.assign(new Error("simulated manifest interruption"), {
            code: "EIO",
          });
        return originalLink(...args);
      });
    await expect(
      executeDailyDeliveryRun(task, plan, run, async (checkpoint) => {
        latest = structuredClone(checkpoint);
      }),
    ).rejects.toThrow(/simulated manifest interruption/);
    link.mockRestore();
    const reportDirectory = path.join(run.finalPath, "Kocpy报告"),
      jsonName = (await fs.readdir(reportDirectory)).find((name) =>
        name.endsWith("当日交付清单.json"),
      )!,
      jsonPath = path.join(reportDirectory, jsonName),
      outsideLink = path.join(root, "manifest-hardlink.json");
    await fs.link(jsonPath, outsideLink);

    await expect(executeDailyDeliveryRun(task, plan, latest)).rejects.toThrow(
      /额外硬链接|不是安全的普通文件/,
    );
    expect((await fs.lstat(jsonPath)).nlink).toBe(2);
  }, 60_000);

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

  it("reauthorizes a legitimate recorded report before accepting its digest", async () => {
    const completed = await completedDeliveryRun(),
      reportPath = await authorizeDailyDeliveryArtifact(
        completed,
        dailyDeliveryReportFileName(completed),
      );
    await fs.writeFile(reportPath, "stable daily delivery report");
    const digest = await hashFile(reportPath, "sha256");
    completed.reportStatus = "completed";
    completed.reportPaths = [reportPath];
    completed.reportSha256 = { [reportPath]: digest };

    await expect(
      reauthorizeRecordedDailyDeliveryReport(completed),
    ).resolves.toEqual({
      authorizedPath: reportPath,
      recordedDigest: digest,
      actualDigest: digest,
    });
  });

  it("rereads a newly published report and rejects post-publication corruption", async () => {
    const completed = await completedDeliveryRun(),
      reportPath = await authorizeDailyDeliveryArtifact(
        completed,
        dailyDeliveryReportFileName(completed),
      ),
      reportBytes = Buffer.from("published report bytes"),
      digest = createHash("sha256").update(reportBytes).digest("hex");
    await expect(
      publishDailyDeliveryReport(
        completed,
        reportPath,
        reportBytes,
        digest,
      ),
    ).resolves.toEqual({
      authorizedPath: reportPath,
      actualSha256: digest,
    });
    expect((await fs.lstat(reportPath)).nlink).toBe(1);
    await fs.writeFile(reportPath, "truncated");
    await expect(
      verifyPublishedDailyDeliveryReport(completed, reportPath, digest),
    ).rejects.toThrow(/回读摘要不一致/);
  });

  it("rejects a recorded report path outside the fixed delivery report location", async () => {
    const completed = await completedDeliveryRun(),
      escaped = path.join(root, "unrelated-report.pdf");
    await fs.writeFile(escaped, "do not trust this file");
    completed.reportStatus = "completed";
    completed.reportPaths = [escaped];
    completed.reportSha256 = {
      [escaped]: await hashFile(escaped, "sha256"),
    };

    await expect(
      reauthorizeRecordedDailyDeliveryReport(completed),
    ).rejects.toThrow(/不再属于该交付任务/);
  });

  it("rejects a recorded report target replaced by a symlink before hashing", async () => {
    const completed = await completedDeliveryRun(),
      reportPath = await authorizeDailyDeliveryArtifact(
        completed,
        dailyDeliveryReportFileName(completed),
      ),
      outside = path.join(root, "outside-report.pdf");
    await fs.writeFile(outside, "outside report");
    await fs.symlink(outside, reportPath);
    completed.reportStatus = "completed";
    completed.reportPaths = [reportPath];
    completed.reportSha256 = {
      [reportPath]: await hashFile(outside, "sha256"),
    };

    await expect(
      reauthorizeRecordedDailyDeliveryReport(completed),
    ).rejects.toThrow(/符号链接|不是安全的普通文件/);
  });

  it("rejects a recorded report with an added hardlink", async () => {
    const completed = await completedDeliveryRun(),
      reportPath = await authorizeDailyDeliveryArtifact(
        completed,
        dailyDeliveryReportFileName(completed),
      ),
      outsideLink = path.join(root, "outside-report-hardlink.pdf");
    await fs.writeFile(reportPath, "stable daily delivery report");
    await fs.link(reportPath, outsideLink);
    completed.reportStatus = "completed";
    completed.reportPaths = [reportPath];
    completed.reportSha256 = {
      [reportPath]: await hashFile(reportPath, "sha256"),
    };

    await expect(
      reauthorizeRecordedDailyDeliveryReport(completed),
    ).rejects.toThrow(/普通文件|硬链接/);
    expect((await fs.lstat(outsideLink)).nlink).toBe(2);
  }, 60_000);

  it("rejects a recorded report when the destination volume identity changed", async () => {
    const completed = await completedDeliveryRun(),
      reportPath = await authorizeDailyDeliveryArtifact(
        completed,
        dailyDeliveryReportFileName(completed),
      );
    await fs.writeFile(reportPath, "stable daily delivery report");
    completed.reportStatus = "completed";
    completed.reportPaths = [reportPath];
    completed.reportSha256 = {
      [reportPath]: await hashFile(reportPath, "sha256"),
    };
    if (completed.destinationVolumeUuid)
      completed.destinationVolumeUuid = "00000000-0000-0000-0000-000000000000";
    else completed.destinationVolumeId = "definitely-another-volume";

    await expect(
      reauthorizeRecordedDailyDeliveryReport(completed),
    ).rejects.toThrow(/磁盘身份/);
  });
});
