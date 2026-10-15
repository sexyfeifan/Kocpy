import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackupSelectionEvidence } from "../src/renderer/src/BackupSelectionEvidence";
import { TransferEvidence } from "../src/renderer/src/TransferEvidence";
import { ModalNotices } from "../src/renderer/src/ModalNotices";
import type { BackupTask } from "../src/main/types";
import type { BackupSelectionPlan } from "../src/common/backup-selection";
import { taskTrustState } from "../src/common/task-trust";

const sourceFiles = Array.from({ length: 6 }, (_, index) => ({ relativePath: `Video/2026101${index}_关联素材.mov`, size: 10, sha256: "a".repeat(64), mtimeMs: 1, ctimeMs: 1, dev: 1, ino: index + 1 }));
const plan: BackupSelectionPlan = {
  schemaVersion: 1, id: "synthetic-plan", sourcePath: "/synthetic/source", requiredCopies: 1, generatedAt: 1,
  sourceRootBinding: { dev: 1, ino: 1 }, sourceVolumeIdentity: { id: "synthetic", uuid: "synthetic", name: "synthetic", device: "synthetic-disk" }, digest: "a".repeat(64),
  sourceScope: { capturedAt: 1, sourcePath: "/synthetic/source", fingerprint: "a".repeat(64), includedFiles: 6, includedBytes: 60, includedDirectories: 1, includedDirectoryPaths: ["Video"], excludedFiles: 0, excludedDirectories: 0, excludedBytes: 0, exclusions: [],
    policy: { version: "complete-v2", mode: "complete", createdAt: 1, includeHidden: true, includeAppleDouble: true, includeSystemMetadata: true, includeEmptyDirectories: true, symlinkPolicy: "fail", specialFilePolicy: "fail" } },
  sourceFiles, includedPaths: sourceFiles.slice(2).map(file => file.relativePath),
  selectedDates: ["2026-10-15"], assignedDates: {}, operator: "合成操作者 <不得执行>", confirmedAt: 1,
  wholeCardCovered: false,
  excludedFiles: sourceFiles.slice(0, 2).map((file, index) => ({ relativePath: file.relativePath, groupId: `group-${index}`, reason: index ? "history-verified" : "user-date", historyEvidence: [] })),
  groups: sourceFiles.slice(0, 2).map((file, index) => ({ id: `group-${index}`, label: `关联组 ${index + 1}`, files: 1, bytes: 10, relativePaths: [file.relativePath], suggestedDate: "2026-10-14", candidateDates: ["2026-10-14"], basis: "path-date", confidence: "review", mandatory: false, historyState: "not-found", historyCopies: 0, historyEvidence: [], evidence: ["路径日期建议，经用户选择确认"] })),
};
function task(status: BackupTask["status"] = "running"): BackupTask {
  return { id: "synthetic-ui-task", name: "Synthetic", sourcePath: "/synthetic/source", devices: [], destinations: [],
    hashAlgorithm: "sha256", namingTemplate: "Synthetic", status, totalFiles: 4, completedFiles: 4,
    totalBytes: 40, transferredBytes: 40, copyProgress: 100, verifyProgress: 100, speedBps: 0, eta: 0,
    currentFile: "", verifyLog: [], fileRecords: [], selection: structuredClone(plan) };
}

