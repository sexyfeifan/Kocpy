import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { claimTimestampedVolume, compactDate, formatVolumeTimestamp, makeProjectDayPath, makeProjectFolderName } from "../src/main/project-path";
import { compareVersions, selectMacAsset } from "../src/main/update";

describe("project backup workflow", () => {
  it("builds the project/start-day/device/card hierarchy", () => {
    const folder = makeProjectFolderName("2026-08-27", "山海之间");
    expect(folder).toBe("20260827_山海之间");
    expect(makeProjectDayPath(folder, "2026-08-29", "FX3")).toBe("20260827_山海之间/20260829/FX3");
    const task = new BackupEngine().createTask({
      projectId: "project-1",
      projectName: "山海之间",
      projectStartDate: "2026-08-27",
      projectFolderName: folder,
      name: "Untitled_202607282123",
      namingTemplate: "Untitled_202607282123",
      sourcePath: "/Volumes/CARD",
      destinationPaths: ["/Volumes/MASTER"],
      devices: ["FX3"],
      shootingDate: "2026-08-29",
      hashAlgorithm: "sha256",
    });
    expect(task.shootingDateFolder).toBe("20260827_山海之间/20260829/FX3");
    expect(task.namingTemplate).toBe("Untitled_202607282123");
  });

  it("formats local minute timestamps and keeps same-minute volume names unique", () => {
    const timestamp = formatVolumeTimestamp(new Date(2026, 6, 28, 21, 23));
    expect(timestamp).toBe("202607282123");
    expect(claimTimestampedVolume("Untitled_", timestamp)).toEqual({ label: "Untitled_202607282123", collision: 0 });
    expect(claimTimestampedVolume("Untitled_", timestamp, timestamp, 0)).toEqual({ label: "Untitled_202607282123_02", collision: 1 });
  });

  it("rejects invalid project dates", () => {
    expect(() => compactDate("2026/8/7")).toThrow("项目拍摄日期无效");
  });
});

describe("GitHub update selection", () => {
  const release = {
    tag_name: "v0.0.5",
    html_url: "https://github.com/sexyfeifan/Kocpy/releases/tag/v0.0.5",
    assets: [
      { name: "Kocpy-0.0.5-arm64.dmg", browser_download_url: "https://github.com/sexyfeifan/Kocpy/releases/download/v0.0.5/Kocpy-0.0.5-arm64.dmg" },
      { name: "Kocpy-0.0.5-x64.dmg", browser_download_url: "https://github.com/sexyfeifan/Kocpy/releases/download/v0.0.5/Kocpy-0.0.5-x64.dmg" },
    ],
  };

  it("compares semantic numeric versions", () => {
    expect(compareVersions("0.0.5", "0.0.4")).toBe(1);
    expect(compareVersions("v0.0.5", "0.0.5")).toBe(0);
    expect(compareVersions("0.0.4", "0.0.5")).toBe(-1);
  });

  it("returns the package matching the running Mac architecture", () => {
    expect(selectMacAsset(release, "arm64").assetName).toBe("Kocpy-0.0.5-arm64.dmg");
    expect(selectMacAsset(release, "x64").downloadUrl).toContain("Kocpy-0.0.5-x64.dmg");
  });
});
