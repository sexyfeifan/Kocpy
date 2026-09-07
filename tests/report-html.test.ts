import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryReportHtml } from "../src/main/report-html";

describe("temporary report HTML", () => {
  it("loads a large report from a private file and removes it immediately", async () => {
    const html = `<!doctype html><title>Kocpy</title>${"x".repeat(5 * 1024 * 1024)}`;
    let file = "";
    await withTemporaryReportHtml(html, async (candidate) => {
      file = candidate;
      const stat = await fs.stat(candidate);
      expect(stat.mode & 0o077).toBe(0);
      expect(stat.size).toBe(Buffer.byteLength(html));
      expect(path.basename(candidate)).toBe("report.html");
      const loaded = await fs.readFile(candidate, "utf8");
      expect(loaded.startsWith("<!doctype html>"));
      expect(loaded.endsWith("xxx"));
    });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes private report data when loading fails", async () => {
    let file = "";
    await expect(
      withTemporaryReportHtml("private report", async (candidate) => {
        file = candidate;
        throw new Error("synthetic load failure");
      }),
    ).rejects.toThrow("synthetic load failure");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(file))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
