import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { normalBackupFolder, previewBackupPath, sourceFolderName, capacityReadiness } from "../src/common/backup-layout";
import { selectLiveTask, transferPhaseText, transferTiming, transferProgressLabel } from "../src/renderer/src/task-state";
import type { BackupTask } from "../src/main/types";

describe("backup layout and live detail", () => {
  it("never marks missing, invalid or insufficient capacity as checked", () => {
    expect(capacityReadiness(["/a", "/b"], { "/a": 200 }, 100)).toEqual({ checked: 1, total: 2, ready: false });
    expect(capacityReadiness(["/a"], { "/a": NaN }, 100).ready).toBe(false);
    expect(capacityReadiness(["/a"], { "/a": Infinity }, 100).ready).toBe(false);
    expect(capacityReadiness(["/a"], { "/a": 99 }, 100).ready).toBe(false);
    expect(capacityReadiness([], {}, 100).ready).toBe(false);
    expect(capacityReadiness(["/a"], { "/a": 101 }, 100).ready).toBe(true);
  });
  it("hides stale ETA on stopped tasks and does not round unfinished phases to 100%", () => {
    const task = { status: "paused", eta: 800, verifyEta: 600, speedBps: 99, copyProgress: 99.9, verifyProgress: 99.99 } as BackupTask;
    expect(transferTiming(task)).toMatchObject({ speed: 0, seconds: 0, label: "已暂停" });
    expect(transferProgressLabel(task, "copy")).toBe("99.9%");
    expect(transferProgressLabel(task, "verify")).toBe("99.9%");
    expect(transferProgressLabel({ ...task, copyProgress: 100 }, "copy")).toBe("100%");
    expect(transferTiming({ ...task, status: "running", transferPhase: "scanning" })).toMatchObject({ seconds: 0, label: "预检中" });
    expect(transferTiming({ ...task, status: "verifying", verifySpeedBps: 200 })).toMatchObject({ seconds: 600, speed: 200, label: "本阶段预计剩余" });
    expect(transferTiming({ ...task, status: "failed", startedAt: 1000, completedAt: 7000 })).toMatchObject({ seconds: 6, speed: 0, label: "总用时" });
  });
  it("previews the source folder inside the selected destination parent", () => {
    expect(previewBackupPath("/Volumes/backup/project/", "/Volumes/card/20260825_project/", true)).toBe("/Volumes/backup/project/20260825_project");
    expect(sourceFolderName("/Volumes/CARD/")).toBe("CARD");
    expect(sourceFolderName("/Volumes/disk/素材 : 原名")).toBe("素材 : 原名");
    expect(() => sourceFolderName("/")).toThrow();
    expect(normalBackupFolder("/Volumes/card/素材", "20260831123456")).toBe("素材_20260831123456");
  });
  it("keeps the running bar on the same non-rounding progress formatter as the detail", () => {
    const app = readFileSync("src/renderer/src/App.tsx", "utf8");
    const bar = app.slice(app.indexOf('className="running-bar"'), app.indexOf('{existingImport &&'));
    expect(bar).toContain("transferProgressLabel(");
    expect(bar).not.toContain("Math.round(");
    expect(transferProgressLabel({ copyProgress: 64.9 }, "copy")).toBe("64%");
    expect(transferProgressLabel({ verifyProgress: 99.999 }, "verify")).toBe("99.9%");
  });
  it("uses live progress, status, speed and destinations while keeping fetched file records", () => {
    const records = [{ name: "clip.mov" }] as BackupTask["fileRecords"];
    const snapshot = { id: "one", status: "running", copyProgress: 1, speedBps: 10, lastCheckpointAt: 1, fileRecords: records } as BackupTask;
    const live = { ...snapshot, status: "paused", copyProgress: 40, speedBps: 0, lastCheckpointAt: 2, destinations: [{ id: "dest", path: "/dest", label: "dest", verified: false, bytesWritten: 40, copiedBytes: 40 }], fileRecords: [] } as BackupTask;
    const selected = selectLiveTask("one", [live], snapshot)!;
    expect(selected.status).toBe("paused");
    expect(selected.copyProgress).toBe(40);
    expect(selected.speedBps).toBe(0);
    expect(selected.destinations[0].copiedBytes).toBe(40);
    expect(selected.fileRecords).toBe(records);
    expect(transferPhaseText(selected)).toContain("已暂停");
    expect(selectLiveTask("two", [live], snapshot)).toBeUndefined();
    expect(selectLiveTask("one", [{ ...live, lastCheckpointAt: 0 }], snapshot)!.copyProgress).toBe(1);
  });
  it("uses one supported drop resolver for both folder entry points and labels scanned counts", () => {
    const composer = readFileSync("src/renderer/src/Composer.tsx", "utf8");
    const interaction = readFileSync("src/renderer/src/Interaction.tsx", "utf8");
    expect(composer).toContain('dropFolders(event, "source")');
    expect(composer).toContain('dropFolders(event, "destination")');
    expect(composer).not.toContain("File & { path?: string }");
    expect(composer).toContain("{files} 个文件");
    expect(composer).toContain("不是素材卷数量");
    expect(composer).toContain('<details className="backup-advanced">');
    expect(composer).toContain("存储关系待核对");
    expect(composer).not.toContain("个目的地已通过容量检查");
    expect(interaction).toContain("node.getClientRects().length > 0");
  });
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

it("resolves a native File through Electron webUtils, not the removed File.path", async () => {
  const { contextBridge, webUtils } = await import("electron");
  await import("../src/main/preload");
  const exposed = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0][1] as { resolveDroppedPaths(files: unknown[]): string[] };
  vi.mocked(webUtils.getPathForFile).mockReturnValueOnce("/native/folder").mockReturnValueOnce("");
  expect(exposed.resolveDroppedPaths([{ path: "/incorrect/legacy" }, {}])).toEqual(["/native/folder"]);
  expect(webUtils.getPathForFile).toHaveBeenCalledTimes(2);
});
