import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { normalBackupFolder, previewBackupPath, sourceFolderName } from "../src/common/backup-layout";
import { selectLiveTask, transferPhaseText } from "../src/renderer/src/task-state";
import type { BackupTask } from "../src/main/types";

describe("backup layout and live detail", () => {
  it("previews the source folder inside the selected destination parent", () => {
    expect(previewBackupPath("/Volumes/backup/project/", "/Volumes/card/20260825_project/", true)).toBe("/Volumes/backup/project/20260825_project");
    expect(sourceFolderName("/Volumes/CARD/")).toBe("CARD");
    expect(sourceFolderName("/Volumes/disk/素材 : 原名")).toBe("素材 : 原名");
    expect(() => sourceFolderName("/")).toThrow();
    expect(normalBackupFolder("/Volumes/card/素材", "20260831123456")).toBe("素材_20260831123456");
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
    expect(composer).toContain('dropFolders(event, "source")');
    expect(composer).toContain('dropFolders(event, "destination")');
    expect(composer).not.toContain("File & { path?: string }");
    expect(composer).toContain("{files} 个文件");
    expect(composer).toContain("不是素材卷数量");
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
