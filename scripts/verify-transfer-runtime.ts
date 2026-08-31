// Bundle with esbuild, then execute using each packaged Electron runtime in Node mode.
// All write operations are restricted to this script's own mkdtemp directory.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { BackupEngine, hashFile } from "../src/main/backup/BackupEngine";
import type { BackupTask, HashAlgorithm } from "../src/main/types";
import { volumeIdentity } from "../src/main/system";
import { inspectTaskRecovery } from "../src/main/recovery";

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-runtime-check-"));
  const source = path.join(root, "选中的素材文件夹");
  const cases: string[] = [];
  try {
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "clip.bin"),
      randomBytes(32 * 1024 * 1024),
    );
    await fs.writeFile(path.join(source, "empty.txt"), "");
    for (const algorithm of ["sha256", "sha1", "md5"] as HashAlgorithm[]) {
      const engine = new BackupEngine();
      const destinations = [
        path.join(root, algorithm, "one"),
        path.join(root, algorithm, "two"),
      ];
      for (const destination of destinations)
        await fs.mkdir(destination, { recursive: true });
      const task = engine.createTask({
        name: "runtime",
        sourcePath: source,
        destinationPaths: destinations,
        hashAlgorithm: algorithm,
        namingTemplate: "display-only",
        copyMode: "mirror",
        devices: [],
        shootingDate: "",
        generateThumbnails: false,
      });
      const sourceIdentity = await volumeIdentity(source);
      assert(
        sourceIdentity.uuid,
        "macOS source UUID must be resolved from a child folder",
      );
      task.sourceVolumeUuid = sourceIdentity.uuid;
      task.sourceVolumeId = sourceIdentity.id;
      for (const destination of task.destinations) {
        const identity = await volumeIdentity(destination.path);
        assert(identity.uuid);
        destination.volumeUuid = identity.uuid;
        destination.volumeId = identity.id;
      }
      task.status = "failed";
      task.errorMessage = "磁盘 UUID 已变化，已停止操作";
      const beforeCheck = JSON.stringify(task);
      assert((await inspectTaskRecovery(task)).canRetry);
      assert.equal(
        JSON.stringify(task),
        beforeCheck,
        "inspection must remain read-only",
      );
      let paused = false,
        partialProgress = false;
      const states: string[] = [];
      engine.on("progress", (event) => {
        states.push(event.status);
        if (
          !paused &&
          event.status === "running" &&
          event.copyProgress > 0 &&
          event.copyProgress < 100
        ) {
          partialProgress = true;
          paused = true;
          engine.pauseTask(task.id);
          setTimeout(() => engine.resumeTask(task.id), 30);
        }
      });
      const result = await new Promise<BackupTask>((resolve, reject) => {
        const timeout = setTimeout(() => {
          engine.cancelTask(task.id);
          reject(new Error("runtime check timeout"));
        }, 60_000);
        engine.once("settled", (completed) => {
          clearTimeout(timeout);
          resolve(completed);
        });
        engine.retryFailedDestinations(task.id);
      });
      assert.equal(result.status, "completed", result.errorMessage);
      assert(partialProgress);
      assert(states.includes("paused"));
      for (const destination of result.destinations) {
        assert.equal(destination.verified, true);
        assert.equal(
          destination.resolvedPath,
          await fs.realpath(path.join(destination.path, path.basename(source))),
        );
      }
      for (const record of result.fileRecords) {
        assert.equal(
          record.srcChecksum,
          await hashFile(path.join(source, record.relativePath), algorithm),
        );
        assert.equal(
          record.ascMhlMd5,
          await hashFile(path.join(source, record.relativePath), "md5"),
        );
        assert(
          record.destinations.every((destination) => destination.verified),
        );
      }
      result.errorMessage = "stale offline error";
      for (const destination of result.destinations)
        destination.available = false;
      const reverified = await engine.reverifyTask(task.id);
      assert.equal(reverified.status, "completed", reverified.errorMessage);
      assert.equal(reverified.errorMessage, undefined);
      assert(
        reverified.destinations.every(
          (destination) => destination.available && destination.verified,
        ),
      );
      cases.push(
        `${algorithm}: recorded UUIDs, read-only recovery inspection, retry, mirror root, block progress, pause/resume, two independent readbacks, source+MD5 hashes, reverify stale state cleared`,
      );
    }
    process.stdout.write(
      JSON.stringify({
        arch: process.arch,
        runtime: process.versions,
        cases,
        passed: true,
      }) + "\n",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
