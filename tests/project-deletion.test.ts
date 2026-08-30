import { describe, expect, it } from "vitest";
import { buildProjectDeletionPreview } from "../src/main/project-deletion";
import type {
  ArchiveChangeRecord,
  ArchiveHealthRecord,
  ArchiveReminder,
  BackupTask,
  ProjectConfig,
  ProxyJob,
} from "../src/main/types";

const project: ProjectConfig = {
  id: "test-project",
  name: "流程测试",
  status: "active",
  devices: ["A Cam"],
  volumePrefix: "A_",
};
const task = (id: string, status: BackupTask["status"]): BackupTask =>
  ({
    id,
    projectId: project.id,
    name: id,
    sourcePath: "/Volumes/CARD",
    devices: ["A Cam"],
    destinations: [],
    hashAlgorithm: "sha256",
    namingTemplate: id,
    status,
    totalFiles: 0,
    completedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    speedBps: 0,
    eta: 0,
    currentFile: "",
    verifyLog: [],
    fileRecords: [],
  }) as BackupTask;

describe("0.1.16 protected project deletion", () => {
  it("allows an active test project when all related work is terminal", () => {
    const preview = buildProjectDeletionPreview(
      project,
      [task("completed", "completed"), task("failed", "failed")],
      [
        {
          id: "proxy",
          sourceTaskId: "completed",
          status: "completed",
        } as ProxyJob,
      ],
      [{ projectId: project.id } as ArchiveHealthRecord],
      [{ projectId: project.id } as ArchiveChangeRecord],
      [{ projectId: project.id } as ArchiveReminder],
    );
    expect(preview).toMatchObject({
      status: "active",
      taskCount: 2,
      proxyJobCount: 1,
      healthRecordCount: 1,
      archiveChangeCount: 1,
      reminderCount: 1,
      blockingTasks: 0,
      blockingProxyJobs: 0,
      canDelete: true,
    });
  });

  it("blocks active backup and proxy work without counting unrelated records", () => {
    const preview = buildProjectDeletionPreview(
      project,
      [
        task("running", "running"),
        { ...task("other", "completed"), projectId: "another-project" },
      ],
      [
        {
          id: "active-proxy",
          sourceTaskId: "running",
          status: "paused",
        } as ProxyJob,
        {
          id: "unrelated-proxy",
          sourceTaskId: "other",
          status: "running",
        } as ProxyJob,
      ],
      [],
      [],
      [],
    );
    expect(preview).toMatchObject({
      taskCount: 1,
      proxyJobCount: 1,
      blockingTasks: 1,
      blockingProxyJobs: 1,
      canDelete: false,
    });
  });
});
