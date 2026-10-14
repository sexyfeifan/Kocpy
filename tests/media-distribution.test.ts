import { it, expect } from "vitest";
import { cp, mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error release tooling is shared Node ESM, outside the application TS build
import { parseMachO64, validateMachOBinary, validateMediaBuild, validateMediaSignatureDetails, validateEmbeddedMediaSignature, verifyMediaRuntime } from "../scripts/verify-media-runtime.mjs";
// @ts-expect-error standalone corresponding-source tooling is Node ESM
import { compilerSignatureState } from "../scripts/build-media-runtime.mjs";

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

it("rejects absent, inconsistent or unsupported signing provenance", async () => {
  const lock = JSON.parse(await readFile("scripts/media-source-lock.json", "utf8"));
  const current = JSON.parse(await readFile("resources/ffmpeg/build-info-arm64.json", "utf8"));
  const info = { ...current, schemaVersion: 2, unsignedSha256: "a".repeat(64), sha256: "b".repeat(64), binarySigning: {
    mode: "ad-hoc", tool: "/usr/bin/codesign", identity: "-", identifier: "com.kocpy.media.ffmpeg.arm64", timestamp: "none", hardenedRuntime: true, removeExistingSignature: true,
  } };
  expect(() => validateMediaBuild(info, lock, "arm64")).not.toThrow();
  for (const changes of [
    { schemaVersion: 1 }, { unsignedSha256: undefined }, { unsignedSha256: "wrong" },
    { unsignedSha256: info.sha256 }, { binarySigning: undefined },
    ...[
      { mode: "developer-id" }, { identity: "fixture" }, { identifier: "ffmpeg" },
      { identifier: "com.kocpy.media.ffmpeg.x64" }, { timestamp: "now" },
      { hardenedRuntime: false }, { removeExistingSignature: false }, { tool: "codesign" }, { unknownPolicy: true },
    ].map(signing => ({ binarySigning: { ...info.binarySigning, ...signing } })),
  ]) expect(() => validateMediaBuild({ ...info, ...changes }, lock, "arm64")).toThrow();
});

it("strips only an inspected signature and never treats an arbitrary codesign failure as unsigned", () => {
  const binary = "/synthetic/ffmpeg-darwin-x64";
  expect(compilerSignatureState({ status: 0, stdout: "", stderr: "Identifier=ffmpeg" }, binary)).toBe("signed");
  expect(compilerSignatureState({ status: 1, stdout: "", stderr: `${binary}: code object is not signed at all\n` }, binary)).toBe("unsigned");
  for (const result of [
    { status: null, error: new Error("spawn failed") },
    { status: 2, stderr: `${binary}: code object is not signed at all` },
    { status: 1, stderr: "permission denied" },
    { status: 1, stdout: "unexpected", stderr: `${binary}: code object is not signed at all` },
    { status: 1, stderr: `${binary}: code object is not signed at all\nother failure` },
    { status: 1, stderr: "/different/file: code object is not signed at all" },
  ]) expect(() => compilerSignatureState(result, binary)).toThrow(/refusing media signing/);
});

it("rejects missing or mismatched actual signature details", () => {
  const details = [
    "Identifier=com.kocpy.media.ffmpeg.arm64",
    "CodeDirectory v=20500 size=200 flags=0x10002(adhoc,runtime) hashes=1+0 location=embedded",
    "Hash type=sha256 size=32", "Signature=adhoc", "TeamIdentifier=not set",
  ].join("\n");
  expect(() => validateMediaSignatureDetails(details, "arm64")).not.toThrow();
  for (const invalid of [
    "", details.replace("com.kocpy.media.ffmpeg.arm64", "ffmpeg"),
    details.replace("0x10002", "0x2"), details.replace("Signature=adhoc", "Signature=Developer ID"),
    details.replace("TeamIdentifier=not set", "TeamIdentifier=fixture"),
    details.replace("Hash type=sha256", "Hash type=sha1"),
    `${details}\nAuthority=Developer ID Application: fixture`, `${details}\nTimestamp=fixture`,
    `${details}\nIdentifier=com.kocpy.media.ffmpeg.arm64`,
  ]) expect(() => validateMediaSignatureDetails(invalid, "arm64")).toThrow();
  expect(() => validateMediaSignatureDetails(details, "x64")).toThrow(/identifier mismatch/);
});

function signedMachOFixture() {
  const original = minimalMachO("arm64", ["/usr/lib/libSystem.B.dylib"]);
  const commandsEnd = original.length + 16;
  const identifier = Buffer.from("com.kocpy.media.ffmpeg.arm64\0");
  const directorySize = 44 + identifier.length;
  const blobLength = 20 + directorySize;
  const signatureSize = Math.ceil(blobLength / 8) * 8;
  const binary = Buffer.alloc(commandsEnd + signatureSize);
  original.copy(binary);
  binary.writeUInt32LE(original.readUInt32LE(16) + 1, 16);
  binary.writeUInt32LE(original.readUInt32LE(20) + 16, 20);
  binary.writeUInt32LE(0x1d, original.length);
  binary.writeUInt32LE(16, original.length + 4);
  binary.writeUInt32LE(commandsEnd, original.length + 8);
  binary.writeUInt32LE(signatureSize, original.length + 12);
  binary.writeUInt32BE(0xfade0cc0, commandsEnd);
  binary.writeUInt32BE(blobLength, commandsEnd + 4);
  binary.writeUInt32BE(1, commandsEnd + 8);
  binary.writeUInt32BE(0, commandsEnd + 12);
  binary.writeUInt32BE(20, commandsEnd + 16);
  const directory = commandsEnd + 20;
  binary.writeUInt32BE(0xfade0c02, directory);
  binary.writeUInt32BE(directorySize, directory + 4);
  binary.writeUInt32BE(0x10002, directory + 12);
  binary.writeUInt32BE(44, directory + 20);
  binary.writeUInt32BE(commandsEnd, directory + 32);
  binary[directory + 36] = 32;
  binary[directory + 37] = 2;
  identifier.copy(binary, directory + 44);
  return { binary, commandsEnd, directory };
}

it("rejects unsigned, truncated and unsupported embedded media signatures", () => {
  const unsigned = minimalMachO("x64", ["/usr/lib/libSystem.B.dylib"]);
  expect(() => validateEmbeddedMediaSignature(unsigned, parseMachO64(unsigned))).toThrow(/exactly one embedded signature/);
  const { binary, commandsEnd, directory } = signedMachOFixture();
  expect(() => validateEmbeddedMediaSignature(binary, parseMachO64(binary))).not.toThrow();
  for (const mutate of [
    (bytes: Buffer) => bytes.writeUInt32BE(0, commandsEnd + 8),
    (bytes: Buffer) => bytes.writeUInt32BE(2, commandsEnd + 12),
    (bytes: Buffer) => bytes.writeUInt32BE(0xffffffff, commandsEnd + 16),
    (bytes: Buffer) => bytes.writeUInt32BE(0x2, directory + 12),
    (bytes: Buffer) => bytes.writeUInt32BE(commandsEnd - 1, directory + 32),
    (bytes: Buffer) => { bytes[directory + 37] = 1; },
    (bytes: Buffer) => { bytes[directory + 44] = 0x78; },
    (bytes: Buffer) => { bytes[bytes.length - 1] = 1; },
  ]) {
    const mutated = Buffer.from(binary);
    mutate(mutated);
    expect(() => validateEmbeddedMediaSignature(mutated, parseMachO64(mutated))).toThrow();
  }
  expect(() => parseMachO64(binary.subarray(0, binary.length - 1))).toThrow(/signature range/);
});

it("rejects changed final runtime bytes while preserving the frozen manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kocpy-media-hash-regression-"));
  try {
    const resources = path.join(root, "ffmpeg");
    await cp("resources/ffmpeg", resources, { recursive: true });
    const before = await readFile(path.join(resources, "build-info-arm64.json"), "utf8");
    const binary = await open(path.join(resources, "ffmpeg-darwin-arm64"), "r+");
    try {
      const byte = Buffer.alloc(1);
      await binary.read(byte, 0, 1, 4096);
      byte[0] ^= 1;
      await binary.write(byte, 0, 1, 4096);
    } finally { await binary.close(); }
    await expect(verifyMediaRuntime(resources)).rejects.toThrow(/Binary checksum mismatch/);
    expect(await readFile(path.join(resources, "build-info-arm64.json"), "utf8")).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
