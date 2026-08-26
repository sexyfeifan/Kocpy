import type { BackupTask } from "../types";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Legacy MHL-compatible inventory. ASC MHL export is delegated to the official reference tool when installed. */
export function generateMhl(task: BackupTask) {
  const entries = task.fileRecords.map((file) => `  <hash><file>${xml(file.relativePath)}</file><size>${file.size}</size><${task.hashAlgorithm}>${file.srcChecksum}</${task.hashAlgorithm}></hash>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<mhl version="1.1">\n<creatorinfo><tool>Kocpy</tool><version>0.0.1</version></creatorinfo>\n<hashlist>\n${entries}\n</hashlist>\n</mhl>\n`;
}
