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

  it("keeps the in-app guide title independent from the release number", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain("KOCPY · QUICK START");
    expect(appSource).toContain("<h2>软件使用说明</h2>");
    expect(appSource).toContain('version: "0.1.39"');
    expect(appSource).toContain('title: "界面边界与折叠更新记录"');
    expect(appSource).toContain('version: "0.1.38"');
    expect(appSource).toContain('version: "0.1.31"');
    expect(appSource).toContain('<details className="help-release-item"');
    expect(appSource).not.toMatch(
      /<details className="help-release-item"[^>]*\bopen\b/,
    );
    expect(appSource).not.toContain("KOCPY {APP_VERSION} · QUICK START");
  });

  it("keeps settings feedback and card selectors inside visible boundaries", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
        .source,
      composerSource = rendererSources.find(
        ({ name }) => name === "Composer.tsx",
      )!.source;
    expect(appSource).toContain('className="settings-panel-meta"');
    expect(appSource).toContain('className="settings-save-status" role="status"');
    expect(composerSource).toContain('className="mode-card-icon"');
    expect(composerSource).toContain('className="selection-indicator"');
    expect(composerSource).toContain("card-action-icon");
    expect(css).toMatch(
      /\.manual-path \.btn\.icon\s*\{[^}]*border-color:\s*var\(--border\)/s,
    );
    expect(css).toMatch(
      /\.card-action-icon\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s,
    );
  });

  it("keeps template management collapsed by default and open while editing", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain(
      'window.sessionStorage.getItem("kocpy-templates-expanded") === "true"',
    );
    expect(appSource).toContain('disabled={Boolean(templateEditor)}');
    expect(appSource).toContain('disabledReason="请先保存或关闭正在编辑的模板"');
    expect(appSource).toContain('setTemplatesExpanded(true)');
  });

  it("keeps automatic PDF reports enabled by default and configurable per task", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
        .source,
      composerSource = rendererSources.find(
        ({ name }) => name === "Composer.tsx",
      )!.source,
      storageSource = fs.readFileSync(
        path.resolve("src/main/storage.ts"),
        "utf8",
      ),
      mainSource = fs.readFileSync(path.resolve("src/main/index.ts"), "utf8");
    expect(storageSource).toContain("automaticPdf: true");
    expect(mainSource).toContain("...defaultSettings");
    expect(mainSource).toContain("automaticPdf: settings.automaticPdf !== false");
    expect(appSource).toContain("<h3>完成后自动生成 PDF</h3>");
    expect(appSource).toContain('aria-label="默认自动生成 PDF"');
    expect(composerSource).toContain("composerDefaultsFromSettings(settings)");
    expect(composerSource).toContain(
      "useState(initialDefaults.automaticPdf)",
    );
    expect(composerSource).toContain("本任务不自动生成 PDF 报告");
  });

  it("wires mixed-day delivery only from verified project task details", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
        .source,
      dialogSource = rendererSources.find(
        ({ name }) => name === "MixedDayDeliveryDialog.tsx",
      )!.source;
    expect(appSource).toContain("<MixedDayDeliveryDialog");
    expect(appSource).toContain("selected.projectId &&");
    expect(appSource).toContain("taskTrustState(selected).contentVerified");
    expect(appSource).toContain("destination.verified && destination.resolvedPath");
    expect(appSource).toContain("日期归属与当日交付");
    expect(dialogSource).toContain("完整素材卷和原始清单始终保持不变");
    expect(dialogSource).toContain("不替代正式备份证据");
  });

  it("offers re-verification for complete-v2 empty inventories only", () => {
    const appSource = rendererSources.find(({ name }) => name === "App.tsx")!
      .source;
    expect(appSource).toContain("export const canReverifyTask");
    expect(appSource.match(/\{canReverifyTask\([^)]*\) && \(/g)).toHaveLength(2);
    expect(appSource).not.toContain("{task.totalFiles > 0 && (");
    expect(appSource).not.toContain("{selected.fileRecords.length > 0 && (");
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