describe("read-only selected-scope UI evidence", () => {
  it("shows full-source, selected, omitted and separately protected counts without mutating evidence", () => {
    const selected = task(), before = JSON.stringify(selected), html = renderToStaticMarkup(<BackupSelectionEvidence task={selected} />);
    for (const text of ["完整源已扫描", "6 个文件", "本次纳入", "4 个文件", "未复制", "2 个文件", "历史已验证", "未保护", "1 个文件", "选定范围 · 非整卡副本", "不得据此格式化源素材卡"])
      expect(html).toContain(text);
    expect(JSON.stringify(selected)).toBe(before);
    expect(html).not.toMatch(/<(input|select|textarea|button)\b/);
  });

  it("keeps details collapsed but exposes dates, operator, each excluded path and association evidence", () => {
    const html = renderToStaticMarkup(<BackupSelectionEvidence task={task()} />);
    expect(html).toContain('<details class="selection-evidence-details">');
    expect(html).not.toContain(" open=");
    expect(html).toContain("2026-10-15");
    expect(html).toContain("合成操作者 &lt;不得执行&gt;");
    expect(html).not.toContain("<不得执行>");
    for (const file of plan.excludedFiles) expect(html).toContain(file.relativePath);
    expect(html).toContain("关联组 1");
    expect(html).toContain("路径日期建议，经用户选择确认");
    expect(html).toContain("用户未选择该日期；未证明此文件已受保护");
    expect(html).toContain("历史副本预检已读取核对；未复制到本次目的地");
    expect(html).toContain("系统目录和无权限条目另列于扫描排除");
  });

  it.each(["running", "paused", "verifying", "completed"] as const)("retains partial warning and zero countable copies in %s transfer evidence", status => {
    const selected = task(status), before = taskTrustState(selected), html = renderToStaticMarkup(<TransferEvidence task={selected} compact />);
    expect(html).toContain("选定范围备份 · 本次未复制 2 个文件");
    expect(html).toContain("不计整卡达标副本");
    expect(taskTrustState(selected)).toEqual(before);
    expect(before.countableCopies).toBe(0);
  });

  it("does not label a whole-source selection as partial, and ordinary tasks have no new decision card", () => {
    const selected = task(); selected.selection!.includedPaths = sourceFiles.map(file => file.relativePath);
    selected.selection!.excludedFiles = []; selected.selection!.wholeCardCovered = true;
    const html = renderToStaticMarkup(<BackupSelectionEvidence task={selected} />);
    expect(html).toContain("全部已扫描文件");
    expect(html).toContain("本次日期选择没有排除已扫描文件");
    expect(html).not.toContain("选定范围 · 非整卡副本");
    expect(renderToStaticMarkup(<TransferEvidence task={selected} />)).not.toContain("选定范围备份 · 本次未复制");
    selected.selection = undefined;
    expect(renderToStaticMarkup(<BackupSelectionEvidence task={selected} />)).toBe("");
  });

  it("integrates selection evidence separately from system scan exclusions", () => {
    const app = fs.readFileSync(path.resolve("src/renderer/src/App.tsx"), "utf8");
    expect(app).toContain("<BackupSelectionEvidence task={selected} />");
    expect(app).not.toContain("此冻结范围没有记录排除条目。");
    expect(app).toContain("日期筛选未复制内容请查看上方备份范围记录");
  });

  it("retains notice content exactly once and lays modal notices in normal flow instead of over the footer", () => {
    const html = renderToStaticMarkup(<ModalNotices><div role="status">保留风险<button>查看详情</button><button>关闭</button></div></ModalNotices>);
    expect(html.match(/保留风险/g)).toHaveLength(1);
    expect(html).toContain("查看详情"); expect(html).toContain("关闭");
    const css = fs.readFileSync(path.resolve("src/renderer/src/modal-notices.css"), "utf8");
    expect(css).toContain(".modal-notices .toast, .modal-notices .completion-banner { position: static");
    expect(css).toContain("grid-template-columns: 18px minmax(0, 1fr) 30px");
    expect(css).toContain("max-height: min(30vh, 220px)");
    expect(css).toMatch(/\.modal-notices-host\s*\{[^}]*flex:\s*0 0 auto;[^}]*max-height:\s*min\(30vh, 220px\);[^}]*overflow-y:\s*auto/);
    expect(css).not.toMatch(/\.modal-notices-host\s*\{[^}]*flex:\s*0 1 auto/);
    expect(css).not.toMatch(/font-size|text-overflow:\s*ellipsis/);
  });

  it("wraps long trust badges and file range labels without clipping project rows", () => {
    const css = fs.readFileSync(path.resolve("src/renderer/src/backup-selection-evidence.css"), "utf8");
    expect(css).toContain("minmax(0, 1.6fr)");
    expect(css).toContain("overflow: visible; text-overflow: clip; white-space: normal");
    expect(css).toContain(".project-task-breakdown .task-state-actions .badge { min-width: 0; max-width: 100%; white-space: normal");
    expect(css).not.toContain("font-size: 10px");
  });
});
