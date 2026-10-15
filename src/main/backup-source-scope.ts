import { detectBackupSelectionMarker } from "./backup-selection-marker";

/** A complete copy of a derivative directory does not restore the omitted card.
 * Descendants are limited to successfully scanned directories; ancestors are
 * checked only for direct reserved declarations, not sibling material trees.
 * Pruned subtrees retain their inventory exclusions and safety consequences. */
export async function assertBackupSourceScope(root: string, directories: string[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if ((await detectBackupSelectionMarker(root, { relativeDirectories: directories, signal })).detected)
    throw new Error("此来源含选定范围备份或当日交付标记，不是原始整卡，不能建立新的整卡备份记录。需要原样转存此目录，请使用“独立归档转存（NAS / 已挂载目录）”；需要接续管理，请导入原工作站包保留范围证据。不要删除标记或修改原始清单。");
}
