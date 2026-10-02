import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
it("puts disabled proxy fieldset inside a shrinking scroll owner, not the scrolling fieldset itself", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const css = readFileSync("src/renderer/src/style.css", "utf8");
  const dialog = app.slice(app.indexOf("function ProxyDialog("));
  expect(dialog).toContain('<div className="form-body proxy-form-scroll">');
  expect(dialog).toContain('<fieldset disabled={busy || !!result}');
  expect(dialog).not.toContain('<fieldset className="form-body"');
  expect(css).toMatch(/\.proxy-form-scroll\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1 1 auto;[^}]*overflow:\s*auto/s);
});
