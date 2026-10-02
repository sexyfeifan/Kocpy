import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = "Usage: npm run test:proxy-acceptance -- --app /absolute/Kocpy.app --result /absolute/new-result.json [--keep-fixtures] [--plan]";
try {
  let app = "", result = "", keep = false, plan = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app") app = args[++i] || "";
    else if (args[i] === "--result") result = args[++i] || "";
    else if (args[i] === "--keep-fixtures") keep = true;
    else if (args[i] === "--plan") plan = true;
    else if (args[i] === "--help") { console.log(usage); process.exit(0); }
    else throw Error("Unknown option");
  }
  if (!path.isAbsolute(app) || !app.endsWith(".app") || !path.isAbsolute(result)) throw Error("Absolute app and result paths required");
  const binary = path.join(app, "Contents/MacOS/Kocpy"), resources = path.join(app, "Contents/Resources");
  if (!existsSync(binary) || !existsSync(path.join(resources, "app.asar"))) throw Error("Packaged Kocpy app required");
  if (existsSync(result)) throw Error("Result already exists; never overwritten");
  if (path.relative(app, result) === "" || !path.relative(app, result).startsWith("..") && !path.isAbsolute(path.relative(app, result))) throw Error("Result cannot be inside tested application");
  if (plan) { console.log(JSON.stringify({ generatedFixturesOnly: true, applicationReadOnly: true, resultOverwrite: false, keepsFixtures: keep, nleImportExecuted: false, physicalStorageExecuted: false })); process.exit(0); }
  const architecture = spawnSync("lipo", ["-archs", binary], { encoding: "utf8" });
  const packagedArch = architecture.stdout.trim() === "arm64" ? "arm64" : architecture.stdout.trim() === "x86_64" ? "x64" : undefined;
  if (architecture.status !== 0 || !packagedArch) throw Error("Single supported packaged architecture required");
  const mediaRuntime = path.join(resources, "ffmpeg", `ffmpeg-darwin-${packagedArch}`);
  if (!existsSync(mediaRuntime)) throw Error("Packaged FFmpeg missing; development fallback forbidden");
  if (spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" }).status !== 0) throw Error("Application signature structure check failed");
  const version = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")], { encoding: "utf8" });
  if (version.status !== 0) throw Error("Application version could not be read");
  const payloadSha256 = createHash("sha256").update(await fs.readFile(path.join(resources, "app.asar"))).digest("hex");
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-acceptance-"));
  try {
    const script = path.join(work, "verify.cjs");
    const built = spawnSync(path.join(repo, "node_modules/.bin/esbuild"), ["scripts/verify-proxy-delivery.ts", "--bundle", "--platform=node", "--format=cjs", `--outfile=${script}`], { cwd: repo, encoding: "utf8" });
    if (built.status !== 0) throw Error("Fixture verifier build failed");
    const run = spawnSync(binary, [script], { cwd: repo, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 ** 2, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", KOCPY_KEEP_PROXY_DELIVERY: keep ? "1" : "0" } });
    if (run.status !== 0) throw Error(`Proxy acceptance failed: ${String(run.stderr).slice(-3000)}`);
    const evidence = JSON.parse(run.stdout.trim().split("\n").at(-1));
    if (evidence.arch !== packagedArch) throw Error("Runtime architecture differs from packaged application");
    const mediaSha256 = createHash("sha256").update(await fs.readFile(mediaRuntime)).digest("hex");
    await fs.writeFile(result, JSON.stringify({ checkedAt: new Date().toISOString(), applicationVersion: version.stdout.trim(), payloadSha256, mediaSha256, verifierScope: "current-source-against-packaged-media-runtime", ...evidence, fixtureScope: "generated-only", fixturesRetained: keep, nleImportExecuted: false, physicalStorageExecuted: false }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ passed: true, result, retainedDelivery: keep ? evidence.delivery : undefined }));
  } finally { await fs.rm(work, { recursive: true, force: true }); }
} catch (error) { console.error(`${error.message}\n${usage}`); process.exitCode = 1; }
