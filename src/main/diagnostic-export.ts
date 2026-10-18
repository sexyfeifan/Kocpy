import { createHash } from "node:crypto";
const fingerprint = (v: string) =>
  `[已脱敏:${createHash("sha256").update(v).digest("hex").slice(0, 12)}]`;
const enumKeys = new Set([
  "status",
  "phase",
  "code",
  "severity",
  "action",
  "platform",
  "arch",
  "filesystem",
  "type",
  "algorithm",
  "version",
  "release",
]);
/** Local diagnostics keep actionable detail; exported free text cannot carry
 * source paths/operator names through error strings or nested recovery data. */
export function sanitizeDiagnosticExport(value: unknown): unknown {
  function visit(v: unknown, key = ""): unknown {
    if (typeof v === "string") {
      if (enumKeys.has(key) && /^[a-zA-Z0-9_.:+ -]{1,100}$/.test(v)) return v;
      return fingerprint(v);
    }
    if (Array.isArray(v)) return v.map((item) => visit(item));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [
          /[/\\\x00-\x1f]/.test(k) ? fingerprint(k) : k,
          visit(item, k),
        ]),
      );
    return v;
  }
  return {
    ...(visit(value) as Record<string, unknown>),
    privacy:
      "导出仅保留统计、状态代码与自由文本摘要标识；路径、文件名、操作人与错误详情已脱敏。完整原因请在本机查看，分享前仍应自行复核。",
  };
}
