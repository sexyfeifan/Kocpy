import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimTimestampedVolume,
  compactDate,
  createProjectDateFolders,
  createProjectStructure,
  expectedProjectPaths,
  formatVolumeTimestamp,
  inspectProjectStructure,
  makeProjectDatePath,
  makeProjectDayPath,
  makeProjectFolderName,
  projectShootingDates,
  renderProjectCardPath,
} from "../src/main/project-path";
import { compareVersions, selectMacAsset } from "../src/main/update";
import { generateProjectReport } from "../src/main/backup/ReportGenerator";

describe("project backup workflow", () => {
  it("exports a complete project matrix and file detail report", async () => {
    const project = {
      id: "report",
      name: "山海之间",
      devices: ["FX3", "MAVIC"],
      volumePrefix: "FX3_",
      shootingDateStart: "2026-08-27",
      shootingDateEnd: "2026-08-28",
      destinationPaths: ["/Volumes/MASTER"],
    };
    const task = new BackupEngine().createTask({
      projectId: project.id,
      projectName: project.name,
      projectStartDate: project.shootingDateStart,
      name: "FX3_202608271200",
      namingTemplate: "FX3_202608271200",
      sourcePath: "/Volumes/CARD",
      destinationPaths: project.destinationPaths,
      devices: ["FX3"],
      shootingDate: "2026-08-27",
      hashAlgorithm: "sha256",
    });
    Object.assign(task, {
      status: "completed",
      totalFiles: 1,
      totalBytes: 4096,
      completedFiles: 1,
      fileRecords: [
        {
          name: "A001.mov",
          relativePath: "DCIM/A001.mov",
          size: 4096,
          srcChecksum: "abc",
          destinations: [
            {
              path: "/Volumes/MASTER/A001.mov",
              checksum: "abc",
              verified: true,
            },
          ],
        },
      ],
    });
    task.destinations[0].verified = true;
    const html = (await generateProjectReport(project, [task])).toString();
    expect(html).toContain("日期 × 设备素材完成情况");
    expect(html).toContain("2026-08-28");
    expect(html).toContain("MAVIC");
    expect(html).toContain("DCIM/A001.mov");
    expect(html).toContain("4 KB");
  });
  it("builds the project/start-day/device/card hierarchy", () => {
    const folder = makeProjectFolderName("2026-08-27", "山海之间");
    expect(folder).toBe("20260827_山海之间");
    expect(makeProjectDayPath(folder, "2026-08-29", "FX3")).toBe(
      "20260827_山海之间/20260829/FX3",
    );
    expect(makeProjectDayPath(folder, "2026-08-29", "FX3", "A")).toBe(
      "20260827_山海之间/20260829/FX3/A",
    );
    expect(makeProjectDatePath(folder, "2026-08-29")).toBe(
      "20260827_山海之间/20260829",
    );
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
    const positioned = new BackupEngine().createTask({
      projectId: "project-1",
      projectName: "山海之间",
      projectStartDate: "2026-08-27",
      projectFolderName: folder,
      name: "FX3_202608291430",
      namingTemplate: "FX3_202608291430",
      sourcePath: "/Volumes/CARD",
      destinationPaths: ["/Volumes/MASTER"],
      devices: ["FX3"],
      cameraPosition: "A",
      shootingDate: "2026-08-29",
      hashAlgorithm: "sha256",
    });
    expect(positioned.shootingDateFolder).toBe(
      "20260827_山海之间/20260829/FX3/A",
    );
  });
  it("applies a safe custom project naming rule", () => {
    expect(
      renderProjectCardPath(
        "{date}_{project}/{device}/{shootingDate}/{position}/{card}",
        {
          projectFolderName: "ignored",
          projectName: "山海之间",
          projectStartDate: "2026-08-27",
          shootingDate: "2026-08-29",
          device: "FX3",
          position: "A",
          card: "FX3_001",
        },
      ),
    ).toBe("20260827_山海之间/FX3/20260829/A/FX3_001");
    expect(() =>
      renderProjectCardPath("../{unknown}/{card}", {
        projectFolderName: "ignored",
        projectName: "P",
        projectStartDate: "2026-08-27",
        shootingDate: "2026-08-29",
        device: "FX3",
        card: "001",
      }),
    ).toThrow("未知变量");
  });

  it("pre-creates the project and start-date folders in every backup root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-project-"));
    const destinations = [path.join(root, "MASTER"), path.join(root, "BACKUP")];
    try {
      const created = await createProjectDateFolders(
        destinations,
        "20260827_山海之间",
        "2026-08-27",
      );
      expect(created).toEqual(
        destinations.map((destination) =>
          path.join(destination, "20260827_山海之间", "20260827"),
        ),
      );
      await Promise.all(
        created.map(async (folder) =>
          expect((await fs.stat(folder)).isDirectory()).toBe(true),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("creates and inspects the complete date, device and camera-position structure", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-project-full-"),
    );
    const destination = path.join(root, "MASTER");
    await fs.mkdir(destination);
    const project = {
      id: "full",
      name: "山海之间",
      devices: ["FX3", "MAVIC"],
      volumePrefix: "FX3_",
      shootingDateStart: "2026-08-27",
      shootingDateEnd: "2026-08-28",
      projectFolderName: "20260827_山海之间",
      devicePositions: { FX3: ["A", "B"] },
      destinationPaths: [destination],
    };
    try {
      expect(
        projectShootingDates(
          project.shootingDateStart,
          project.shootingDateEnd,
        ),
      ).toEqual(["2026-08-27", "2026-08-28"]);
      expect(expectedProjectPaths(project)).toHaveLength(6);
      const before = await inspectProjectStructure(project);
      expect(before.missingCount).toBe(6);
      await createProjectStructure(project);
      const complete = await inspectProjectStructure(project);
      expect(complete.missingCount).toBe(0);
      await fs.rm(
        path.join(destination, "20260827_山海之间", "20260828", "FX3", "B"),
        { recursive: true },
      );
      const damaged = await inspectProjectStructure(project);
      expect(damaged.missingCount).toBe(1);
      expect(damaged.destinations[0].missing[0]).toContain("20260828/FX3/B");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("formats local minute timestamps and keeps same-minute volume names unique", () => {
    const timestamp = formatVolumeTimestamp(new Date(2026, 6, 28, 21, 23));
    expect(timestamp).toBe("202607282123");
    expect(claimTimestampedVolume("Untitled_", timestamp)).toEqual({
      label: "Untitled_202607282123",
      collision: 0,
    });
    expect(
      claimTimestampedVolume("Untitled_", timestamp, timestamp, 0),
    ).toEqual({ label: "Untitled_202607282123_02", collision: 1 });
  });

  it("rejects invalid project dates", () => {
    expect(() => compactDate("2026/8/7")).toThrow("项目拍摄日期无效");
  });

  it("rejects unsafe camera position paths", () => {
    expect(() =>
      new BackupEngine().createTask({
        name: "invalid-position",
        namingTemplate: "invalid-position",
        sourcePath: "/Volumes/CARD",
        destinationPaths: ["/Volumes/MASTER"],
        devices: ["FX3"],
        shootingDate: "2026-08-27",
        projectId: "project-1",
        cameraPosition: "../F",
        hashAlgorithm: "sha256",
      }),
    ).toThrow("机位名称不能含路径分隔符");
  });
});

describe("GitHub update selection", () => {
  const release = {
    tag_name: "v0.0.7",
    html_url: "https://github.com/sexyfeifan/Kocpy/releases/tag/v0.0.7",
    assets: [
      {
        name: "Kocpy-0.0.7-arm64.dmg",
        browser_download_url:
          "https://github.com/sexyfeifan/Kocpy/releases/download/v0.0.7/Kocpy-0.0.7-arm64.dmg",
      },
      {
        name: "Kocpy-0.0.7-x64.dmg",
        browser_download_url:
          "https://github.com/sexyfeifan/Kocpy/releases/download/v0.0.7/Kocpy-0.0.7-x64.dmg",
      },
    ],
  };

  it("compares semantic numeric versions", () => {
    expect(compareVersions("0.0.7", "0.0.5")).toBe(1);
    expect(compareVersions("v0.0.7", "0.0.7")).toBe(0);
    expect(compareVersions("0.0.5", "0.0.7")).toBe(-1);
  });

  it("returns the package matching the running Mac architecture", () => {
    expect(selectMacAsset(release, "arm64").assetName).toBe(
      "Kocpy-0.0.7-arm64.dmg",
    );
    expect(selectMacAsset(release, "x64").downloadUrl).toContain(
      "Kocpy-0.0.7-x64.dmg",
    );
  });
});
