import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function fixture() {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "kocpy-media-cli-"));
  const inputs = path.join(root, "inputs");
  await mkdir(inputs);
  const builder = path.join(inputs, "build-media-runtime.mjs");
  await copyFile("scripts/build-media-runtime.mjs", builder);
  await copyFile("scripts/media-source-lock.json", path.join(inputs, "media-source-lock.json"));
  const linkedBuilder = path.join(root, "linked-build.mjs");
  const linkedVerifier = path.join(root, "linked-verify.mjs");
  await symlink(builder, linkedBuilder);
  await symlink(path.resolve("scripts/verify-media-runtime.mjs"), linkedVerifier);
  return { root, builder, linkedBuilder, linkedVerifier };
}

function rejectedCommand(script: string, argument: string) {
  try {
    execFileSync(process.execPath, [script, argument], { encoding: "utf8", stdio: "pipe" });
    throw new Error("Expected command rejection");
  } catch (error) {
    const result = error as Error & { status?: number; stderr?: string; stdout?: string };
    expect(result.status).toBe(1);
    expect(result.stdout || "").toBe("");
    return String(result.stderr);
  }
}

it("runs the builder through temporary-directory aliases and symlinks instead of silently succeeding", async () => {
  const { root, builder, linkedBuilder } = await fixture();
  try {
    for (const script of [builder, linkedBuilder])
      expect(rejectedCommand(script, "invalid-architecture")).toContain("Usage on macOS");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("runs the verifier through an aliased symlink and rejects unavailable media", async () => {
  const { root, linkedVerifier } = await fixture();
  try {
    expect(rejectedCommand(linkedVerifier, path.join(root, "missing-media"))).toContain("ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "darwin")("actually verifies standalone corresponding sources through both entry paths", async () => {
  const { root, builder, linkedBuilder } = await fixture();
  try {
    for (const script of [builder, linkedBuilder])
      expect(execFileSync(process.execPath, [script, "arm64", path.resolve("resources/ffmpeg/sources"), "--verify-sources"], { encoding: "utf8", stdio: "pipe" })).toContain("Standalone corresponding sources verified");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("actually verifies the complete media runtime when the CLI path is a symlink", async () => {
  const { root, linkedVerifier } = await fixture();
  try {
    const result = JSON.parse(execFileSync(process.execPath, [linkedVerifier, path.resolve("resources/ffmpeg")], { encoding: "utf8", stdio: "pipe" }));
    expect(result.map((runtime: { arch: string }) => runtime.arch).sort()).toEqual(["arm64", "x64"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("imports both tools without starting a build or runtime check", async () => {
  const { root, builder, linkedVerifier } = await fixture();
  try {
    const before = await readdir(root);
    const code = `await import(${JSON.stringify(pathToFileURL(builder).href)}); await import(${JSON.stringify(pathToFileURL(linkedVerifier).href)}); console.log("import-ok");`;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8", stdio: "pipe" })).toBe("import-ok\n");
    expect(await readdir(root)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
