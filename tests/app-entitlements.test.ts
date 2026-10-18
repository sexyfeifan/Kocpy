import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { parseRequiredEntitlements, verifyAppEntitlements, REQUIRED_ENTITLEMENTS: keys } = require("../scripts/verify-app-entitlements.cjs");
const plist = (value = "<true/>", extra = "") => `<?xml version="1.0"?><plist version="1.0"><dict>${keys.map((key: string) => `<key>${key}</key>${value}`).join("")}${extra}</dict></plist>`;

describe("actual signed application entitlement values", () => {
  it("requires exact boolean true, not a key name or truthy string", () => {
    expect(parseRequiredEntitlements(plist())[keys[0]]).toBe(true);
    for (const value of ["<false/>", "<string>true</string>", "<integer>1</integer>", "<array><true/></array>"])
      expect(() => parseRequiredEntitlements(plist(value))).toThrow();
    expect(() => parseRequiredEntitlements('<plist version="1.0"><dict/></plist>')).toThrow();
    expect(() => parseRequiredEntitlements(plist("<true/>", `<key>${keys[0]}</key><true/>`))).toThrow("Duplicate");
    expect(() => parseRequiredEntitlements('<plist><dict>broken')).toThrow();
  });
  it("reads the signed app after strict verification, never the signing-input resource plist", () => {
    const run = vi.fn().mockReturnValueOnce("").mockReturnValueOnce(plist());
    verifyAppEntitlements("/synthetic/Kocpy.app", { execFileSync: run });
    expect(run.mock.calls[0][1]).toEqual(["--verify", "--deep", "--strict", "--verbose=2", "/synthetic/Kocpy.app"]);
    expect(run.mock.calls[1][1]).toEqual(["-d", "--entitlements", "-", "--xml", "/synthetic/Kocpy.app"]);
    expect(() => verifyAppEntitlements("/synthetic/ffmpeg", { execFileSync: run })).toThrow();
  });
});
