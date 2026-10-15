import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = fs.readFileSync(path.resolve("src/renderer/src/style.css"), "utf8");
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "m"));
  expect(match, `missing rule ${selector}`).not.toBeNull();
  return match![1];
};

// These guards cover the spacing regressions; rendered/native-window review is
// still required to validate the final desktop layout and interaction states.
describe("project and form spacing regressions", () => {
  it("insets both edges of the filled project summary and separates coverage", () => {
    const summary = rule(".project-summary");
    expect(summary).toContain("padding: 14px 16px");
    expect(summary).toContain("margin-bottom: 12px");
    expect(summary).toContain("gap: 8px 14px");
    expect(summary).toContain("flex-wrap: wrap");
  });

  it("uses the card's width for reflow and keeps overrides after base rules", () => {
    expect(rule(".project-card")).toContain("container: project-card / inline-size");
    const metrics = css.indexOf("@container project-card (max-width: 350px)");
    const actions = css.indexOf("@container project-card (max-width: 310px)");
    expect(metrics).toBeGreaterThan(css.indexOf(".coverage-metrics {"));
    expect(actions).toBeGreaterThan(css.indexOf(".project-card-actions {"));
    expect(css.slice(metrics, actions)).toContain("repeat(2, minmax(0, 1fr))");
    expect(css.slice(actions, actions + 150)).toContain("grid-template-columns: 1fr");
    expect(rule(".project-card-actions .btn")).toContain("font-size: 12px");
    expect(rule(".project-card-actions .btn svg")).toContain("width: 16px");
    expect(rule(".project-card-actions .btn")).not.toMatch(/\n\s*height:/);
  });

  it("allows long project names, device tags and metric values to wrap", () => {
    for (const selector of [
      ".project-card h2",
      ".project-card > small",
      ".chips span",
      ".coverage-metrics span",
      ".project-card-actions .btn > span",
    ]) expect(rule(selector)).toContain("overflow-wrap: anywhere");
    expect(rule(".coverage-metrics")).toContain("repeat(4, minmax(0, 1fr))");
    expect([...css.matchAll(/^\.project-coverage\s*\{/gm)]).toHaveLength(1);
    expect([...css.matchAll(/^\.import-preview\s*\{/gm)]).toHaveLength(1);
  });

  it("wraps dense action rows instead of scrolling or clipping controls", () => {
    for (const selector of [
      ".template-card-actions",
      ".directory-picker",
      ".path-input-row",
      ".mixed-day-confirm-row",
      ".mixed-day-review-tools",
    ]) {
      expect(rule(selector), selector).toContain("flex-wrap: wrap");
      expect(rule(selector), selector).not.toMatch(/overflow[^;]*:\s*(hidden|auto)/);
    }
    expect(rule(".form-grid")).toContain("repeat(2, minmax(0, 1fr))");
    expect(rule(".form-grid > *")).toContain("min-width: 0");
  });

  it("adapts the composer form to space remaining beside its summary", () => {
    expect(rule(".composer-main")).toContain("container: composer-fields / inline-size");
    const compact = css.indexOf("@container composer-fields (max-width: 520px)");
    expect(compact).toBeGreaterThan(css.indexOf(".form-grid {"));
    expect(css.slice(compact, compact + 180)).toContain("grid-template-columns: 1fr");
    expect(rule(".maintenance-center")).toContain("display: grid");
    expect(css).toContain("@container maintenance (max-width: 640px)");
  });
});
