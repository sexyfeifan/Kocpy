import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Arch } from "builder-util";
const { MEDIA_SIGN_IGNORE, requireCandidateMediaSigning, verifySignedMediaApp } = require("../scripts/media-signing-policy.cjs");

const context = (changes: Record<string, unknown> = {}, arch = Arch.arm64) => ({
  arch,
  appOutDir: "/synthetic-package",
  packager: {
    appInfo: { productFilename: "Kocpy" },
    config: { mac: { identity: "-", notarize: false, signIgnore: MEDIA_SIGN_IGNORE, ...changes } },
  },
});

describe("frozen media signing gate", () => {
  it("allows only exact helper paths in the explicit ad-hoc branch", () => {
    expect(() => requireCandidateMediaSigning(context(), {})).not.toThrow();
    expect(() => requireCandidateMediaSigning(context({ signIgnore: [MEDIA_SIGN_IGNORE] }), {})).not.toThrow();
    const pattern = new RegExp(MEDIA_SIGN_IGNORE);
    for (const arch of ["arm64", "x64"])
      expect(pattern.test(`/synthetic/Kocpy.app/Contents/Resources/ffmpeg/ffmpeg-darwin-${arch}`)).toBe(true);
    for (const file of [
      "/synthetic/Kocpy.app/Contents/MacOS/Kocpy",
      "/synthetic/Kocpy.app/Contents/Resources/ffmpeg/ffmpeg-darwin-arm64.bak",
      "/synthetic/Kocpy.app/Contents/Resources/ffmpeg/other-runtime",
      "/synthetic/Kocpy.app/Contents/Resources/elsewhere/ffmpeg-darwin-x64",
      "/synthetic/Kocpy.app/Contents/Resources/ffmpeg/ffmpeg-darwin-unknown",
    ]) expect(pattern.test(file)).toBe(false);
  });

  it("rejects all broader exclusions, automatic identities and notarization", () => {
    for (const changes of [
      { identity: undefined }, { identity: null }, { identity: "Developer ID Application: fixture" },
      { notarize: true }, { notarize: undefined },
      { signIgnore: undefined }, { signIgnore: "ffmpeg" }, { signIgnore: [] },
      { signIgnore: [MEDIA_SIGN_IGNORE, ".*"] },
    ]) expect(() => requireCandidateMediaSigning(context(changes), {})).toThrow();
    const active = { ...context().packager, platformSpecificBuildOptions: { identity: null, notarize: false, signIgnore: MEDIA_SIGN_IGNORE } };
    expect(() => requireCandidateMediaSigning({ ...context(), packager: active }, {})).toThrow(/Active application identity/);
  });

  it("rejects Developer ID credentials before touching the signed package", async () => {
    const verifyMediaRuntime = vi.fn(), execFileSync = vi.fn();
    const environment = Object.fromEntries(["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"].map(name => [name, "private-test-value"]));
    await expect(verifySignedMediaApp(context(), { verifyMediaRuntime, execFileSync }, environment)).rejects.toThrow(/unsupported/);
    expect(verifyMediaRuntime).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("verifies final bytes before the helper and complete application signatures", async () => {
    const order: string[] = [];
    const verifyMediaRuntime = vi.fn(async () => { order.push("media-digests"); return [{ arch: "arm64" }]; });
    const execFileSync = vi.fn((_command: string, args: string[]) => {
      order.push(args.includes("--entitlements") ? "application-entitlements" : args.includes("--deep") ? "application-signature" : "helper-signature");
      return args.includes("--entitlements") ? '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>' : "";
    });
    await verifySignedMediaApp(context(), { verifyMediaRuntime, execFileSync }, {});
    expect(order).toEqual(["media-digests", "helper-signature", "application-signature", "application-entitlements"]);
    expect(verifyMediaRuntime).toHaveBeenCalledWith("/synthetic-package/Kocpy.app/Contents/Resources/ffmpeg");
    expect(execFileSync).toHaveBeenNthCalledWith(1, "/usr/bin/codesign", ["--verify", "--strict", "/synthetic-package/Kocpy.app/Contents/Resources/ffmpeg/ffmpeg-darwin-arm64"], { stdio: "pipe" });
    expect(execFileSync).toHaveBeenNthCalledWith(2, "/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", "/synthetic-package/Kocpy.app"], expect.objectContaining({ stdio: "pipe", encoding: "utf8" }));
    expect(execFileSync).toHaveBeenNthCalledWith(3, "/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", "/synthetic-package/Kocpy.app"], expect.objectContaining({ encoding: "utf8" }));
  });

  it("blocks post-sign hash changes and does not attempt to repair metadata", async () => {
    const verifyMediaRuntime = vi.fn(async () => { throw new Error("Binary checksum mismatch: arm64"); });
    const execFileSync = vi.fn();
    await expect(verifySignedMediaApp(context(), { verifyMediaRuntime, execFileSync }, {})).rejects.toThrow(/Binary checksum mismatch/);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate and wrong-CPU media after signing", async () => {
    for (const runtimes of [[], [{ arch: "x64" }], [{ arch: "arm64" }, { arch: "x64" }]]) {
      const execFileSync = vi.fn();
      await expect(verifySignedMediaApp(context(), { verifyMediaRuntime: async () => runtimes, execFileSync }, {})).rejects.toThrow();
      expect(execFileSync).not.toHaveBeenCalled();
    }
    await expect(verifySignedMediaApp(context({}, Arch.universal), { verifyMediaRuntime: vi.fn() }, {})).rejects.toThrow(/Unsupported macOS package architecture/);
  });

  it("propagates an unsigned helper or invalid outer application signature", async () => {
    for (const failCall of [1, 2]) {
      let calls = 0;
      const execFileSync = vi.fn(() => { if (++calls === failCall) throw new Error("code object is not signed at all"); });
      await expect(verifySignedMediaApp(context(), { verifyMediaRuntime: async () => [{ arch: "arm64" }], execFileSync }, {})).rejects.toThrow(/not signed/);
      expect(execFileSync).toHaveBeenCalledTimes(failCall);
    }
  });

  it("registers the final read-only gate and exact immutable runtime exclusion", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.build.afterSign).toBe("scripts/after-sign.cjs");
    expect([MEDIA_SIGN_IGNORE, [MEDIA_SIGN_IGNORE]]).toContainEqual(packageJson.build.mac.signIgnore);
  });
});
