import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Storage } from "../src/main/storage";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { generateReport } from "../src/main/backup/ReportGenerator";
describe("Persistence and reports", () => {
  it("serializes concurrent writes and recovers the previous valid snapshot", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-store-"));
    try {
      const store = new Storage(dir);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.write("tasks.json", { value: i }),
        ),
      );
      expect(await store.read("tasks.json", {})).toEqual({ value: 19 });
      await fs.writeFile(path.join(dir, "tasks.json"), "{broken");
      expect(await store.read("tasks.json", {})).toEqual({ value: 18 });
      expect((await fs.readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual(
        [],
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("escapes untrusted file names and labels a failed report honestly", async () => {
    const t = new BackupEngine().createTask({
      name: "name",
      namingTemplate: "name",
      sourcePath: "/tmp/source",
      destinationPaths: ["/tmp/dest"],
      devices: [],
      hashAlgorithm: "sha256",
      shootingDate: "",
    });
    t.status = "failed";
    t.name = "<script>alert(1)</script>";
    const html = (await generateReport(t)).toString();
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("备份失败");
  });
});
