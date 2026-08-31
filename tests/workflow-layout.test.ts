import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve("src/renderer/src/style.css"), "utf8");

// Structural regression guards; visual acceptance is also performed in Electron.
describe("workflow layout guardrails", () => {
  it("caps form width on full-screen displays without scaling text", () => {
    expect(css).toMatch(
      /\.maintenance-center,\s*\.proxy-queue-panel\s*\{[^}]*max-width: 1480px;/s,
    );
  });
  it("insets scope controls and closeout rows instead of touching panel edges", () => {
    expect(css).toMatch(
      /\.proxy-scope-toolbar\s*\{[^}]*gap: 10px;[^}]*padding: 22px;/s,
    );
    expect(css).toMatch(
      /\.proxy-scope-toolbar label\s*\{[^}]*width: min\(100%, 360px\)/s,
    );
    expect(css).toMatch(
      /\.daily-closeout-list\s*\{[^}]*padding: 14px 22px 20px;/s,
    );
    expect(css).toMatch(
      /\.daily-closeout-list button\s*\{[^}]*minmax\(0, 1fr\)/s,
    );
  });

  it("aligns buttons to controls, and wraps fields without shrinking type", () => {
    expect(css).toMatch(
      /\.lifecycle-tools\s*\{[^}]*flex-wrap: wrap;[^}]*align-items: end;/s,
    );
    expect(css).toMatch(
      /\.lifecycle-controls \.btn,[\s\S]*?\.proxy-delivery-actions \.btn\s*\{[^}]*align-self: end;/,
    );
    expect(css).toMatch(/\.handoff-row > \.btn\s*\{[^}]*justify-self: start;/s);
    expect(css).toMatch(
      /@media \(max-width: 1200px\)\s*\{\s*\.checklist-fields\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s,
    );
    expect(css).toMatch(/\.checklist-signoff\s*\{[^}]*gap: 10px;/s);
  });
});
