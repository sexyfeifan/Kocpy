import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (data) => createHash("sha256").update(data).digest("hex");

const MH_MAGIC_64 = 0xfeedfacf;
const MH_CIGAM_64 = 0xcffaedfe;
const MH_EXECUTE = 0x2;
const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86_64 = CPU_ARCH_ABI64 | 7;
const CPU_TYPE_ARM64 = CPU_ARCH_ABI64 | 12;
const DYLIB_LOAD_COMMANDS = new Set([
  0x0c, // LC_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x20, // LC_LAZY_LOAD_DYLIB
  0x80000023, // LC_LOAD_UPWARD_DYLIB
]);
const allowedSystemLibrary = /^\/(?:usr\/lib|System\/Library)\//;

function declaredLibraryPath(line) {
  assert.equal(typeof line, "string", "Invalid declared dynamic library");
  const libraryPath = line.replace(/\s+\(compatibility version .*$/, "");
  assert(allowedSystemLibrary.test(libraryPath), `External declared dynamic library: ${libraryPath}`);
  return libraryPath;
}

/**
 * Read the load-command table directly so release verification does not depend
 * on Xcode command-line tools (or accepting the Xcode licence). Thin 64-bit
 * executables are required deliberately: a mislabeled or universal runtime is
 * rejected instead of silently selecting a slice.
 */
export function parseMachO64(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  assert(bytes.length >= 32, "Truncated Mach-O header");
  const magic = bytes.readUInt32LE(0);
  const littleEndian = magic === MH_MAGIC_64;
  assert(littleEndian || magic === MH_CIGAM_64, "Expected a thin 64-bit Mach-O binary");
  const read32 = littleEndian
    ? (offset) => bytes.readUInt32LE(offset)
    : (offset) => bytes.readUInt32BE(offset);
  const cpuType = read32(4);
  const cpuSubtype = read32(8);
  const fileType = read32(12);
  const commandCount = read32(16);
  const commandBytes = read32(20);
  const commandsStart = 32;
  const commandsEnd = commandsStart + commandBytes;
  assert(commandsEnd >= commandsStart && commandsEnd <= bytes.length, "Mach-O load commands exceed binary size");
  assert(commandCount <= Math.floor(commandBytes / 8), "Invalid Mach-O load command count");

  const architecture = cpuType === CPU_TYPE_ARM64
    ? "arm64"
    : cpuType === CPU_TYPE_X86_64
      ? "x64"
      : null;
  assert(architecture, `Unsupported Mach-O CPU type: 0x${cpuType.toString(16)}`);
  assert.equal(fileType, MH_EXECUTE, "Media runtime must be a Mach-O executable");

  const dynamicLibraries = [];
  let commandOffset = commandsStart;
  for (let index = 0; index < commandCount; index += 1) {
    assert(commandOffset + 8 <= commandsEnd, `Truncated Mach-O load command ${index}`);
    const command = read32(commandOffset);
    const commandSize = read32(commandOffset + 4);
    assert(commandSize >= 8 && commandSize % 8 === 0, `Invalid Mach-O load command size at ${index}`);
    const nextOffset = commandOffset + commandSize;
    assert(nextOffset > commandOffset && nextOffset <= commandsEnd, `Mach-O load command ${index} exceeds command table`);
    if (DYLIB_LOAD_COMMANDS.has(command)) {
      assert(commandSize >= 24, `Truncated dylib load command ${index}`);
      const nameOffset = read32(commandOffset + 8);
      assert(nameOffset >= 24 && nameOffset < commandSize, `Invalid dylib name offset at load command ${index}`);
      const nameStart = commandOffset + nameOffset;
      const terminator = bytes.indexOf(0, nameStart);
      assert(terminator >= nameStart && terminator < nextOffset, `Unterminated dylib name at load command ${index}`);
      const libraryPath = bytes.toString("utf8", nameStart, terminator);
      assert(libraryPath.length > 0 && !libraryPath.includes("\ufffd"), `Invalid dylib name at load command ${index}`);
      dynamicLibraries.push(libraryPath);
    }
    commandOffset = nextOffset;
  }
  assert.equal(commandOffset, commandsEnd, "Mach-O load command table size mismatch");
  assert(dynamicLibraries.length > 0, "Mach-O executable has no dynamic library dependencies");
  assert.equal(new Set(dynamicLibraries).size, dynamicLibraries.length, "Duplicate Mach-O dynamic library dependency");
  return { architecture, cpuType, cpuSubtype, fileType, commandCount, dynamicLibraries };
}

export function validateMachOBinary(data, expectedArchitecture, declaredLibraries) {
  assert(["arm64", "x64"].includes(expectedArchitecture), `Unsupported expected architecture: ${expectedArchitecture}`);
  const parsed = parseMachO64(data);
  assert.equal(parsed.architecture, expectedArchitecture, `Mach-O architecture mismatch for ${expectedArchitecture}`);
  for (const libraryPath of parsed.dynamicLibraries)
    assert(allowedSystemLibrary.test(libraryPath), `External Mach-O dynamic library: ${libraryPath}`);
  if (declaredLibraries) {
    const declared = declaredLibraries.map(declaredLibraryPath);
    assert.deepEqual(
      [...parsed.dynamicLibraries].sort(),
      [...declared].sort(),
      "Mach-O dependencies do not match build information",
    );
  }
  return parsed;
}

export function validateMediaBuild(info, lock, arch) {
  assert.equal(info.schemaVersion, 1);
  assert.equal(info.architecture, arch);
  assert.equal(info.ffmpeg, lock.ffmpeg.version);
  assert.equal(info.x264, lock.x264.version);
  assert.equal(info.license, "GPL-2.0-or-later");
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
  assert(info.ffmpegConfigure.includes("--disable-nonfree"));
  assert(info.ffmpegConfigure.includes("--disable-autodetect"));
  assert(info.ffmpegConfigure.includes("--enable-gpl"));
  assert(!info.ffmpegConfigure.some((arg) => /--enable-(nonfree|version3)/.test(arg)));
  assert(info.dynamicLibraries.length > 0);
  assert(info.dynamicLibraries.every((line) => /^\/(usr\/lib|System\/Library)\//.test(line)));
}
export async function verifyMediaRuntime(directory = path.join(repo, "resources/ffmpeg")) {
  const lockBytes = await readFile(path.join(directory, "sources/media-source-lock.json"));
  const lock = JSON.parse(lockBytes);
  assert.equal(hash(lockBytes), hash(await readFile(path.join(repo, "scripts/media-source-lock.json"))));
  assert.equal(hash(await readFile(path.join(directory, "sources/build-media-runtime.mjs"))), hash(await readFile(path.join(repo, "scripts/build-media-runtime.mjs"))));
  for (const source of [lock.ffmpeg, lock.x264, lock.nasm])
    assert.equal(hash(await readFile(path.join(directory, "sources", source.archive))), source.sha256, `Source mismatch: ${source.archive}`);
  for (const name of ["NOTICE.md", "FFmpeg-COPYING.GPLv2", "FFmpeg-COPYING.LGPLv2.1", "FFmpeg-LICENSE.md", "x264-COPYING"])
    assert((await stat(path.join(directory, name))).size > 500, `Missing/truncated license notice: ${name}`);
  const results = [];
  const binaries = (await readdir(directory)).filter((name) => name.startsWith("ffmpeg-darwin-"));
  assert(binaries.length > 0, "No media binary");
  for (const name of binaries) {
    const arch = name.replace("ffmpeg-darwin-", "");
    assert(["arm64", "x64"].includes(arch));
    const info = JSON.parse(await readFile(path.join(directory, `build-info-${arch}.json`)));
    validateMediaBuild(info, lock, arch);
    assert.equal(info.sourceLockSha256, hash(lockBytes));
    const binary = path.join(directory, name);
    const binaryBytes = await readFile(binary);
    assert.equal(hash(binaryBytes), info.sha256, `Binary checksum mismatch: ${arch}`);
    validateMachOBinary(binaryBytes, arch, info.dynamicLibraries);
    if (process.platform === "darwin") {
      // Native architecture is executed here. Cross-architecture packaged runtime
      // and proxy tests are separate, explicitly reported verification steps.
      if (arch === process.arch) {
        const license = execFileSync(binary, ["-hide_banner", "-L"], { encoding: "utf8" });
        const version = execFileSync(binary, ["-version"], { encoding: "utf8" });
        assert(!/nonfree parts|not legally redistributable|--enable-nonfree/.test(license + version));
        assert(license.includes("GNU General Public License"));
        assert(version.startsWith(`ffmpeg version ${info.ffmpeg} `));
      }
    }
    results.push({ arch, sha256: info.sha256, license: info.license });
  }
  return results;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await verifyMediaRuntime(process.argv[2]), null, 2));
