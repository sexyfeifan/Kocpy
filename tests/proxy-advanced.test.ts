import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freezeProxyAdvanced, readFrozenProxyLut, buildProxyFilters, proxyExpectedMedia } from "../src/main/proxy-advanced";
import { validateProxyParameters, compareProxyMedia } from "../src/main/proxy-evidence";
import { selectProxyEncoder, shouldFallbackProxyHardware } from "../src/main/proxy-encoder";
import type { ProxyParameterSnapshot } from "../src/main/types";
const base: ProxyParameterSnapshot = { purpose: "review", format: "h264", container: "mp4", resolution: "720p", namingTemplate: "{name}" };
describe("frozen advanced proxy parameters", () => {
  it("rejects incompatible and unbounded settings", () => {
    for (const advanced of [{ encoder: "hardware", crf: 20 }, { audioCodec: "pcm_s16le" }, { gop: 301 }, { frameRate: "120" }, { timecodeMode: "custom", timecode: "24:00:00:00" }])
      expect(() => validateProxyParameters({ ...base, advanced } as ProxyParameterSnapshot)).toThrow();
    expect(() => validateProxyParameters({ ...base, resolution: "99999x99999" })).toThrow();
    expect(() => validateProxyParameters({ ...base, resolution: "1921x1080" })).toThrow();
    expect(() => validateProxyParameters({ ...base, purpose: "editorial", advanced: { audioMode: "none" } })).toThrow();
    expect(() => validateProxyParameters({ ...base, format: "prores", container: "mov", advanced: { crf: 23, encoder: "software" } })).toThrow();
  });
  it("freezes LUT bytes and rejects replacement, malformed and oversized LUTs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-lut-test-"));
    try {
      const lutPath = path.join(root, "look.cube");
      const cube = "LUT_3D_SIZE 2\n" + ["0 0 0", "1 0 0", "0 1 0", "1 1 0", "0 0 1", "1 0 1", "0 1 1", "1 1 1"].join("\n");
      await fs.writeFile(lutPath, cube);
      const advanced = await freezeProxyAdvanced({ lutPath });
      expect(advanced.lutEvidence?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await readFrozenProxyLut(advanced))?.buffer.toString()).toBe(cube);
      await fs.writeFile(lutPath, cube.replace("1 1 1", "0 1 1"));
      await expect(readFrozenProxyLut(advanced)).rejects.toThrow("内容已改变");
      await fs.writeFile(lutPath, "LUT_3D_SIZE 2\n0 0 0");
      await expect(freezeProxyAdvanced({ lutPath })).rejects.toThrow("不完整");
      const handle = await fs.open(lutPath, "w"); await handle.truncate(16 * 1024 ** 2 + 1); await handle.close();
      await expect(freezeProxyAdvanced({ lutPath })).rejects.toThrow("16 MiB");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("compares intentional transforms against frozen expectations, not stale source values", () => {
    const source = { frameRate: "25", audioTracks: 2, rotation: 90, colorSpace: "bt2020", timecode: "01:00:00:00", duration: "00:00:02.00" };
    const parameters: ProxyParameterSnapshot = { ...base, advanced: { frameRate: "24", audioMode: "first", timecodeMode: "custom", timecode: "02:00:00:00", rotation: "auto", colorMode: "bt709" } };
    const expected = proxyExpectedMedia(source, parameters);
    expect(compareProxyMedia(source, expected, parameters).readiness).toBe("ready");
    expect(source.frameRate).toBe("25");
    expect(compareProxyMedia(source, { ...expected, audioTracks: 0 }, parameters).audio).toBe("missing");
    expect(compareProxyMedia(source, { ...expected, frameRate: "30" }, parameters).frameRate).toBe("changed");
  });
  it("uses only fixed staged LUT filename and explicit aspect filters", () => {
    expect(buildProxyFilters("1920x1080", { aspect: "fit", rotation: "90", frameRate: "24" }, true)).toContain("pad=1920:1080");
    expect(buildProxyFilters("1920x1080", { aspect: "crop" })).toContain("crop=1920:1080");
    expect(buildProxyFilters("720p", {}, true)).toContain("lut3d=file=look.cube");
  });
  it("distinguishes automatic fallback from hardware-required and software modes", async () => {
    expect((await selectProxyEncoder("h264", { encoder: "auto" }, async () => true)).encoder).toBe("h264_videotoolbox");
    expect((await selectProxyEncoder("h264", { encoder: "auto" }, async () => false)).fallbackReason).toBeTruthy();
    await expect(selectProxyEncoder("h264", { encoder: "hardware" }, async () => false)).rejects.toThrow("不可用");
    expect((await selectProxyEncoder("prores", {}, async () => { throw Error("must not probe"); })).encoder).toBe("prores_ks");
    expect((await selectProxyEncoder("h264", { encoder: "software" }, async () => { throw Error("must not probe"); })).encoder).toBe("libx264");
  });
  it("never retries disk, permission, corrupt-source or cancellation errors as hardware failure", () => {
    expect(shouldFallbackProxyHardware(new Error("cannot create compression session"))).toBe(true);
    for (const message of ["No space left on device", "Permission denied", "Input/output error", "Invalid data found", "Operation not permitted", "cancelled", "h264_videotoolbox banner only"])
      expect(shouldFallbackProxyHardware(new Error(message))).toBe(false);
    expect(shouldFallbackProxyHardware(new Error("Error while opening encoder: No space left"))).toBe(false);
  });
});
