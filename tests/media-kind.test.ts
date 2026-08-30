import { describe, expect, it } from "vitest";
import {
  ensureTaskMediaBreakdown,
  mediaBreakdownFromFiles,
  taskMediaKind,
} from "../src/main/media-kind";

const task = (devices: string[] = ["FX3"]) =>
  ({ devices, fileRecords: [] }) as any;

describe("task media icons", () => {
  it("classifies common DIT media extensions", () => {
    const breakdown = mediaBreakdownFromFiles([
      { name: "A001.mov", size: 1000 },
      { name: "A001.xml", size: 10 },
      { name: "sound.wav", size: 100 },
    ] as any);
    expect(breakdown.video).toEqual({ files: 1, bytes: 1000 });
    expect(breakdown.audio).toEqual({ files: 1, bytes: 100 });
    expect(breakdown.other).toEqual({ files: 1, bytes: 10 });
  });

  it("uses the dominant media by bytes and keeps real mixtures distinct", () => {
    expect(
      taskMediaKind({
        devices: ["FX3"],
        mediaBreakdown: mediaBreakdownFromFiles([
          { name: "clip.mov", size: 900 },
          { name: "reference.wav", size: 100 },
        ] as any),
      }),
    ).toBe("video");
    expect(
      taskMediaKind({
        devices: ["FX3"],
        mediaBreakdown: mediaBreakdownFromFiles([
          { name: "clip.mov", size: 600 },
          { name: "reference.wav", size: 400 },
        ] as any),
      }),
    ).toBe("mixed");
  });

  it("recognizes audio devices when legacy records lack a breakdown", () => {
    expect(taskMediaKind(task(["音频"]))).toBe("audio");
    expect(taskMediaKind(task(["Boom Audio"]))).toBe("audio");
  });

  it("backfills historical tasks only from stored file records", () => {
    const legacy = task();
    legacy.fileRecords = [
      { name: "DSC0001.ARW", size: 20, relativePath: "DCIM/DSC0001.ARW" },
    ];
    expect(ensureTaskMediaBreakdown(legacy)).toBe(true);
    expect(taskMediaKind(legacy)).toBe("photo");
    expect(ensureTaskMediaBreakdown(legacy)).toBe(false);
  });
});
