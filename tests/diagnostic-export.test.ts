import { describe, expect, it } from "vitest";
import { sanitizeDiagnosticExport } from "../src/main/diagnostic-export";
describe("diagnostic export privacy", () => {
  it("does not leak absolute or relative paths through free-form errors, operators, nested health evidence or keys", () => {
    const value = {
      app: { name: "Kocpy", version: "0.1.50" },
      timeline: [
        {
          phase: "portable-project",
          level: "warning",
          message: "ENOENT: /Volumes/SYNTHETIC-PRIVATE/project/card.mov",
          operator: "合成姓名",
        },
      ],
      archiveHealth: {
        issues: [
          { path: "DCIM/private-name.mov", error: "private-name.mov differs" },
        ],
        "/private/key.json": "secret",
      },
      privacy: "prior claim",
    };
    const result = JSON.stringify(sanitizeDiagnosticExport(value));
    for (const text of [
      "SYNTHETIC-PRIVATE",
      "private-name",
      "合成姓名",
      "/private/key.json",
      "prior claim",
    ])
      expect(result).not.toContain(text);
    expect(result).toContain("portable-project");
    expect(result).toContain("0.1.50");
    expect(value.timeline[0].operator).toBe("合成姓名");
  });
  it("preserves counts, timing and status for diagnosis, while keeping stable anonymous references", () => {
    const value = {
      status: "failed",
      totalFiles: 123,
      at: 42,
      error: "repeated private path",
      detail: "repeated private path",
    };
    const result = sanitizeDiagnosticExport(value) as typeof value;
    expect(result.status).toBe("failed");
    expect(result.totalFiles).toBe(123);
    expect(result.at).toBe(42);
    expect(result.error).toBe(result.detail);
    expect(result.error).not.toBe(value.error);
  });
});
