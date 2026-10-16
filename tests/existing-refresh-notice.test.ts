import { describe, expect, it } from "vitest";
import type { ExistingReanalysisResult } from "../src/main/types";
import { existingRefreshConfirmation } from "../src/renderer/src/existing-refresh-notice";

const result: ExistingReanalysisResult = {
  importedTasks: 10, metadataUpdated: 3, baselinesNeeded: 2,
  duplicatesFound: 4, duplicatesMerged: 0, rootsDeduplicated: 0,
  unavailableSources: 1, aggregateRecordsFound: 5, aggregateRecordsRemoved: 0,
  manifestDifferences: 6, manifestsInspected: 7, devicesDetected: [], applied: false,
};

describe("existing refresh confirmation preserves mapping and shows all risk", () => {
  it("prefers the backend's preservation explanation without dropping other actions or risk", () => {
    const text = existingRefreshConfirmation({ ...result, metadataPreserved: true, metadataNote: "保留人工确认的日期、设备、机位、卷名，仅显式核对映射可改" });
    expect(text).toContain("保留人工确认的日期、设备、机位、卷名，仅显式核对映射可改");
    expect(text).not.toContain("将修正 3 条目录元数据");
    for (const phrase of ["合并 4 条重复素材卷", "移除 5 条误生成的日期/设备父级汇总", "读取 7 份卡卷清单", "6 份存在真实的路径或大小差异", "2 条记录仍需建立基线", "1 个来源当前离线，将保留原记录", "不重新计算文件哈希", "不移动或删除素材文件"]) expect(text).toContain(phrase);
  });

  it("uses a truthful safe fallback when preservation is known but the note is empty", () => {
    const text = existingRefreshConfirmation({ ...result, metadataPreserved: true, metadataNote: "  " });
    expect(text).toContain("保留已确认的拍摄归属日、设备、机位和卷名");
    expect(text).not.toContain("将修正 3");
  });

  it("keeps legacy metadata-change wording only for older results without preservation metadata", () => {
    expect(existingRefreshConfirmation(result)).toContain("将修正 3 条目录元数据");
  });
});
