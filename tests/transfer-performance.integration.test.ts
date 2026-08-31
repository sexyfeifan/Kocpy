import { expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { BackupTask } from "../src/main/types";

it.skipIf(process.env.KOCPY_TRANSFER_BENCH !== "1")("measures isolated copy and full readback separately (not a Finder benchmark)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-transfer-bench-"));
  const source = path.join(root, "source");
  try {
    await fs.mkdir(source);
    const block = Buffer.alloc(4 * 1024 * 1024, 0x65);
    for (let i = 0; i < 4; i++) {
      const file = await fs.open(path.join(source, `clip-${i}.bin`), "wx");
      try { for (let n = 0; n < 16; n++) await file.write(block); await file.sync(); }
      finally { await file.close(); }
    }
    const results: unknown[] = [];
    for (let trial = 0; trial < 6; trial++) {
      const legacyPrehash = trial % 2 === 0;
      const destination = path.join(root, `destination-${trial}`);
      await fs.mkdir(destination);
      const engine = new BackupEngine();
      // Exercise the retained pre-hash algorithm without changing production options.
      if (legacyPrehash) vi.spyOn(engine as any, "canStreamSource").mockResolvedValue(false);
      const task = engine.createTask({
        name: "benchmark", sourcePath: source, destinationPaths: [destination],
        namingTemplate: "benchmark", devices: [], shootingDate: "", hashAlgorithm: "sha256",
        copyMode: "mirror", generateThumbnails: false,
      });
      const start = performance.now();
      let copyMs = 0;
      engine.on("progress", (event) => { if (event.status === "verifying" && !copyMs) copyMs = performance.now() - start; });
      const done = new Promise<BackupTask>((resolve) => engine.once("settled", resolve));
      engine.startTask(task.id);
      const result = await done;
      expect(result.status, `${result.errorMessage}: ${JSON.stringify(result.destinations.map((item) => item.error))}`).toBe("completed");
      expect(result.destinations.every((item) => item.verified)).toBe(true);
      const totalMs = performance.now() - start;
      results.push({ trial: trial + 1, mode: legacyPrehash ? "pre-hash-then-copy" : "hash-during-copy", files: result.totalFiles, bytes: result.totalBytes, copyMs: Math.round(copyMs), verifyMs: Math.round(totalMs - copyMs), totalMs: Math.round(totalMs) });
    }
    process.stdout.write(`KOCPY_TRANSFER_BENCH ${JSON.stringify({ architecture: process.arch, results })}\n`);
  } finally {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
