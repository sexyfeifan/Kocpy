import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
// @ts-expect-error release tooling is shared Node ESM, outside the application TS build
import { parseMachO64, validateMachOBinary, validateMediaBuild, verifyMediaRuntime } from "../scripts/verify-media-runtime.mjs";

const CPU_TYPES = { arm64: 0x0100000c, x64: 0x01000007 } as const;

function minimalMachO(architecture: keyof typeof CPU_TYPES, libraries: string[]) {
  const commands = libraries.map((library) => {
    const name = Buffer.from(`${library}\0`);
    const size = Math.ceil((24 + name.length) / 8) * 8;
    const command = Buffer.alloc(size);
    command.writeUInt32LE(0x0c, 0);
    command.writeUInt32LE(size, 4);
    command.writeUInt32LE(24, 8);
    name.copy(command, 24);
    return command;
  });
  const commandBytes = commands.reduce((total, command) => total + command.length, 0);
  const binary = Buffer.alloc(32 + commandBytes);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(CPU_TYPES[architecture], 4);
  binary.writeUInt32LE(0, 8);
  binary.writeUInt32LE(2, 12);
  binary.writeUInt32LE(commands.length, 16);
  binary.writeUInt32LE(commandBytes, 20);
  let offset = 32;
  for (const command of commands) {
    command.copy(binary, offset);
    offset += command.length;
  }
  return binary;
}

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

it("reads architecture and system dylib dependencies from both shipped Mach-O binaries", async () => {
  for (const architecture of ["arm64", "x64"] as const) {
    const binary = await readFile(`resources/ffmpeg/ffmpeg-darwin-${architecture}`);
    const info = JSON.parse(await readFile(`resources/ffmpeg/build-info-${architecture}.json`, "utf8"));
    const parsed = validateMachOBinary(binary, architecture, info.dynamicLibraries);
    expect(parsed.architecture).toBe(architecture);
    expect(parsed.dynamicLibraries).toEqual(
      info.dynamicLibraries.map((line: string) => line.replace(/\s+\(compatibility version .*$/, "")),
    );
  }
});

it("rejects mislabeled architectures and non-system Mach-O dependencies", () => {
  const arm64 = minimalMachO("arm64", ["/usr/lib/libSystem.B.dylib"]);
  expect(parseMachO64(arm64).architecture).toBe("arm64");
  expect(() => validateMachOBinary(arm64, "x64")).toThrow(/architecture mismatch/);
  const external = minimalMachO("arm64", ["/opt/homebrew/lib/libx264.dylib"]);
  expect(() => validateMachOBinary(external, "arm64")).toThrow(/External Mach-O dynamic library/);
});
