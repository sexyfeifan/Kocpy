import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const entitlements = readFileSync("resources/entitlements.mac.plist", "utf8");
const afterPack = readFileSync("scripts/after-pack.cjs", "utf8");
const candidateBuilder = readFileSync("scripts/build-macos-candidate.cjs", "utf8");

describe("macOS candidate packaging safety", () => {
  it("ad-hoc signs every local non-notarized package instead of skipping signing", () => {
    for (const name of ["pack", "dist", "pack:arm64", "pack:x64", "dist:arm64", "dist:x64"]) {
      expect(packageJson.scripts[name]).toContain("build-macos-candidate.cjs");
    }
    expect(candidateBuilder).toContain("'-c.mac.identity=-'");
    expect(candidateBuilder).toContain("codesign', ['--verify', '--deep', '--strict'");
    expect(workflow).toContain("-c.mac.identity=-");
    expect(workflow).toContain("Build ad-hoc signed candidate DMG");
    expect(workflow).toContain("codesign --verify --deep --strict");
  });

  it("builds local candidates outside synced project storage before copying verified results", () => {
    expect(candidateBuilder).toContain("mkdtempSync(path.join(tmpdir(), 'kocpy-macos-candidate-'))");
    expect(candidateBuilder).toContain("-c.directories.output=${temporaryOutput}");
    expect(candidateBuilder).toContain("verbatimSymlinks: true");
    expect(candidateBuilder).toContain("'candidate-builds', packageVersion");
    expect(candidateBuilder).toContain("symlinkSync(localDestination, destination, 'dir')");
  });

  it("keeps Electron hardened-runtime entitlements explicit", () => {
    expect(packageJson.build.mac.entitlements).toBe("resources/entitlements.mac.plist");
    expect(packageJson.build.mac.entitlementsInherit).toBe("resources/entitlements.mac.plist");
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
  });

  it("removes only generated bundle metadata before signing", () => {
    expect(afterPack).toContain("execFileSync('/usr/bin/xattr', ['-cr', app])");
  });
});
