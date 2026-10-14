import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
const { signingMode } = require("../scripts/release-signing.cjs");
it("uses explicit ad-hoc mode without credentials and rejects every partial credential set", () => {
  expect(signingMode({})).toBe("ad-hoc");
  const names = ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"];
  for (const name of names) {
    expect(() => signingMode({ [name]: "private-test-value" })).toThrow("missing secret names");
    try { signingMode({ [name]: "private-test-value" }); } catch (error) { expect(String(error)).not.toContain("private-test-value"); }
  }
  expect(() => signingMode(Object.fromEntries(names.map(name => [name, "fixture-only"])))).toThrow(/Developer ID and notarization are unsupported/);
  expect(() => signingMode({ CSC_LINK: "fixture-only", CSC_KEY_PASSWORD: " " })).toThrow();
  expect(() => signingMode({ CSC_LINK: " " })).toThrow();
});
it("checks the supported signing mode before building either architecture", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  expect(workflow).toContain("node scripts/release-signing.cjs");
  expect(workflow).toContain("-c.mac.identity=-");
  expect(workflow).toContain("-c.mac.notarize=false");
});
