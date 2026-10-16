import type { ExistingReanalysisResult } from "../../main/types";

/** New refreshes preserve human mappings; older results retain their explicit
 * legacy explanation. Neither branch hides deduplication or manifest risk. */
export function existingRefreshConfirmation(analysis: ExistingReanalysisResult): string {
  const metadata = analysis.metadataNote?.trim() || (analysis.metadataPreserved
    ? "保留已确认的拍摄归属日、设备、机位和卷名；只有显式核对映射后才可修改"
    : `将修正 ${analysis.metadataUpdated} 条目录元数据`);
  return `检测到 ${analysis.importedTasks} 条接管记录；${metadata}${metadata.endsWith("。") ? "" : "。"}将合并 ${analysis.duplicatesFound} 条重复素材卷记录，并移除 ${analysis.aggregateRecordsFound} 条误生成的日期/设备父级汇总记录。已读取 ${analysis.manifestsInspected} 份卡卷清单，其中 ${analysis.manifestDifferences} 份存在真实的路径或大小差异；另有 ${analysis.baselinesNeeded} 条记录仍需建立基线${analysis.unavailableSources ? `，${analysis.unavailableSources} 个来源当前离线，将保留原记录` : ""}。刷新只整理 Kocpy 记录并按清单元数据核对，不重新计算文件哈希、不移动或删除素材文件。`;
}
