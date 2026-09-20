import type { BackupTask } from "../types";
import { APP_VERSION } from "../../common/version";
import os from "node:os";
import path from "node:path";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Legacy MHL-compatible inventory. ASC MHL export is delegated to the official reference tool when installed. */
const manifestPath = (task: BackupTask, relativePath: string, destinationIndex?: number) => {
  if (destinationIndex === undefined) return relativePath.replaceAll("\\", "/");
  const destination = task.destinations[destinationIndex],
    root = destination?.resolvedPath || destination?.path,
    copy = task.fileRecords
      .find((file) => file.relativePath === relativePath)
      ?.destinations.find((item) => root && path.relative(root, item.path) && !path.relative(root, item.path).startsWith(".."));
  return copy && root
    ? path.relative(root, copy.path).replaceAll("\\", "/")
    : relativePath.replaceAll("\\", "/");
};
export function generateMhl(task: BackupTask, destinationIndex?: number) {
  const hashTag = task.hashAlgorithm === "xxhash32" ? "xxhash" : task.hashAlgorithm;
  const entries = task.fileRecords.map((file) => `  <hash><file>${xml(manifestPath(task, file.relativePath, destinationIndex))}</file><size>${file.size}</size><${hashTag}>${file.srcChecksum}</${hashTag}></hash>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mhl version="1.1">\n<creatorinfo><tool>Kocpy</tool><version>${xml(APP_VERSION)}</version></creatorinfo>\n<hashlist>\n${entries}\n</hashlist>\n</mhl>\n`;
}
export function generateAscMhl(task: BackupTask, destinationIndex?: number) {
  if (task.fileRecords.some((file) => !file.ascMhlMd5)) throw new Error("ASC MHL 需要 MD5 清单，请先确保源或已校验副本可读取");
  const created = new Date().toISOString();
  const hashes = task.fileRecords.map((file) => `    <hash><path size="${file.size}">${xml(manifestPath(task, file.relativePath, destinationIndex))}</path><md5 action="original" hashdate="${created}">${file.ascMhlMd5}</md5><metadata><kocpy_task>${xml(task.id)}</kocpy_task></metadata></hash>`).join("\n");
  if (task.inventoryPolicy?.mode === "filtered" && !task.inventoryScope)
    throw new Error("过滤任务缺少冻结的排除范围，不能生成 ASC MHL");
  const filteredPatterns = task.inventoryScope?.exclusions
    .map(
      (item) =>
        `<pattern>${xml(item.relativePath.replaceAll("\\", "/"))}</pattern>`,
    )
    .join("");
  const ignore = !task.inventoryPolicy
    ? "<ignore><pattern>.DS_Store</pattern><pattern>._*</pattern></ignore>"
    : task.inventoryPolicy.mode === "filtered" && filteredPatterns
      ? `<ignore>${filteredPatterns}</ignore>`
      : "";
  const policy = task.inventoryPolicy?.version || "legacy-v1";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<hashlist version="2.0" xmlns="urn:ASC:MHL:v2.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:ASC:MHL:v2.0 ASCMHL.xsd">\n  <creatorinfo><creationdate>${created}</creationdate><hostname>${xml(os.hostname())}</hostname><tool version="${xml(APP_VERSION)}">Kocpy</tool><comment>Verified transfer ${xml(task.name)}</comment></creatorinfo>\n  <processinfo><process>transfer</process>${ignore}</processinfo>\n  <hashes>\n${hashes}\n  </hashes>\n  <metadata><kocpy_status>${xml(task.status)}</kocpy_status><kocpy_inventory_policy>${xml(policy)}</kocpy_inventory_policy></metadata>\n</hashlist>\n`;
}
