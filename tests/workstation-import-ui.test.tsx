import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceImportPreview } from "../src/main/types";

afterEach(() => vi.unstubAllGlobals());

const preview: WorkspaceImportPreview = {
  previewId: "preview-1",
  fileName: "DIT-A.kocpy-workspace.json",
  packageSha256: "a".repeat(64),
  source: {
    workstationId: "11111111-1111-4111-8111-111111111111",
    displayName: "DIT-A",
    exportId: "22222222-2222-4222-8222-222222222222",
    exportedAt: 1,
    legacy: false,
  },
  localRevision: 7,
  localDigest: "b".repeat(64),
  localExchangeDigest: "c".repeat(64),
  alreadyImported: false,
  summary: {
    projectsAdded: 1,
    tasksAdded: 2,
    templatesAdded: 0,
    archiveRecordsAdded: 0,
    exactDuplicates: 3,
    conflicts: 1,
    remoteTaskTombstones: 0,
    remoteProjectTombstones: 0,
  },
  conflicts: [
    {
      id: "conflict-1",
      kind: "project-field",
      entityType: "project",
      entityId: "project-1",
      label: "测试项目 · name",
      field: "name",
      localSummary: "本机名称",
      incomingSummary: "外部名称",
      defaultDecision: "local",
      consequence: "默认保留本机字段。",
    },
  ],
  warnings: ["工作站包只合并 Kocpy 元数据。"],
};

describe("0.1.31 workstation import UI", () => {
  it("renders a read-only preview with local selected by default and explicit authorization", async () => {
    vi.stubGlobal("window", { api: {} });
    const { WorkstationImportDialog } =
      await import("../src/renderer/src/WorkstationImportDialog");
    const html = renderToStaticMarkup(
      <WorkstationImportDialog
        preview={preview}
        defaultOperator=""
        onClose={() => undefined}
        onApplied={() => undefined}
      />,
    );
    expect(html).toContain("这是只读预检结果");
    expect(html).toContain("保留本机（默认）");
    expect(html).toContain("采用外部");
    expect(html).toContain("实际操作人");
    expect(html).toContain("本次只合并 Kocpy 元数据");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("全部采用外部");
    const localRadio = html.match(
      /<input type="radio" name="conflict-1" checked=""\/>/,
    );
    expect(localRadio).toBeTruthy();
  });

  it("keeps package selection as preview-only in the maintenance entry point", () => {
    const source = fs.readFileSync("src/renderer/src/App.tsx", "utf8");
    expect(source).toContain("预检工作站包");
    expect(source).toContain("setWorkspaceImport(preview)");
    expect(source).toContain("本机稳定工作站 ID；主机改名不会改变此身份");
    expect(source).toContain("工作站合并审计");
    expect(source).not.toContain("一键全部采用外部");
  });
});
