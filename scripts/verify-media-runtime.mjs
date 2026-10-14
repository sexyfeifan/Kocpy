import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
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
  const codeSignatures = [];
  let commandOffset = commandsStart;
  for (let index = 0; index < commandCount; index += 1) {
    assert(commandOffset + 8 <= commandsEnd, `Truncated Mach-O load command ${index}`);
    const command = read32(commandOffset);
    const commandSize = read32(commandOffset + 4);
    assert(commandSize >= 8 && commandSize % 8 === 0, `Invalid Mach-O load command size at ${index}`);
    const nextOffset = commandOffset + commandSize;
    assert(nextOffset > commandOffset && nextOffset <= commandsEnd, `Mach-O load command ${index} exceeds command table`);
    if (command === 0x1d) { // LC_CODE_SIGNATURE
      assert.equal(commandSize, 16, "Invalid Mach-O code-signature command");
      const offset = read32(commandOffset + 8), size = read32(commandOffset + 12);
      assert(size >= 12 && offset >= commandsEnd && offset + size <= bytes.length, "Invalid Mach-O code-signature range");
      codeSignatures.push({ offset, size });
    }
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
  return { architecture, cpuType, cpuSubtype, fileType, commandCount, dynamicLibraries, codeSignatures };
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
  assert.equal(info.schemaVersion, 2);
  assert.equal(info.architecture, arch);
  assert.equal(info.ffmpeg, lock.ffmpeg.version);
  assert.equal(info.x264, lock.x264.version);
  assert.equal(info.license, "GPL-2.0-or-later");
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
  assert.match(info.unsignedSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(info.unsignedSha256, info.sha256, "Kocpy media signing must preserve a distinct compilation-output digest");
  assert.deepEqual(info.binarySigning, {
    mode: "ad-hoc",
    tool: "/usr/bin/codesign",
    identity: "-",
    identifier: `com.kocpy.media.ffmpeg.${arch}`,
    timestamp: "none",
    hardenedRuntime: true,
    removeExistingSignature: true,
  }, "Unsupported media binary signing policy");
  assert(info.ffmpegConfigure.includes("--disable-nonfree"));
  assert(info.ffmpegConfigure.includes("--disable-autodetect"));
  assert(info.ffmpegConfigure.includes("--enable-gpl"));
  assert(!info.ffmpegConfigure.some((arg) => /--enable-(nonfree|version3)/.test(arg)));
  assert(info.dynamicLibraries.length > 0);
  assert(info.dynamicLibraries.every((line) => /^\/(usr\/lib|System\/Library)\//.test(line)));
}

export function validateMediaSignatureDetails(details, arch) {
  const lines = details.split(/\r?\n/);
  const field = (name) => {
    const matches = lines.filter((line) => line.startsWith(`${name}=`));
    assert.equal(matches.length, 1, `Missing or ambiguous media signature field: ${name}`);
    return matches[0].slice(name.length + 1);
  };
  assert.equal(field("Identifier"), `com.kocpy.media.ffmpeg.${arch}`, "Media signature identifier mismatch");
  assert.equal(field("Signature"), "adhoc", "Media runtime requires its frozen ad-hoc signature");
  assert.equal(field("TeamIdentifier"), "not set", "Developer ID media signing is unsupported");
  assert(!lines.some((line) => /^(Authority|Timestamp)=/.test(line)), "Unexpected media signature authority or timestamp");
  const directories = lines.filter((line) => line.startsWith("CodeDirectory "));
  assert.equal(directories.length, 1, "Missing or ambiguous media CodeDirectory");
  const flags = directories[0].match(/\bflags=0x([a-f0-9]+)\b/i);
  assert(flags && (parseInt(flags[1], 16) & 0x10000) !== 0, "Media runtime must use hardened runtime");
  assert(lines.some((line) => /^Hash type=sha256 size=32$/.test(line)), "Media signature must use SHA-256");
}

export function validateEmbeddedMediaSignature(binaryBytes, parsed) {
  assert.equal(parsed.codeSignatures.length, 1, "Media runtime must have exactly one embedded signature");
  const { offset, size } = parsed.codeSignatures[0];
  assert.equal(offset + size, binaryBytes.length, "Media signature must seal the end of the runtime");
  assert.equal(binaryBytes.readUInt32BE(offset), 0xfade0cc0, "Invalid embedded media signature SuperBlob");
  const blobLength = binaryBytes.readUInt32BE(offset + 4);
  assert(blobLength >= 12 && blobLength <= size, "Embedded media signature length mismatch");
  const count = binaryBytes.readUInt32BE(offset + 8);
  assert(count > 0 && count <= Math.floor((blobLength - 12) / 8), "Invalid embedded media signature index");
  let codeDirectory;
  const slots = new Set(), ranges = [];
  for (let index = 0; index < count; index++) {
    const type = binaryBytes.readUInt32BE(offset + 12 + index * 8);
    const relative = binaryBytes.readUInt32BE(offset + 16 + index * 8);
    assert(!slots.has(type), "Duplicate embedded media signature slot");
    slots.add(type);
    assert(relative >= 12 + count * 8 && relative + 8 <= blobLength, "Invalid embedded media signature slot range");
    const length = binaryBytes.readUInt32BE(offset + relative + 4);
    assert(length >= 8 && relative + length <= blobLength, "Truncated embedded media signature slot");
    assert(ranges.every((range) => relative + length <= range.start || relative >= range.end), "Overlapping embedded media signature slots");
    ranges.push({ start: relative, end: relative + length });
    if (type === 0) codeDirectory = binaryBytes.subarray(offset + relative, offset + relative + length);
    if (type === 0x10000) assert.equal(length, 8, "CMS-signed media runtime is unsupported");
  }
  assert(codeDirectory && codeDirectory.length >= 44, "Missing media CodeDirectory");
  assert.equal(codeDirectory.readUInt32BE(0), 0xfade0c02, "Invalid media CodeDirectory");
  assert.equal(codeDirectory.readUInt32BE(12) & 0x10002, 0x10002, "Embedded media signature must be ad-hoc and hardened");
  assert.equal(codeDirectory.readUInt32BE(32), offset, "Media CodeDirectory must cover all pre-signature bytes");
  assert.equal(codeDirectory[36], 32, "Media CodeDirectory requires SHA-256 hash size");
  assert.equal(codeDirectory[37], 2, "Media CodeDirectory requires SHA-256 hash type");
  const identifierOffset = codeDirectory.readUInt32BE(20);
  assert(identifierOffset >= 44 && identifierOffset < codeDirectory.length, "Invalid media signature identifier offset");
  const terminator = codeDirectory.indexOf(0, identifierOffset);
  assert(terminator > identifierOffset, "Unterminated media signature identifier");
  assert.equal(codeDirectory.toString("utf8", identifierOffset, terminator), `com.kocpy.media.ffmpeg.${parsed.architecture}`, "Embedded media signature identifier mismatch");
  // codesign reserves aligned signature space. Its unused allocation must be
  // zero-filled; it remains part of the independently frozen full-file digest.
  assert(binaryBytes.subarray(offset + blobLength, offset + size).every((byte) => byte === 0), "Nonzero media signature padding");
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
    const parsed = validateMachOBinary(binaryBytes, arch, info.dynamicLibraries);
    validateEmbeddedMediaSignature(binaryBytes, parsed);
    if (process.platform === "darwin") {
      // Verify every included architecture's signature without executing it.
      // Cross-CPU functional tests remain separate from signature validation.
      execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], { stdio: "pipe" });
      const signature = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", binary], { encoding: "utf8" });
      assert.equal(signature.status, 0, `Media signature inspection failed: ${arch}`);
      validateMediaSignatureDetails((signature.stdout || "") + (signature.stderr || ""), arch);
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
    results.push({ arch, sha256: info.sha256, unsignedSha256: info.unsignedSha256, license: info.license });
  }
  return results;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  console.log(JSON.stringify(await verifyMediaRuntime(process.argv[2]), null, 2));
