import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateProxyBytes, preflightProxyGeneration } from "../src/main/proxy-preflight";
const parameters = { purpose: "review" as const, format: "h264" as const, resolution: "720p", container: "mp4" as const, namingTemplate: "{name}" };
const media = { duration: "00:01:00", frameRate: "25", resolution: "1920x1080", audioTracks: 1 };
it("estimates frozen format/resolution/bitrate and rejects unknown or invalid video", () => {
  expect(estimateProxyBytes(media, { ...parameters, format: "prores", container: "mov" })).toBeGreaterThan(estimateProxyBytes(media, parameters));
  expect(estimateProxyBytes(media, { ...parameters, bitrateMbps: 100 })).toBeGreaterThan(estimateProxyBytes(media, parameters));
  for (const value of [{ ...media, duration: undefined }, { ...media, frameRate: "NaN" }, { ...media, resolution: "0x0" }]) expect(() => estimateProxyBytes(value, parameters)).toThrow();
});
it("preflights without creating output and protects canonical source/backup paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-preflight-"));
  try {
    const source = path.join(root, "source"), output = path.join(root, "new", "proxies");
    await fs.mkdir(source);
    const report = await preflightProxyGeneration(output, [{ media, parameters }], [source]);
    expect(report.requiredBytes).toBeGreaterThan(2 * report.estimatedBytes);
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.symlink(source, path.join(root, "source-link"));
    await expect(preflightProxyGeneration(path.join(root, "source-link", "proxies"), [{ media, parameters }], [source])).rejects.toThrow("素材源或已校验");
    await expect(preflightProxyGeneration(output, [{ media, parameters }], [], 0, report.destinationDevice + 1)).rejects.toThrow("文件系统已改变");
    await fs.writeFile(path.join(root, "file"), "occupied");
    await expect(preflightProxyGeneration(path.join(root, "file"), [{ media, parameters }], [])).rejects.toThrow("被文件占用");
    const space = vi.spyOn(fs, "statfs").mockResolvedValue({ bavail: 1, bsize: 1 } as any);
    await expect(preflightProxyGeneration(output, [{ media, parameters }], [], report.estimatedBytes)).rejects.toThrow("空间不足");
    space.mockRestore();
  } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
});
