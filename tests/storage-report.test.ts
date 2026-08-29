import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Storage } from "../src/main/storage";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import {
  generateProjectReport,
  generateReport,
} from "../src/main/backup/ReportGenerator";
import {
  generateMhl,
  generateAscMhl,
} from "../src/main/backup/ManifestGenerator";
import { execFileSync } from "node:child_process";
import { isTimeMachineVolume } from "../src/main/system";
import {
  projectCellStatus,
  projectDeviceCells,
  verifiedPhysicalCopyCount,
} from "../src/main/project-closeout";
describe("Persistence and reports", () => {
  it("serializes concurrent writes and recovers the previous valid snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-store-"));
    try {
      const store = new Storage(dir);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.write("tasks.json", { value: i }),
        ),
      );
      expect(await store.read("tasks.json", {})).toEqual({ value: 19 });
      await fs.writeFile(path.join(dir, "tasks.json"), "{broken");
      expect(await store.read("tasks.json", {})).toEqual({ value: 18 });
      expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("escapes untrusted file names and labels a failed report honestly", async () => {
    const t = new BackupEngine().createTask({
      name: "name",
      namingTemplate: "name",
      sourcePath: "/tmp/source",
      destinationPaths: ["/tmp/dest"],
      devices: [],
      hashAlgorithm: "sha256",
      shootingDate: "",
    });
    t.status = "failed";
    t.name = "<script>alert(1)</script>";
    const html = (await generateReport(t)).toString();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("备份失败");
  });
  it("embeds the matching media thumbnail in the PDF report HTML", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-thumb-"));
    const thumbnail = path.join(dir, "clip.jpg");
    await fs.writeFile(thumbnail, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    try {
      const t = new BackupEngine().createTask({
        name: "thumb",
        namingTemplate: "thumb",
        sourcePath: "/tmp/source",
        destinationPaths: ["/tmp/dest"],
        devices: [],
        hashAlgorithm: "sha256",
        shootingDate: "",
      });
      t.fileRecords = [
        {
          name: "clip.mov",
          relativePath: "A/clip.mov",
          size: 42,
          srcChecksum: "abc",
          thumbnailPath: thumbnail,
          destinations: [
            { path: "/tmp/dest/clip.mov", checksum: "abc", verified: true },
          ],
        },
      ];
      const html = (
        await generateReport(t, { includeThumbnails: true })
      ).toString();
      expect(html).toContain("data:image/jpeg;base64,/9j/2Q==");
      expect(html).toContain("file-table with-thumbnails");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("excludes Time Machine snapshot and localized backup volume names", () => {
    expect(isTimeMachineVolume("com.apple.TimeMachine.localsnapshots")).toBe(
      true,
    );
    expect(isTimeMachineVolume(".timemachine")).toBe(true);
    expect(isTimeMachineVolume("周非凡的MacBook Pro的备份")).toBe(true);
    expect(isTimeMachineVolume("MEDIA_MASTER")).toBe(false);
    expect(
      isTimeMachineVolume("NAS", "", "//host/share on /Volumes/.timemachine"),
    ).toBe(true);
  });
  it("generates ASC MHL v2 that validates against the official ASC XSD", async () => {
    const t = new BackupEngine().createTask({
      name: "asc",
      namingTemplate: "asc",
      sourcePath: "/tmp/source",
      destinationPaths: ["/tmp/dest"],
      devices: [],
      hashAlgorithm: "sha256",
      shootingDate: "",
    });
    t.fileRecords = [
      {
        name: "clip.mov",
        relativePath: "A/clip.mov",
        size: 42,
        srcChecksum: "sha",
        ascMhlMd5: "d41d8cd98f00b204e9800998ecf8427e",
        destinations: [],
      },
    ];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ascmhl-test-")),
      manifest = path.join(dir, "0001_TEST.mhl");
    try {
      await fs.writeFile(manifest, generateAscMhl(t));
      execFileSync("/usr/bin/xmllint", [
        "--noout",
        "--schema",
        path.resolve("tests/ASCMHL.xsd"),
        manifest,
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("exports an escaped MHL inventory from recorded source hashes", () => {
    const t = new BackupEngine().createTask({
      name: "mhl",
      namingTemplate: "mhl",
      sourcePath: "/tmp/source",
      destinationPaths: ["/tmp/dest"],
      devices: [],
      hashAlgorithm: "sha256",
      shootingDate: "",
    });
    t.fileRecords = [
      {
        name: "a&b.mov",
        relativePath: "A/a&b.mov",
        size: 42,
        srcChecksum: "abc",
        destinations: [],
      },
    ];
    const mhl = generateMhl(t);
    expect(mhl).toContain('<mhl version="1.1">');
    expect(mhl).toContain("A/a&amp;b.mov");
    expect(mhl).toContain("<sha256>abc</sha256>");
  });
  it("applies project closeout copy requirements and schedule exceptions", async () => {
    const engine = new BackupEngine(),
      task = engine.createTask({
        name: "FX3_202608271200",
        namingTemplate: "name",
        sourcePath: "/tmp/source",
        destinationPaths: ["/tmp/a", "/tmp/b"],
        devices: ["FX3"],
        hashAlgorithm: "sha256",
        shootingDate: "2026-08-27",
      });
    task.status = "completed";
    task.totalFiles = 2;
    task.totalBytes = 100;
    task.destinations[0].verified = true;
    task.destinations[1].verified = false;
    const html = (
      await generateProjectReport(
        {
          id: "project-123456789",
          name: "测试项目",
          devices: ["FX3", "FX6"],
          volumePrefix: "CARD",
          shootingDateStart: "2026-08-27",
          shootingDateEnd: "2026-08-28",
          requiredCopies: 2,
          restDays: ["2026-08-28"],
          unusedDevicesByDate: { "2026-08-27": ["FX6"] },
        },
        [task],
      )
    ).toString();
    expect(html).toContain("0 / 1 达到 2 份物理独立副本");
    expect(html).toContain("当天未使用");
    expect(html).toContain("休息日");
    expect(html).toContain("每日素材趋势");
    expect(html).toContain("设备素材占比");
  });
  it("does not count two folders on one physical volume as independent copies", () => {
    const task = new BackupEngine().createTask({
      name: "same-disk",
      namingTemplate: "same-disk",
      sourcePath: "/tmp/source",
      destinationPaths: ["/Volumes/RAID/a", "/Volumes/RAID/b"],
      devices: ["FX3"],
      hashAlgorithm: "sha256",
      shootingDate: "2026-08-27",
    });
    task.status = "completed";
    for (const destination of task.destinations) {
      destination.verified = true;
      destination.volumeUuid = "same-volume";
    }
    expect(verifiedPhysicalCopyCount(task)).toBe(1);
    const cell = projectCellStatus(
      {
        id: "p",
        name: "p",
        devices: ["FX3"],
        volumePrefix: "CARD",
        requiredCopies: 2,
      },
      [task],
      "2026-08-27",
      "FX3",
    );
    expect(cell.complete).toBe(false);
    task.destinations[1].volumeUuid = "second-volume";
    expect(verifiedPhysicalCopyCount(task)).toBe(2);
  });
  it("keeps configured camera positions as separate closeout cells", () => {
    const task = new BackupEngine().createTask({
      name: "A-card",
      namingTemplate: "A-card",
      sourcePath: "/tmp/source",
      destinationPaths: ["/Volumes/A/a", "/Volumes/B/a"],
      devices: ["FX3"],
      hashAlgorithm: "sha256",
      shootingDate: "2026-08-27",
      cameraPosition: "A",
    });
    task.status = "completed";
    task.destinations.forEach((destination, index) => {
      destination.verified = true;
      destination.volumeUuid = `volume-${index}`;
    });
    const configuredProject = {
      id: "p",
      name: "p",
      devices: ["FX3"],
      devicePositions: { FX3: ["A", "B"] },
      volumePrefix: "CARD",
      requiredCopies: 2,
    };
    expect(projectDeviceCells(configuredProject, [task])).toMatchObject([
      { device: "FX3", cameraPosition: "A", scheduleKey: "FX3::A" },
      { device: "FX3", cameraPosition: "B", scheduleKey: "FX3::B" },
    ]);
    expect(
      projectCellStatus(configuredProject, [task], "2026-08-27", "FX3", "A")
        .complete,
    ).toBe(true);
    expect(
      projectCellStatus(configuredProject, [task], "2026-08-27", "FX3", "B")
        .complete,
    ).toBe(false);
  });
});
