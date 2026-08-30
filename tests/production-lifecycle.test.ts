import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  builtInProductionTemplates,
  importExistingBackup,
  inspectExternalManifest,
  previewExistingBackup,
  projectCoverage,
  repairMissingManifestFiles,
  reviseMhlMissingEntries,
} from "../src/main/production-lifecycle";
import { generateMhl } from "../src/main/backup/ManifestGenerator";
const project: any = {
  id: "p",
  name: "Film",
  devices: ["FX3"],
  volumePrefix: "A_",
  requiredCopies: 2,
  expectedVolumes: 4,
  managedSince: "2026-08-01",
};
describe("0.1.0 production lifecycle", () => {
  it("recognizes project, day, device, position and timestamp card folders", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-structure-"));
    const configuredProject = {
      ...project,
      projectFolderName: "20260801_Film",
      devices: ["FX3", "FX6"],
      devicePositions: { FX3: ["A", "B"] },
    };
    const projectRoot = path.join(root, configuredProject.projectFolderName);
    const cards = [
      ["20260801", "FX3", "A", "FX3_202608011005"],
      ["20260801", "FX3", "A", "FX3_202608011130"],
      ["20260801", "FX3", "B", "FX3_202608011210"],
      ["20260801", "FX6", "FX6_202608011300"],
      ["20260801", "音频", "2"],
      ["2026-08-02", "FX3", "A", "FX3_202608021000"],
    ];
    try {
      for (const segments of cards) {
        const cardRoot = path.join(projectRoot, ...segments);
        await fs.mkdir(path.join(cardRoot, "PRIVATE", "M4ROOT", "CLIP"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(cardRoot, "PRIVATE", "M4ROOT", "CLIP", "clip.mov"),
          segments.join("-"),
        );
      }
      await fs.mkdir(path.join(projectRoot, "20260231", "FX3", "BAD"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(projectRoot, "20260231", "FX3", "BAD", "clip.mov"),
        "invalid-date",
      );

      const wholeProject = await previewExistingBackup(root, configuredProject);
      expect(wholeProject.detectedStructure).toBe("project");
      expect(wholeProject.candidates).toHaveLength(6);
      expect(wholeProject.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shootingDate: "2026-08-01",
            device: "FX3",
            cameraPosition: "A",
            card: "FX3_202608011005",
          }),
          expect.objectContaining({
            shootingDate: "2026-08-01",
            device: "FX6",
            cameraPosition: undefined,
            card: "FX6_202608011300",
          }),
          expect.objectContaining({
            shootingDate: "2026-08-01",
            device: "音频",
            cameraPosition: undefined,
            card: "2",
          }),
        ]),
      );
      expect(wholeProject.warnings).toContain("发现项目配置外的设备：音频");

      const day = await previewExistingBackup(
        path.join(projectRoot, "20260801"),
        configuredProject,
      );
      expect(day.detectedStructure).toBe("day");
      expect(day.candidates).toHaveLength(5);

      const imported = await importExistingBackup(
        configuredProject,
        path.join(projectRoot, ...cards[0]),
        "external-baseline",
      );
      expect(imported).toMatchObject({
        shootingDate: "2026-08-01",
        devices: ["FX3"],
        cameraPosition: "A",
        name: "FX3_202608011005",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the project's custom folder rule when adopting media", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-rule-"));
    const configuredProject = {
      ...project,
      devicePositions: { FX3: ["A", "B"] },
      namingRule: "{date}_{project}/{device}/{shootingDate}/{position}/{card}",
    };
    try {
      await fs.mkdir(
        path.join(root, "FX3", "20260803", "B", "FX3_202608031230"),
        { recursive: true },
      );
      await fs.writeFile(
        path.join(root, "FX3", "20260803", "B", "FX3_202608031230", "clip.mov"),
        "media",
      );
      const preview = await previewExistingBackup(root, configuredProject);
      expect(preview.candidates).toMatchObject([
        {
          shootingDate: "2026-08-03",
          device: "FX3",
          cameraPosition: "B",
          card: "FX3_202608031230",
        },
      ]);
      const cardPreview = await previewExistingBackup(
        path.join(root, "FX3", "20260803", "B", "FX3_202608031230"),
        configuredProject,
      );
      expect(cardPreview.candidates).toMatchObject([
        {
          shootingDate: "2026-08-03",
          device: "FX3",
          cameraPosition: "B",
          card: "FX3_202608031230",
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes and safely baselines an existing backup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-import-"));
    try {
      await fs.mkdir(path.join(root, "20260801", "FX3_A", "CARD01"), {
        recursive: true,
      });
      await fs.mkdir(path.join(root, "20260801", "FX3_B", "CARD02"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, "20260801", "FX3_A", "CARD01", "clip.mov"),
        "media",
      );
      await fs.writeFile(
        path.join(root, "20260801", "FX3_B", "CARD02", "clip.mov"),
        "media2",
      );
      const preview = await previewExistingBackup(root);
      expect(preview.files).toBe(2);
      expect(preview.candidates).toHaveLength(2);
      expect(
        preview.candidates.every((item) => item.shootingDate === "2026-08-01"),
      ).toBe(true);
      const task = await importExistingBackup(
        project,
        path.join(root, "20260801", "FX3_A", "CARD01"),
        "external-baseline",
      );
      expect(task.provenance).toBe("external-baseline");
      expect(task.confidence).toBe("baseline");
      expect(task.status).toBe("completed");
      expect(task.mediaBreakdown?.video).toEqual({ files: 1, bytes: 5 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("reports coverage without pretending unknown history is complete", () => {
    const coverage = projectCoverage(project, [
      {
        projectId: "p",
        provenance: "external-baseline",
        destinations: [{ verified: true, path: "a" }],
      } as any,
    ]);
    expect(coverage.recorded).toBe(1);
    expect(coverage.compliant).toBe(0);
    expect(coverage.coveragePercent).toBe(25);
  });
  it("ships five production templates", () =>
    expect(builtInProductionTemplates()).toHaveLength(5));
  it("imports Kocpy legacy MHL files that use file elements", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-import-"));
    try {
      await fs.writeFile(path.join(root, "clip.mov"), "verified media");
      const source: any = {
        id: "source",
        name: "CARD01",
        sourcePath: root,
        devices: [],
        destinations: [],
        hashAlgorithm: "sha256",
        namingTemplate: "CARD01",
        status: "completed",
        totalFiles: 1,
        completedFiles: 1,
        totalBytes: 14,
        transferredBytes: 14,
        speedBps: 0,
        eta: 0,
        currentFile: "",
        verifyLog: [],
        fileRecords: [
          {
            name: "clip.mov",
            relativePath: "clip.mov",
            size: 14,
            srcChecksum:
              "c72e699827ff7920e04d95d3e18a88a6495efa172f45864f6cfaaee1b484447b",
            destinations: [],
          },
        ],
      };
      await fs.writeFile(path.join(root, "CARD01.mhl"), generateMhl(source));
      const imported = await importExistingBackup(
        project,
        root,
        "manifest-import",
      );
      expect(imported.status).toBe("completed");
      expect(imported.fileRecords[0].destinations[0].verified).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects duplicate or traversal paths in untrusted external manifests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-bad-manifest-"));
    try {
      await fs.writeFile(path.join(root, "clip.mov"), "media");
      await fs.writeFile(
        path.join(root, "CARD.mhl"),
        `<?xml version="1.0"?><mhl><hashlist>
<hash><file>clip.mov</file><sha256>${"a".repeat(64)}</sha256></hash>
<hash><file>clip.mov</file><sha256>${"a".repeat(64)}</sha256></hash>
</hashlist></mhl>`,
      );
      await expect(inspectExternalManifest(root)).rejects.toThrow(/重复路径/);
      await fs.writeFile(
        path.join(root, "CARD.mhl"),
        `<?xml version="1.0"?><mhl><hashlist><hash><file>../escape.mov</file><sha256>${"a".repeat(64)}</sha256></hash></hashlist></mhl>`,
      );
      await expect(inspectExternalManifest(root)).rejects.toThrow(/越界/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("imports Kocard MHL files with leading paths and decimal xxHash32", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-kocard-mhl-"));
    try {
      await fs.mkdir(path.join(root, "DCIM"), { recursive: true });
      await fs.writeFile(path.join(root, "DCIM", "clip.mov"), "abc");
      await fs.writeFile(
        path.join(root, "CARD.mhl"),
        `<hashlist version="1.1"><hash><file>/DCIM/clip.mov</file><size>3</size><xxhash>852579327</xxhash></hash></hashlist>`,
      );
      const imported = await importExistingBackup(
        project,
        root,
        "manifest-import",
      );
      expect(imported).toMatchObject({
        status: "completed",
        confidence: "verified",
        hashAlgorithm: "xxhash32",
        externalManifest: {
          algorithm: "xxhash32",
          status: "verified",
          entries: 1,
          matched: 1,
        },
      });
      expect(imported.totalFiles).toBe(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports real missing and extra files from external manifest metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-diff-"));
    try {
      await fs.writeFile(path.join(root, "extra.mov"), "extra");
      await fs.writeFile(
        path.join(root, "CARD.mhl"),
        `<hashlist version="1.1"><hash><file>/missing.mov</file><size>7</size><xxhash>1</xxhash></hash></hashlist>`,
      );
      const comparison = await inspectExternalManifest(root);
      expect(comparison).toMatchObject({
        status: "mismatch",
        entries: 1,
        matched: 0,
        missing: ["missing.mov"],
        extra: ["extra.mov"],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("explains a numbered-name collision without treating files as equivalent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-collision-"));
    try {
      await fs.mkdir(path.join(root, "DCIM", "DJI_001"), { recursive: true });
      await fs.writeFile(
        path.join(root, "DCIM", "DJI_001", "DJI_CLIP_D.LRF"),
        "",
      );
      await fs.writeFile(
        path.join(root, "CARD.mhl"),
        `<hashlist version="1.1"><hash><file>/DCIM/DJI_001/DJI_CLIP_D(1).LRF</file><size>83918050</size><xxhash>1539034001</xxhash></hash></hashlist>`,
      );
      const comparison = await inspectExternalManifest(root);
      expect(comparison).toMatchObject({
        missing: ["DCIM/DJI_001/DJI_CLIP_D(1).LRF"],
        extra: ["DCIM/DJI_001/DJI_CLIP_D.LRF"],
        pathCollisionHints: [
          {
            missingPath: "DCIM/DJI_001/DJI_CLIP_D(1).LRF",
            extraPath: "DCIM/DJI_001/DJI_CLIP_D.LRF",
            expectedSize: 83918050,
            actualSize: 0,
          },
        ],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("audits the original MHL before excluding intentionally removed files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-revision-")),
      media = path.join(root, "media"),
      audit = path.join(media, ".kocpy-manifest-history");
    try {
      await fs.mkdir(media, { recursive: true });
      await fs.writeFile(path.join(media, "kept.mov"), "abc");
      const manifest = path.join(media, "CARD.mhl"),
        original = `<hashlist version="1.1">
<hash><file>/kept.mov</file><size>3</size><xxhash>852579327</xxhash></hash>
<hash><file>/removed.mov</file><size>7</size><xxhash>1</xxhash></hash>
</hashlist>`;
      await fs.writeFile(manifest, original);
      expect(await inspectExternalManifest(media)).toMatchObject({
        status: "mismatch",
        missing: ["removed.mov"],
      });
      const result = await reviseMhlMissingEntries(
        manifest,
        ["removed.mov"],
        audit,
      );
      expect(result.excluded).toEqual(["removed.mov"]);
      expect(await fs.readFile(result.auditPath, "utf8")).toBe(original);
      expect(await fs.readFile(manifest, "utf8")).not.toContain("removed.mov");
      expect(await inspectExternalManifest(media)).toMatchObject({
        status: "structure-match",
        entries: 1,
        matched: 1,
        missing: [],
      });
      const imported = await importExistingBackup(project, media, "manifest-import");
      expect(imported.externalManifest?.status).toBe("verified");
      expect(imported.status).toBe("completed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("does not revise an MHL when the requested exclusion is not recorded", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-revision-reject-"));
    try {
      const manifest = path.join(root, "CARD.mhl"),
        original = `<hashlist version="1.1"><hash><file>/kept.mov</file><size>3</size><xxhash>852579327</xxhash></hash></hashlist>`;
      await fs.writeFile(manifest, original);
      await expect(
        reviseMhlMissingEntries(manifest, ["other.mov"], path.join(root, "audit")),
      ).rejects.toThrow("找不到待排除记录");
      expect(await fs.readFile(manifest, "utf8")).toBe(original);
      await expect(fs.access(path.join(root, "audit"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("repairs only files that match the external manifest, then verifies the roll", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-repair-")),
      target = path.join(root, "target"),
      healthy = path.join(root, "healthy");
    try {
      await fs.mkdir(path.join(healthy, "DCIM"), { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(healthy, "DCIM", "clip.mov"), "abc");
      const manifest = path.join(target, "CARD.mhl");
      await fs.writeFile(
        manifest,
        `<hashlist version="1.1"><hash><file>/DCIM/clip.mov</file><size>3</size><xxhash>852579327</xxhash></hash></hashlist>`,
      );
      const repaired = await repairMissingManifestFiles(
        target,
        healthy,
        manifest,
        ["DCIM/clip.mov"],
      );
      expect(repaired).toMatchObject({ files: 1, bytes: 3, manifestRoot: "." });
      expect(await fs.readFile(path.join(target, "DCIM", "clip.mov"), "utf8")).toBe(
        "abc",
      );
      const imported = await importExistingBackup(project, target, "manifest-import");
      expect(imported.externalManifest?.status).toBe("verified");
      expect(imported.status).toBe("completed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("maps a reorganized healthy media subdirectory to one manifest subtree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-mapped-repair-")),
      target = path.join(root, "target"),
      healthy = path.join(root, "healthy"),
      mediaDirectory = path.join(healthy, "111", "100MSDCF");
    try {
      await fs.mkdir(mediaDirectory, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(mediaDirectory, "clip.mov"), "abc");
      const manifest = path.join(target, "CARD.mhl");
      await fs.writeFile(
        manifest,
        `<hashlist version="1.1"><hash><file>/DCIM/100MSDCF/clip.mov</file><size>3</size><xxhash>852579327</xxhash></hash></hashlist>`,
      );
      const repaired = await repairMissingManifestFiles(
        target,
        healthy,
        manifest,
        ["DCIM/100MSDCF/clip.mov"],
      );
      expect(repaired).toEqual({
        files: 1,
        bytes: 3,
        sourceRoot: await fs.realpath(mediaDirectory),
        manifestRoot: path.join("DCIM", "100MSDCF"),
      });
      expect(
        await fs.readFile(
          path.join(target, "DCIM", "100MSDCF", "clip.mov"),
          "utf8",
        ),
      ).toBe("abc");
      const imported = await importExistingBackup(project, target, "manifest-import");
      expect(imported.externalManifest?.status).toBe("verified");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("rejects ambiguous healthy-directory mappings before writing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-ambiguous-repair-")),
      target = path.join(root, "target"),
      healthy = path.join(root, "healthy");
    try {
      await fs.mkdir(path.join(healthy, "A", "100MSDCF"), { recursive: true });
      await fs.mkdir(path.join(healthy, "B", "100MSDCF"), { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(healthy, "A", "100MSDCF", "clip.mov"), "abc");
      await fs.writeFile(path.join(healthy, "B", "100MSDCF", "clip.mov"), "abc");
      const manifest = path.join(target, "CARD.mhl");
      await fs.writeFile(
        manifest,
        `<hashlist version="1.1"><hash><file>/DCIM/100MSDCF/clip.mov</file><size>3</size><xxhash>852579327</xxhash></hash></hashlist>`,
      );
      await expect(
        repairMissingManifestFiles(
          target,
          healthy,
          manifest,
          ["DCIM/100MSDCF/clip.mov"],
        ),
      ).rejects.toThrow("发现 2 套均可匹配的健康副本");
      await expect(
        fs.access(path.join(target, "DCIM", "100MSDCF", "clip.mov")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("does not write a repair when the selected copy fails manifest validation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-mhl-bad-repair-")),
      target = path.join(root, "target"),
      healthy = path.join(root, "healthy");
    try {
      await fs.mkdir(healthy, { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(healthy, "clip.mov"), "wrong");
      const manifest = path.join(target, "CARD.mhl");
      await fs.writeFile(
        manifest,
        `<hashlist version="1.1"><hash><file>clip.mov</file><size>5</size><xxhash>852579327</xxhash></hash></hashlist>`,
      );
      await expect(
        repairMissingManifestFiles(target, healthy, manifest, ["clip.mov"]),
      ).rejects.toThrow("健康副本校验值不符");
      await expect(fs.access(path.join(target, "clip.mov"))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("counts an audited extra-file acceptance as a trusted baseline", () => {
    const coverage = projectCoverage(project, [
      {
        projectId: "p",
        status: "completed",
        externalManifest: {
          status: "mismatch",
          resolution: {
            type: "accepted-extra",
            resolvedAt: Date.now(),
            note: "confirmed",
          },
        },
        destinations: [
          { verified: true, path: "/Volumes/A/card" },
          { verified: true, path: "/Volumes/B/card" },
        ],
      } as any,
    ]);
    expect(coverage.verified).toBe(1);
    expect(coverage.compliant).toBe(1);
    expect(coverage.attention).toBe(0);
  });
  it("keeps flat folders as one import candidate", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-flat-import-"));
    try {
      await fs.writeFile(path.join(root, "clip.mov"), "media");
      const preview = await previewExistingBackup(root);
      expect(preview.candidates).toMatchObject([
        { relativeRoot: ".", files: 1 },
      ]);
      const imported = await importExistingBackup(
        project,
        root,
        "unverified-import",
      );
      expect(imported).toMatchObject({
        status: "unverified",
        confidence: "unverified",
        devices: ["未分类设备"],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("reports byte and file progress while establishing an external baseline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-progress-"));
    let processedBytes = 0,
      completedFiles = 0;
    try {
      await fs.writeFile(path.join(root, "clip.mov"), "progress-media");
      const imported = await importExistingBackup(
        project,
        root,
        "external-baseline",
        {},
        {
          onBytes: (count) => (processedBytes += count),
          onFile: () => completedFiles++,
        },
      );
      expect(processedBytes).toBe(imported.totalBytes);
      expect(completedFiles).toBe(imported.totalFiles);
      expect(imported.status).toBe("completed");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("does not mistake a date-named folder inside a media card for a project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-card-date-"));
    try {
      await fs.mkdir(path.join(root, "PRIVATE", "20260803"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, "PRIVATE", "20260803", "clip.mov"),
        "media",
      );
      const preview = await previewExistingBackup(root, project);
      expect(preview.detectedStructure).toBe("card");
      expect(preview.candidates).toMatchObject([
        { relativeRoot: ".", files: 1 },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
