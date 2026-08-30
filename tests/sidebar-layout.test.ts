import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("sidebar layout", () => {
  const stylesheet = fs.readFileSync(
    path.resolve(process.cwd(), "src/renderer/src/style.css"),
    "utf8",
  );

  it("keeps navigation proportions and scrolls its own content", () => {
    expect(stylesheet).toMatch(/\.sidebar\s*>\s*nav\s*\{[^}]*overflow-y:\s*auto/s);
    expect(stylesheet).toMatch(/\.nav-item\s*\{[^}]*font-size:\s*12px/s);
    expect(stylesheet).not.toMatch(/@media\s*\(max-height:/);
  });
});
