import type { ArchiveTransferTaskSummary } from "../src/main/archive-transfer";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const task = (
  id: string,
  status: ArchiveTransferTaskSummary["status"],
  reportStatus: ArchiveTransferTaskSummary["reportStatus"],
) => ({ id, status, reportStatus }) as ArchiveTransferTaskSummary;

describe("archive transfer result visibility", () => {
  it("keeps every unresolved task visible before paginated completed history", async () => {
    vi.stubGlobal("window", { api: {} });
    const { visibleArchiveTransferTasks } = await import(
      "../src/renderer/src/ArchiveTransferPanel"
    );
    const tasks = [
      ...Array.from({ length: 12 }, (_, index) =>
        task(`done-${index}`, "completed", "completed"),
      ),
      task("interrupted", "interrupted", "pending"),
      task("report-failed", "completed", "failed"),
    ];

    const firstPage = visibleArchiveTransferTasks(tasks, 8);
    expect(firstPage.map((item) => item.id).slice(0, 2)).toEqual([
      "interrupted",
      "report-failed",
    ]);
    expect(firstPage).toHaveLength(10);
    expect(firstPage.some((item) => item.id === "interrupted")).toBe(true);
    expect(firstPage.some((item) => item.id === "report-failed")).toBe(true);
    expect(visibleArchiveTransferTasks(tasks, 16)).toHaveLength(14);
  });
});
