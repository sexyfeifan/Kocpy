import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LatestReleaseNote } from "../src/renderer/src/LatestReleaseNote";
import { APP_VERSION } from "../src/common/version";

const css = fs.readFileSync("src/renderer/src/style.css", "utf8");

describe("current help and bounded page layout", () => {
  it("shows exactly one installed-version summary and keeps it collapsed", () => {
    const html = renderToStaticMarkup(<LatestReleaseNote />);
    expect(html).toContain('aria-label="当前版本更新"');
    expect(html.match(/<details\b/g)).toHaveLength(1);
    expect(html.match(/\d+\.\d+\.\d+/g)).toEqual([APP_VERSION]);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).toContain("备份、校验与恢复规则不变");
    expect(html).not.toContain("未发布候选");
  });
  it("centers settings and switches to two bounded columns only on wide windows", () => {
    expect(css).toMatch(/\.settings-layout\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*max-width: 920px;[^}]*margin-inline: auto;/s);
    expect(css).toMatch(/@media \(min-width: 1600px\)\s*\{\s*\.settings-layout\s*\{[^}]*max-width: 1560px;[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(css).toMatch(/\.settings-layout > :not\(\.settings-panel\)\s*\{[^}]*grid-column: 1 \/ -1;/s);
    expect(css).toMatch(/\.setting-row > div:first-child\s*\{[^}]*min-width: 0;/s);
    expect(css).toMatch(/\.setting-row p\s*\{[^}]*overflow-wrap: anywhere;/s);
  });
  it("insets nested recovery and benchmark cards without hiding long content", () => {
    expect(css).toMatch(/\.recovery-center > \.recovery-summary,[\s\S]*?margin-inline: 22px;/);
    expect(css).toMatch(/\.benchmark-grid\s*\{[^}]*gap: 16px;[^}]*padding: 22px;/s);
    expect(css).toMatch(/\.benchmark-card\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;[^}]*padding: 18px;/s);
    expect(css).toMatch(/\.help-release-item summary strong\s*\{[^}]*white-space: normal;/s);
  });
  it("does not treat read-only inspection as input while retaining recovery consent", () => {
    const dialog = fs.readFileSync("src/renderer/src/RecoveryDialog.tsx", "utf8");
    const interaction = fs.readFileSync("src/renderer/src/Interaction.tsx", "utf8");
    expect(dialog).toContain('data-dirty-tracking="inputs"');
    expect(dialog).toContain('type="checkbox"');
    expect(dialog).toContain("setConfirmed(e.target.checked)");
    expect(dialog).toContain("!confirmed");
    expect(interaction).toContain('document.addEventListener("input", input, true)');
    expect(interaction).toContain('dialog.dataset.dirtyTracking !== "inputs"');
  });
});
