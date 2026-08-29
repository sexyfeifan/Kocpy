import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { benchmarkDirectory, buildDiagnosticSnapshot, recoveryDiagnosis } from "../src/main/diagnostics";
import type { BackupTask } from "../src/main/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const task = (overrides: Partial<BackupTask> = {}): BackupTask => ({ id: "1234567890abcdef", name: "CARD_01", sourcePath: "/Users/example/private/card", devices: ["A"], destinations: [], hashAlgorithm: "sha256", namingTemplate: "CARD_01", status: "failed", totalFiles: 1, completedFiles: 0, totalBytes: 10, transferredBytes: 5, speedBps: 0, eta: 0, currentFile: "", verifyLog: [], fileRecords: [], ...overrides });

describe("0.0.12 diagnostics", () => {
  it("benchmarks and removes its temporary file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-benchmark-")); roots.push(root);
    const result = await benchmarkDirectory(root, 8);
    expect(result.bytes).toBe(8 * 1024 * 1024);
    expect(result.writeBps).toBeGreaterThan(0);
    expect(result.readBps).toBeGreaterThan(0);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it("classifies paused, offline and partial recovery states", () => {
    expect(recoveryDiagnosis(task({ status: "paused" })).code).toBe("paused");
    expect(recoveryDiagnosis(task({ destinations: [{ id: "d", path: "/d", label: "D", verified: false, bytesWritten: 0, available: false }] })).code).toBe("destination-offline");
    expect(recoveryDiagnosis(task()).code).toBe("partial");
  });
  it("does not expose full private paths in diagnostic snapshots", () => {
    const snapshot = buildDiagnosticSnapshot({ version: "0.0.12", tasks: [task()], volumes: [], benchmarks: [] });
    expect(JSON.stringify(snapshot)).not.toContain("/Users/example/private");
    expect(snapshot.tasks[0].source).toBe("card");
  });
});
