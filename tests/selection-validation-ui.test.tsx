import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectionValidationProgress } from "../src/renderer/src/TransferEvidence";
import type { BackupTask } from "../src/main/types";

describe("selection validation is visible but never claimed as copied bytes", () => {
  const task = { status: "running", transferredBytes: 0, copyProgress: 0, selectionValidation: {
    stage: "before-copy", phase: "validating", completedFiles: 2, totalFiles: 6,
    completedBytes: 4096, totalBytes: 8192, currentFile: "MEDIA/long_source_path.mp4", speedBps: 2048,
  } } as BackupTask;
  it("renders the real full-source counts, read speed and current file", () => {
    const html = renderToStaticMarkup(<SelectionValidationProgress task={task} />);
    expect(html).toContain("复制前范围复核");
    expect(html).toContain("2 / 6 个文件");
    expect(html).toContain("2 KB/s");
    expect(html).toContain("MEDIA/long_source_path.mp4");
    expect(html).toContain("不是复制进度");
    expect(html).toContain('value="50"');
    expect(task.copyProgress).toBe(0);
  });
  it("hides stale speed on pause and all telemetry after stopping", () => {
    const paused = renderToStaticMarkup(<SelectionValidationProgress task={{ ...task, status: "paused" }} />);
    expect(paused).toContain("已暂停"); expect(paused).not.toContain("2 KB/s");
    for (const status of ["completed", "failed", "cancelled"] as const)
      expect(renderToStaticMarkup(<SelectionValidationProgress task={{ ...task, status }} />)).toBe("");
  });
});
