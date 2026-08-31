// Rebuild the separately executed FFmpeg CLI from the exact corresponding sources.
// No system installation, source patches, nonfree components or Homebrew linkage.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDirectory, "..");
const arch = process.argv[2];
if (process.platform !== "darwin" || !["arm64", "x64"].includes(arch))
  throw new Error("Usage on macOS: node scripts/build-media-runtime.mjs arm64|x64 [source-archive-directory]");
// Both repository scripts/ and the standalone corresponding-source sources/
// directory carry this lock beside the script. No checkout is needed for a kit.
const lockPath = path.join(scriptDirectory, "media-source-lock.json");
const lock = JSON.parse(await readFile(lockPath, "utf8"));
const sourceDir = path.resolve(process.argv[3] || (existsSync(path.join(scriptDirectory, lock.ffmpeg.archive)) ? scriptDirectory : path.join(repo, "resources/ffmpeg/sources")));
for (const component of [lock.ffmpeg, lock.x264, lock.nasm]) {
  const digest = createHash("sha256").update(await readFile(path.join(sourceDir, component.archive))).digest("hex");
  if (digest !== component.sha256) throw new Error(`Source checksum mismatch: ${component.archive}`);
}
if (process.argv.includes("--verify-sources")) {
  console.log("Standalone corresponding sources verified");
  process.exit(0);
}
const build = await mkdtemp(path.join(os.tmpdir(), `kocpy-media-${arch}-`));
const prefix = path.join(build, "prefix"), toolPrefix = path.join(build, "tools");
const output = path.join(repo, "work/media-built", arch);
await mkdir(output, { recursive: true });
console.log(`Build directory: ${build}`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const jobs = Math.max(1, Math.min(4, os.cpus().length));
function run(command, args, cwd, env = process.env) {
  console.log(command, ...args);
  return execFileSync(command, args, { cwd, env, stdio: "inherit" });
}
for (const component of [lock.ffmpeg, lock.x264, lock.nasm]) {
  const archive = path.join(sourceDir, component.archive);
  if (sha256(await readFile(archive)) !== component.sha256)
    throw new Error(`Source checksum mismatch: ${component.archive}`);
  run("tar", ["-xf", archive, "-C", build], build);
}
// NASM is a build-time tool only. Building it here keeps SIMD enabled on x64
// without installing anything into the host's system directories.
const nasm = path.join(build, lock.nasm.directory);
run("./configure", [`--prefix=${toolPrefix}`], nasm);
run("make", [`-j${jobs}`], nasm);
run("make", ["install"], nasm);

const cpu = arch === "arm64" ? "arm64" : "x86_64";
const sdk = execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
const cflags = `-arch ${cpu} -isysroot ${sdk} -mmacosx-version-min=12.0`;
const env = {
  ...process.env, PATH: `${toolPrefix}/bin:${process.env.PATH}`,
  CC: `clang ${cflags}`, CFLAGS: cflags, LDFLAGS: cflags,
  PKG_CONFIG_PATH: "", PKG_CONFIG_LIBDIR: `${prefix}/lib/pkgconfig`,
};
const x264Args = [
  `--prefix=${prefix}`, `--host=${cpu}-apple-darwin`, "--enable-static", "--enable-pic",
  "--disable-cli", "--disable-opencl", "--disable-avs", "--disable-lavf",
  "--disable-ffms", "--disable-swscale",
];
const x264 = path.join(build, lock.x264.directory);
run("./configure", x264Args, x264, env);
run("make", [`-j${jobs}`], x264, env);
run("make", ["install-lib-static"], x264, env);

const ffmpegArgs = [
  `--prefix=${prefix}`, "--target-os=darwin", `--arch=${cpu}`, "--enable-cross-compile",
  "--cc=clang", `--extra-cflags=${cflags} -I${prefix}/include`,
  `--extra-ldflags=${cflags} -L${prefix}/lib`, "--pkg-config-flags=--static",
  "--disable-autodetect", "--enable-gpl", "--disable-nonfree", "--enable-libx264",
  "--enable-static", "--disable-shared", "--disable-debug", "--disable-doc",
  "--disable-ffplay", "--disable-ffprobe", "--disable-network",
  "--enable-videotoolbox", "--enable-audiotoolbox", "--enable-zlib", "--enable-bzlib",
];
const ffmpeg = path.join(build, lock.ffmpeg.directory);
run("./configure", ffmpegArgs, ffmpeg, env);
run("make", [`-j${jobs}`, "ffmpeg"], ffmpeg, env);
const binary = path.join(output, `ffmpeg-darwin-${arch}`);
await copyFile(path.join(ffmpeg, "ffmpeg"), binary);
const license = execFileSync(binary, ["-hide_banner", "-L"], { encoding: "utf8" });
if (/nonfree|not legally redistributable/i.test(license) || !/GNU General Public License/.test(license))
  throw new Error("Unexpected or non-redistributable FFmpeg license");
const libraries = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
for (const line of libraries.trim().split("\n").slice(1))
  if (!/^\s+\/(usr\/lib|System\/Library)\//.test(line))
    throw new Error(`Non-system shared library dependency: ${line}`);
const normal = (value) => value.replaceAll(build, "<BUILD>").replaceAll(sdk, "<SDK>");
await writeFile(path.join(output, "build-info.json"), JSON.stringify({
  schemaVersion: 1, architecture: arch, ffmpeg: lock.ffmpeg.version,
  x264: lock.x264.version, license: "GPL-2.0-or-later", sha256: sha256(await readFile(binary)),
  sourceLockSha256: sha256(await readFile(lockPath)),
  compiler: execFileSync("clang", ["--version"], { encoding: "utf8" }).split("\n")[0],
  sdkVersion: execFileSync("xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" }).trim(),
  x264Configure: x264Args.map(normal), ffmpegConfigure: ffmpegArgs.map(normal),
  dynamicLibraries: libraries.trim().split("\n").slice(1).map((line) => line.trim()),
}, null, 2) + "\n");
for (const file of ["COPYING.GPLv2", "COPYING.LGPLv2.1", "LICENSE.md"])
  await copyFile(path.join(ffmpeg, file), path.join(output, `FFmpeg-${file}`));
await copyFile(path.join(x264, "COPYING"), path.join(output, "x264-COPYING"));
console.log(`Built and inspected: ${binary}`);
console.log("Temporary build tree retained for inspection:", build);
