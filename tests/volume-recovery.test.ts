import { describe, expect, it, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVolumeIdentity,
  assertVolumeIdentity,
} from "../src/common/volume-identity";
import { recoveryAdvice } from "../src/common/recovery";
import * as system from "../src/main/system";
import { inspectTaskRecovery } from "../src/main/recovery";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { BackupTask } from "../src/main/types";

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});
async function fixture() {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-volume-recovery-"));
  const source = path.join(root, "源 数据"),
    target = path.join(root, "目标 数据");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "clip.bin"), Buffer.alloc(4096, 23));
  const engine = new BackupEngine();
  const task = engine.createTask({
    name: "identity regression",
    sourcePath: source,
    destinationPaths: [target],
    hashAlgorithm: "sha256",
    copyMode: "mirror",
    namingTemplate: "ignored",
    shootingDate: "",
    devices: [],
    generateThumbnails: false,
  });
  return { engine, task, source, target };
}
const identity = {
  id: "AA",
  uuid: "AA",
  device: "42",
  deviceNode: "/dev/disk9s1",
  name: "test",
  mountPoint: "/Volumes/test",
};

describe("disk identity and guided recovery", () => {
  it("parses mount points with spaces, APFS data and network filesystem labels", () => {
    expect(
      system.parseDfMount(
        "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk13s1 123 12 111 10% /Volumes/RAID Disk\n",
      ),
    ).toEqual({
      filesystem: "/dev/disk13s1",
      mountPoint: "/Volumes/RAID Disk",
    });
    expect(
      system.parseDfMount(
        "//user@nas/media files 123 12 111 10% /Volumes/media files",
      ).mountPoint,
    ).toBe("/Volumes/media files");
    expect(() => system.parseDfMount("query failed")).toThrow();
    expect(
      system.diskPlistField(
        "<key>VolumeName</key><string>A &amp; B</string>",
        "VolumeName",
      ),
    ).toBe("A & B");
  });
  it("unknown UUID is unavailable, different UUID remains blocked, legacy st_dev never overrides UUID", () => {
    expect(compareVolumeIdentity("aa", undefined, identity)).toBe("match");
    expect(
      compareVolumeIdentity("AA", undefined, { ...identity, uuid: undefined }),
    ).toBe("unavailable");
    expect(() =>
      assertVolumeIdentity(
        "AA",
        undefined,
        { ...identity, uuid: undefined },
        "目标",
      ),
    ).toThrow("不表示 UUID 已改变");
    expect(() => assertVolumeIdentity("OLD", "42", identity, "目标")).toThrow(
      "身份",
    );
    expect(compareVolumeIdentity(undefined, "42", identity)).toBe(
      "legacy-match",
    );
    expect(compareVolumeIdentity(undefined, "OTHER", identity)).toBe("changed");
  });
  it("uses the same real volume for nested paths and symlinks, and records UUIDs before a real mirror copy", async () => {
    const { engine, task, source, target } = await fixture();
    const a = await system.volumeIdentity(source),
      b = await system.volumeIdentity(target);
    await fs.symlink(source, path.join(root!, "source-alias"));
    expect(
      (await system.volumeIdentity(path.join(root!, "source-alias"))).id,
    ).toBe(a.id);
    expect(a.id).toBe(b.id);
    expect(a.name).toBe(b.name);
    if (process.platform === "darwin") expect(a.uuid).toBeTruthy();
    task.sourceVolumeUuid = a.uuid;
    task.sourceVolumeId = a.id;
    task.destinations[0].volumeUuid = b.uuid;
    task.destinations[0].volumeId = b.id;
    task.status = "failed";
    task.errorMessage = "目标磁盘 UUID 已变化，已停止操作";
    expect((await inspectTaskRecovery(task)).canRetry).toBe(true);
    const done = new Promise<BackupTask>((resolve) =>
      engine.once("settled", resolve),
    );
    engine.retryFailedDestinations(task.id);
    const completed = await done;
    expect(completed.status, completed.errorMessage).toBe("completed");
    expect(completed.destinations[0].verified).toBe(true);
    expect(
      (await system.volumeIdentity(completed.destinations[0].resolvedPath!)).id,
    ).toBe(b.id);
    completed.errorMessage = "旧的离线错误";
    completed.destinations[0].available = false;
    const reverified = await engine.reverifyTask(task.id);
    expect(reverified.status, reverified.errorMessage).toBe("completed");
    expect(reverified.errorMessage).toBeUndefined();
    expect(reverified.destinations[0].available).toBe(true);
  }, 30000);
  it("does not certify an empty or incomplete hash baseline", async () => {
    const { engine, task } = await fixture();
    await expect(engine.reverifyTask(task.id)).rejects.toThrow(
      "完整文件哈希基线",
    );
    expect(task.status).not.toBe("completed");
    task.totalFiles = 1;
    await expect(engine.reverifyTask(task.id)).rejects.toThrow(
      "完整文件哈希基线",
    );
  });
  it("read-only inspection permits original identities without modifying tasks or files", async () => {
    const { task, target } = await fixture();
    task.status = "failed";
    task.errorMessage = "演示目标盘 磁盘 UUID 已变化，已停止操作";
    vi.spyOn(system, "volumeIdentity").mockResolvedValue(identity);
    task.sourceVolumeUuid = "AA";
    task.destinations[0].volumeUuid = "AA";
    const before = JSON.stringify(task);
    const report = await inspectTaskRecovery(task);
    expect(report.canRetry).toBe(true);
    expect(report.checks.every((c) => !c.blocking)).toBe(true);
    expect(JSON.stringify(task)).toBe(before);
    expect(await fs.readdir(target)).toEqual([]);
  });
  it("checks existing final roots rather than silently trusting their parent", async () => {
    const { task, target } = await fixture();
    task.status = "failed";
    const finalRoot = path.join(target, "final-root");
    await fs.mkdir(finalRoot);
    task.destinations[0].resolvedPath = finalRoot;
    task.destinations[0].volumeUuid = "AA";
    vi.spyOn(system, "volumeIdentity").mockImplementation(async (location) =>
      location === finalRoot ? { ...identity, uuid: "OTHER" } : identity,
    );
    const report = await inspectTaskRecovery(task);
    expect(report.canRetry).toBe(false);
    expect(report.checks[1].path).toBe(finalRoot);
    expect(report.checks[1].status).toBe("changed");
    task.destinations[0].resolvedPath = path.join(target, "not-created-yet");
    expect((await inspectTaskRecovery(task)).canRetry).toBe(true);
  });
  it("blocks replaced or unqueryable disks, missing source, and external-import retries", async () => {
    const { task, source } = await fixture();
    task.status = "failed";
    const mock = vi.spyOn(system, "volumeIdentity").mockResolvedValue(identity);
    task.destinations[0].volumeUuid = "OLD";
    expect((await inspectTaskRecovery(task)).canRetry).toBe(false);
    task.destinations[0].volumeUuid = "AA";
    mock.mockRejectedValue(new Error("磁盘身份暂时无法读取"));
    const unavailable = await inspectTaskRecovery(task);
    expect(unavailable.canRetry).toBe(false);
    expect(unavailable.checks[0].status).toBe("unavailable");
    mock.mockResolvedValue(identity);
    task.provenance = "external-import" as BackupTask["provenance"];
    expect((await inspectTaskRecovery(task)).canRetry).toBe(false);
    task.provenance = "kocpy-transfer";
    await fs.rename(source, source + "-moved");
    expect((await inspectTaskRecovery(task)).canRetry).toBe(false);
  });
  it.each([
    "UUID 已变化",
    "ENOSPC",
    "EACCES",
    "ENOENT",
    "素材源已变化",
    "同名不同内容",
    "哈希不一致",
    "未知错误",
  ])("provides next steps for %s", (error) => {
    expect(recoveryAdvice(error).steps.length).toBeGreaterThanOrEqual(2);
  });
});
