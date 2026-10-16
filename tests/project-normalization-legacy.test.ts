import { describe, expect, it } from "vitest";
import { normalizeProject } from "../src/main/project-normalization";
import {
  sealWorkspaceState,
  validateWorkspaceState,
} from "../src/main/workspace-contract";
import type { ProjectConfig } from "../src/main/types";

const loadLegacyProject = (shootingDateStart: string) => {
  const project = {
      id: `legacy-${shootingDateStart}`,
      name: "旧项目",
      devices: ["FX3"],
      volumePrefix: "FX3_",
      shootingDateStart,
      shootingDateEnd: shootingDateStart,
    } as ProjectConfig,
    sealed = sealWorkspaceState({
      schemaVersion: 1,
      revision: 1,
      committedAt: 1,
      tasks: [],
      projects: [project],
      taskTombstones: [],
      projectTombstones: [],
    }),
    loaded = validateWorkspaceState(JSON.parse(JSON.stringify(sealed))),
    raw = loaded.projects[0],
    normalized = normalizeProject(raw);
  return { raw, normalized };
};

describe("legacy project date normalization", () => {
  it.each([
    ["2026-02-30", "20260230_旧项目"],
    ["2026/10/15", "20261015_旧项目"],
  ])(
    "loads %s without rolling or rejecting the old record",
    (legacyDate, expectedFolder) => {
      const { raw, normalized } = loadLegacyProject(legacyDate);
      expect(raw.projectFolderName).toBeUndefined();
      expect(raw.shootingDateStart).toBe(legacyDate);
      expect(normalized.shootingDateStart).toBe(legacyDate);
      expect(normalized.shootingDateEnd).toBe(legacyDate);
      expect(normalized.projectFolderName).toBe(expectedFolder);
    },
  );

  it("uses a stable visible repair fallback for a malformed legacy date", () => {
    const first = loadLegacyProject("unknown shooting day"),
      second = loadLegacyProject("unknown shooting day");
    expect(first.raw.shootingDateStart).toBe("unknown shooting day");
    expect(first.normalized.shootingDateStart).toBe("unknown shooting day");
    expect(first.normalized.projectFolderName).toMatch(
      /^日期待修复_旧项目_[a-f0-9]{8}$/,
    );
    expect(second.normalized.projectFolderName).toBe(
      first.normalized.projectFolderName,
    );
  });
});
