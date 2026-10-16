import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { recordDailyPlanDecision } from "../src/main/project-evidence";
import { authorizeProjectTaskConfig } from "../src/main/project-task-authority";
import type { ProjectConfig, TaskConfig } from "../src/main/types";

const project = (): ProjectConfig => ({
  id: "project-authority",
  name: "权威项目",
  projectFolderName: "20261015_权威项目",
  shootingDateStart: "2026-10-15",
  shootingDateEnd: "2026-10-16",
  devices: ["FX3"],
  devicePositions: { FX3: ["A"] },
  volumePrefix: "FX3_",
  namingRule: "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
  destinationPaths: ["/Volumes/MASTER"],
});

const config = (overrides: Partial<TaskConfig> = {}): TaskConfig => ({
  projectId: "project-authority",
  projectName: "权威项目",
  projectStartDate: "2026-10-15",
  projectFolderName: "20261015_权威项目",
  projectNamingRule:
    "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
  name: "FX3_001",
  namingTemplate: "FX3_001",
  sourcePath: "/Volumes/CARD",
  destinationPaths: ["/Volumes/MASTER"],
  devices: ["FX3"],
  cameraPosition: "A",
  shootingDate: "20261015",
  hashAlgorithm: "sha256",
  ...overrides,
});

describe("new project task path authority", () => {
  it("canonicalizes a real shooting date and creates the reviewed authoritative path", () => {
    const authorized = authorizeProjectTaskConfig(project(), [], config());
    expect(authorized.shootingDate).toBe("2026-10-15");
    expect(config().shootingDate).toBe("20261015");
    const task = new BackupEngine().createTask(authorized);
    expect(task.shootingDateFolder).toBe(
      "20261015_权威项目/20261015/FX3/A",
    );
    expect(task.namingTemplate).toBe("FX3_001");
  });

  it("rejects stale path metadata before an engine task or destination is created", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "kocpy-project-authority-"),
    );
    const destination = path.join(root, "destination");
    let engineCreates = 0;
    try {
      expect(() => {
        const authorized = authorizeProjectTaskConfig(
          project(),
          [],
          config({ projectNamingRule: "旧规则/{card}" }),
        );
        engineCreates++;
        new BackupEngine().createTask(authorized);
      }).toThrow(
        "项目目录配置已变化，请重新选择项目并核对路径后再开始",
      );
      expect(engineCreates).toBe(0);
      await expect(fs.access(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["projectName", { projectName: "旧项目名" }],
    ["projectStartDate", { projectStartDate: "2026-10-14" }],
    ["projectFolderName", { projectFolderName: "20261014_旧目录" }],
    ["missing projectNamingRule", { projectNamingRule: undefined }],
  ])("rejects stale or missing %s", (_label, overrides) => {
    expect(() =>
      authorizeProjectTaskConfig(project(), [], config(overrides)),
    ).toThrow("项目目录配置已变化");
  });

  it("does not treat an absent renderer rule as equal to an authoritative absent rule", () => {
    const value = { ...project(), namingRule: undefined };
    const request = config({ projectNamingRule: undefined });
    delete request.projectNamingRule;
    expect(() => authorizeProjectTaskConfig(value, [], request)).toThrow(
      "项目目录配置已变化",
    );
    expect(
      authorizeProjectTaskConfig(
        value,
        [],
        config({ projectNamingRule: undefined }),
      ).projectNamingRule,
    ).toBeUndefined();
  });

  it.each(["2026-02-29", "2026-02-31", "not-a-day", ""])(
    "rejects non-calendar shooting date %s",
    (shootingDate) => {
      const historical = new BackupEngine().createTask(
        config({ shootingDate: "2026-10-15" }),
      );
      historical.shootingDate = shootingDate;
      expect(() =>
        authorizeProjectTaskConfig(
          project(),
          [historical],
          config({ shootingDate }),
        ),
      ).toThrow("拍摄日期无效");
    },
  );

  it("allows only the explicitly planned temporary device on its selected day", () => {
    const value = recordDailyPlanDecision(project(), {
      date: "2026-10-16",
      scheduleKey: "Drone::A",
      decision: "expected",
      operator: "DIT",
      purpose: "temporary-device",
    });
    expect(() =>
      authorizeProjectTaskConfig(
        value,
        [],
        config({
          devices: ["Drone"],
          cameraPosition: "A",
          shootingDate: "2026-10-16",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      authorizeProjectTaskConfig(
        value,
        [],
        config({
          devices: ["Drone"],
          cameraPosition: "A",
          shootingDate: "2026-10-15",
        }),
      ),
    ).toThrow("尚未加入此拍摄日");
  });

  it("does not mutate the renderer request", () => {
    const request = config(),
      before = structuredClone(request);
    authorizeProjectTaskConfig(project(), [], request);
    expect(request).toEqual(before);
  });
});
