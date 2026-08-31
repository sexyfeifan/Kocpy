import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
// @ts-expect-error release tooling is shared Node ESM, outside the application TS build
import { validateMediaBuild, verifyMediaRuntime } from "../scripts/verify-media-runtime.mjs";

it("ships exact source archives, complete notices and pinned media binaries", async () => {
  expect(await verifyMediaRuntime()).toHaveLength(2);
  if (process.platform === "darwin")
    expect(execFileSync(process.execPath, ["resources/ffmpeg/sources/build-media-runtime.mjs", process.arch, "resources/ffmpeg/sources", "--verify-sources"], { encoding: "utf8" })).toContain("Standalone corresponding sources verified");
});
it("rejects nonfree, stale or externally linked build manifests", async () => {
  const lock = JSON.parse(await readFile("scripts/media-source-lock.json", "utf8"));
  const info = JSON.parse(await readFile("resources/ffmpeg/build-info-arm64.json", "utf8"));
  expect(() => validateMediaBuild(info, lock, "arm64")).not.toThrow();
  for (const changes of [
    { ffmpegConfigure: [...info.ffmpegConfigure, "--enable-nonfree"] },
    { ffmpegConfigure: info.ffmpegConfigure.filter((arg: string) => arg !== "--disable-autodetect") },
    { license: "nonfree" }, { ffmpeg: "6.0" }, { architecture: "x64" },
    { dynamicLibraries: ["/opt/homebrew/lib/libx264.dylib"] },
  ]) expect(() => validateMediaBuild({ ...info, ...changes }, lock, "arm64")).toThrow();
});
