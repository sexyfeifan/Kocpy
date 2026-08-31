import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = (data) => createHash("sha256").update(data).digest("hex");
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
    assert.equal(hash(await readFile(binary)), info.sha256, `Binary checksum mismatch: ${arch}`);
    if (process.platform === "darwin") {
      const actualArch = execFileSync("lipo", ["-archs", binary], { encoding: "utf8" }).trim();
      assert.equal(actualArch, arch === "x64" ? "x86_64" : "arm64");
      const libraries = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
      assert(libraries.trim().split("\n").slice(1).every((line) => /^\s+\/(usr\/lib|System\/Library)\//.test(line)));
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
