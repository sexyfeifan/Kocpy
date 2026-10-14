import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { destinationSelectionNotice, destinationNoticeClassName } from "../src/renderer/src/destination-selection-notice";

afterEach(() => vi.unstubAllGlobals());

async function editorMarkup(requiredCopies: number) {
  vi.stubGlobal("window", { api: {} });
  const { ProjectEditor } = await import("../src/renderer/src/ProjectEditor");
  return renderToStaticMarkup(<ProjectEditor
    initial={{ id: "synthetic-project", name: "Synthetic", devices: ["A"], requiredCopies, destinationPaths: ["/synthetic/backup"] }}
    onClose={() => {}}
    onSave={async () => {}}
  />);
}

describe("destination configuration guidance", () => {
  it("honors a one-copy project without suggesting a second destination or claiming success", () => {
    const input = Object.freeze({ mode: "project" as const, requiredCopies: 1, destinationCount: 1 });
    const notice = destinationSelectionNotice(input);
    expect(notice.tone).toBe("neutral");
    expect(notice.message).toContain("项目要求 1 份物理独立校验副本，已选 1 个目的地");
    expect(notice.message).not.toMatch(/建议另存|再保存一份|已达标|已通过/);
    expect(notice.message).toContain("逐文件校验与存储关系核对完成后");
    expect(notice.storageEvidence).toBe("pending");
    expect(destinationNoticeClassName(notice)).toBe("notice");
    expect(input.requiredCopies).toBe(1);
  });

  it.each([
    { required: 1, selected: 0, missing: 1 },
    { required: 2, selected: 0, missing: 2 },
    { required: 2, selected: 1, missing: 1 },
    { required: 4, selected: 0, missing: 4 },
    { required: 4, selected: 1, missing: 3 },
    { required: 4, selected: 2, missing: 2 },
  ])("states the configured shortfall for $required required and $selected selected", ({ required, selected, missing }) => {
    const notice = destinationSelectionNotice({ mode: "project", requiredCopies: required, destinationCount: selected });
    expect(notice.tone).toBe("warning");
    expect(notice.message).toContain(`项目要求 ${required} 份`);
    expect(notice.message).toContain(`已选 ${selected} 个目的地`);
    expect(notice.message).toContain(`目的地数量还差 ${missing} 个`);
    expect(notice.selection).toBe(selected === 0 ? "missing" : "below-project-requirement");
    expect(destinationNoticeClassName(notice)).toBe("notice amber");
    expect(notice.storageEvidence).toBe("pending");
  });

  it.each([
    { required: 1, selected: 2 },
    { required: 2, selected: 2 },
    { required: 4, selected: 4 },
  ])("keeps storage evidence unresolved when quantity reaches $required", ({ required, selected }) => {
    const notice = destinationSelectionNotice({ mode: "project", requiredCopies: required, destinationCount: selected });
    expect(notice.tone).toBe("neutral");
    expect(notice.message).toContain("目的地数量不等于物理独立副本数");
    expect(notice.message).not.toMatch(/已达标|独立性通过|目的地数量还差|建议另存/);
    expect(notice.storageEvidence).toBe("pending");
    expect(destinationNoticeClassName(notice)).not.toMatch(/completed|success|green|amber|error/);
  });

  it("preserves the existing two-copy default instead of deriving a requirement from selected paths", () => {
    const notice = destinationSelectionNotice({ mode: "project", destinationCount: 1 });
    expect(notice.message).toContain("项目要求 2 份");
    expect(notice.message).toContain("目的地数量还差 1 个");
    expect(notice.tone).toBe("warning");
  });

  it("shows an ordinary one-target recommendation as neutral guidance independently of project state", () => {
    const notice = destinationSelectionNotice({ mode: "ordinary", destinationCount: 1, requiredCopies: 4 });
    expect(notice.tone).toBe("neutral");
    expect(notice.title).toContain("建议");
    expect(notice.message).toContain("此建议不影响是否可开始");
    expect(notice.message).toContain("引擎预检判断");
    expect(notice.message).not.toContain("项目要求");
    expect(destinationNoticeClassName(notice)).toBe("notice");
  });

  it("distinguishes an ordinary missing target from two selected paths with unknown physical relationships", () => {
    const missing = destinationSelectionNotice({ mode: "ordinary", destinationCount: 0 });
    expect(missing.tone).toBe("warning");
    expect(missing.message).toContain("请先选择至少一个备份目的地");
    const selected = destinationSelectionNotice({ mode: "ordinary", destinationCount: 2 });
    expect(selected.tone).toBe("neutral");
    expect(selected.storageEvidence).toBe("pending");
    expect(selected.message).toContain("存储关系核对完成后");
    expect(selected.message).not.toMatch(/已达标|独立副本已满足/);
  });

  it("renders the editor's one-copy configuration with the shared neutral model", async () => {
    const markup = await editorMarkup(1);
    expect(markup).toContain('class="notice" role="note" aria-label="项目副本配置"');
    expect(markup).toContain("项目要求 1 份物理独立校验副本，已选 1 个目的地");
    expect(markup).toContain("选择备份路径不会改变项目要求的安全副本数量");
    expect(markup).not.toContain('class="notice amber" role="note" aria-label="项目副本配置"');
  });

  it("keeps neutral guidance and amber shortfalls tied to the current theme's color variables", () => {
    const css = readFileSync("src/renderer/src/style.css", "utf8");
    const neutral = css.match(/\.notice,\s*\.error-box,\s*\.success-box\s*\{([^}]+)\}/)?.[1];
    expect(neutral).toContain("color: var(--muted)");
    expect(css).toMatch(/\.notice\.amber\s*\{[^}]*color:\s*var\(--amber\)/);
    for (const root of [":root", ':root[data-theme="light"]']) {
      const selector = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const variables = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1];
      expect(variables).toContain("--muted:");
      expect(variables).toContain("--amber:");
    }
  });

  it("renders a one-root, two-required project as a configuration shortfall and retains the chosen requirement", async () => {
    const markup = await editorMarkup(2);
    expect(markup).toContain('class="notice amber" role="note" aria-label="项目副本配置"');
    expect(markup).toContain("项目要求 2 份物理独立校验副本，已选 1 个目的地，目的地数量还差 1 个");
    expect(markup).toContain('value="2" selected=""');
  });
});
