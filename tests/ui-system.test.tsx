import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { X } from "lucide-react";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { Badge, Button, Empty } from "../src/renderer/src/Ui";
import { modalDialogSelector } from "../src/common/dialog";

const rendererRoot = path.resolve("src/renderer/src");
const rendererFiles = fs
  .readdirSync(rendererRoot)
  .filter((name) => name.endsWith(".tsx"));
const rendererSources = rendererFiles.map((name) => ({
  name,
  source: fs.readFileSync(path.join(rendererRoot, name), "utf8"),
}));
const css = fs.readFileSync(path.join(rendererRoot, "style.css"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

describe("0.1.25 shared UI contract", () => {
  it("keeps reusable controls independent from the application root", () => {
    for (const { name, source } of rendererSources.filter(
      ({ name }) => name !== "App.tsx" && name !== "main.tsx",
    )) {
      expect(source, name).not.toMatch(/from ["']\.\/App["']/);
    }
  });

  it("gives icon controls an accessible name and dialog-close marker", () => {
    const close = renderToStaticMarkup(
      <Button kind="icon" title="关闭任务详情">
        <X />
      </Button>,
    );
    expect(close).toContain('type="button"');
    expect(close).toContain('aria-label="关闭任务详情"');
    expect(close).toContain('data-dialog-close="true"');
    const disabled = renderToStaticMarkup(<Button disabled>继续</Button>);
    expect(disabled).toContain('aria-disabled="true"');
    expect(disabled).toContain("当前条件尚未满足");
  });

  it("exposes status and empty states without decorative icon noise", () => {
    expect(renderToStaticMarkup(<Badge status="completed" />)).toContain(
      'aria-label="校验通过"',
    );
    const empty = renderToStaticMarkup(
      <Empty title="暂无任务" detail="从新建备份开始" />,
    );
    expect(empty).toContain('role="status"');
    expect(empty).toContain('aria-hidden="true"');
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain('role={toast.error ? "alert" : "status"}');
  });

  it("includes both normal and destructive modal dialogs in the focus scope", () => {
    expect(modalDialogSelector).toContain('[role="dialog"]');
    expect(modalDialogSelector).toContain('[role="alertdialog"]');
    const tags = rendererSources.flatMap(({ source }) =>
      [...source.matchAll(/<(?:section|div)\b[^>]*\brole="(?:dialog|alertdialog)"[^>]*>/gs)].map(
        (match) => match[0],
      ),
    );
    expect(tags.length).toBeGreaterThan(8);
    for (const tag of tags) {
      expect(tag).toContain('aria-modal="true"');
      expect(tag).toMatch(/aria-(?:label|labelledby)=/);
    }
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain("data-return-focus-id");
    expect(appSource).toContain("data-focus-id");
  });

  it("defines theme-safe design aliases and stable responsive controls", () => {
    for (const token of [
      "--line: var(--border)",
      "--accent: var(--purple)",
      "--warning: var(--amber)",
      "--control-height: 38px",
      "--dialog-radius: 16px",
    ])
      expect(css).toContain(token);
    expect(css).toMatch(/\.wizard-steps\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.modal-footer[\s\S]*?flex-wrap:\s*wrap/);
    expect(css).toMatch(
      /@media \(max-width: 1200px\)[\s\S]*?\.detail-stats\s*\{[^}]*repeat\(2/s,
    );
  });

  it("keeps motion subtle, dependency-free and removable for reduced motion", () => {
    for (const token of [
      "--motion-fast: 120ms",
      "--motion-standard: 180ms",
      "--motion-slow: 260ms",
      "--ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1)",
    ])
      expect(css).toContain(token);
    expect(css).toContain("@keyframes page-enter");
    expect(css).toContain("@keyframes modal-enter");
    expect(css).toContain("@keyframes toast-enter");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/,
    );
    expect(Object.keys(packageJson.dependencies || {})).not.toContain("gsap");
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain('<main key={page} className="page-content">');
  });

  it("keeps native form controls named by a label or accessibility attribute", () => {
    const failures: string[] = [];
    for (const { name, source } of rendererSources) {
      const file = ts.createSourceFile(
        name,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxOpeningElement(node) ||
          ts.isJsxSelfClosingElement(node)
        ) {
          const tag = node.tagName.getText(file);
          if (["input", "select", "textarea"].includes(tag)) {
            const attributes = node.attributes.properties.filter(
              ts.isJsxAttribute,
            );
            const names = new Set(
              attributes.map((attribute) => attribute.name.getText(file)),
            );
            const type = attributes
              .find((attribute) => attribute.name.getText(file) === "type")
              ?.initializer?.getText(file);
            const id = attributes
              .find((attribute) => attribute.name.getText(file) === "id")
              ?.initializer?.getText(file)
              .replace(/^['"]|['"]$/g, "");
            const linkedByLabel = Boolean(
              id && source.includes(`htmlFor="${id}"`),
            );
            let parent: ts.Node | undefined = node.parent;
            let wrappedByLabel = false;
            while (parent) {
              if (
                ts.isJsxElement(parent) &&
                parent.openingElement.tagName.getText(file) === "label"
              ) {
                wrappedByLabel = true;
                break;
              }
              parent = parent.parent;
            }
            if (
              type !== '"hidden"' &&
              !wrappedByLabel &&
              !linkedByLabel &&
              !names.has("aria-label") &&
              !names.has("aria-labelledby")
            ) {
              const line = file.getLineAndCharacterOfPosition(node.getStart(file));
              failures.push(`${name}:${line.line + 1} <${tag}>`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(failures).toEqual([]);
  });
});
