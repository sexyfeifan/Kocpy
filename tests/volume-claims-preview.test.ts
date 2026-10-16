import { afterEach, describe, expect, it, vi } from "vitest";
import { priorMaxCollision } from "../src/common/volume-claims";
import { claimProjectTimestampedVolume } from "../src/main/project-path";
import type { ProjectConfig } from "../src/main/types";

afterEach(() => vi.unstubAllGlobals());

describe("project-wide volume claim previews", () => {
  it("counts every device in this minute, including the first unsuffixed claim", () => {
    const minute = "202610160030";
    expect(priorMaxCollision(minute)).toBe(-1);
    expect(priorMaxCollision(minute, { Camera: minute })).toBe(0);
    expect(priorMaxCollision(minute, { Camera: minute, Drone: minute, Prior: "202610160029" }, { Camera: 1, Drone: 4, Prior: 99 })).toBe(4);
    expect(priorMaxCollision("202610160031", { Camera: minute }, { Camera: 4 })).toBe(-1);
  });

  it("matches the actual claims across devices and batch indices without mutating project state", async () => {
    vi.stubGlobal("window", { api: {} });
    const { previewProjectVolumeName } = await import("../src/renderer/src/Composer");
    const minute = "202610160030";
    const project: ProjectConfig = {
      id: "preview-fixture", name: "Generated preview fixture", devices: ["Camera", "Drone"], volumePrefix: "CARD_",
      lastVolumeTimestampByDevice: { Camera: minute, Drone: minute, Old: "202610160029" },
      volumeTimestampCollisionByDevice: { Camera: 0, Drone: 3, Old: 20 },
    };
    const before = structuredClone(project);
    const stamps = { ...project.lastVolumeTimestampByDevice }, counters = { ...project.volumeTimestampCollisionByDevice };
    for (let index = 0; index < 3; index += 1) {
      const claim = claimProjectTimestampedVolume("CARD_", minute, stamps, counters);
      expect(previewProjectVolumeName("CARD_", minute, project, index)).toBe(claim.label);
      const device = index % 2 ? "Camera" : "Drone";
      stamps[device] = minute;
      counters[device] = claim.collision;
    }
    expect(previewProjectVolumeName("CARD_", minute, project, 0)).toBe("CARD_202610160030_05");
    expect(previewProjectVolumeName("CARD_", minute, project, 2)).toBe("CARD_202610160030_07");
    expect(project).toEqual(before);
  });

  it("starts the next minute unsuffixed and increments a fresh multi-source batch", async () => {
    vi.stubGlobal("window", { api: {} });
    const { previewProjectVolumeName } = await import("../src/renderer/src/Composer");
    const project: ProjectConfig = { id: "fresh-fixture", name: "Generated", devices: ["Camera"], volumePrefix: "CARD_", lastVolumeTimestampByDevice: { Camera: "202610160030" }, volumeTimestampCollisionByDevice: { Camera: 30 } };
    expect(previewProjectVolumeName("CARD_", "202610160031", project, 0)).toBe("CARD_202610160031");
    expect(previewProjectVolumeName("CARD_", "202610160031", project, 1)).toBe("CARD_202610160031_02");
    expect(previewProjectVolumeName("CARD_", "202610160031", undefined, 2)).toBe("CARD_202610160031_03");
  });
});
