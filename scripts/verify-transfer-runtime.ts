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
import { analyzeBackupSelection, finalizeBackupSelection, backupSelectionScope, validateBackupSelectionPlan, applyBackupSelectionInventory } from "../src/main/backup-selection";
import { selectionRuntimeDependencies } from "../src/main/backup-selection-runtime";
import { taskTrustState } from "../src/common/task-trust";
import { detectBackupSelectionMarker } from "../src/main/backup-selection-marker";

async function sourceSnapshot(root: string) {
  const files: Array<[string, string]> = [], directories: string[] = [];
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute);
      assert(!entry.isSymbolicLink(), "synthetic fixture must not contain symlinks");
      if (entry.isDirectory()) { directories.push(relative); await visit(absolute); }
      else { assert(entry.isFile()); files.push([relative, await hashFile(absolute, "sha256")]); }
    }
  }
  await visit(root);
  return { files: files.sort(([a], [b]) => a.localeCompare(b)), directories: directories.sort() };
}

async function selectedRangeRuntime(root: string, cases: string[]) {
  const source = path.join(root, "mixed-dates-source"), deps = selectionRuntimeDependencies();
  // Deliberately synthetic media bytes. Dates come from names, not an assertion
  // that this fixture proves any camera's proprietary metadata support.
  const paths = ["Video/20260101_A001.mov", "Metadata/20260101_A001.xml",
    "Video/20260102_A002.mov", "Metadata/20260102_A002.xml", "Shared/CameraIndex.bin",
    "Audio/20260101_Sound001.wav", ".hidden/sidecar.dat", "original.mhl",
    "PRIVATE/CLIP/20260101_B001.mov", "PRIVATE/INDEX.DAT"];
  for (const relative of paths) {
    const absolute = path.join(source, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, Buffer.from(`Kocpy isolated synthetic fixture: ${relative}\n`.repeat(32)));
  }
  await fs.mkdir(path.join(source, "Empty"));
  const before = await sourceSnapshot(source);
  for (const partial of [true, false]) {
    const preview = await analyzeBackupSelection({ sourcePath: source }, deps);
    const plan = await finalizeBackupSelection(preview, {
      selectedDates: partial ? ["2026-01-02"] : ["2026-01-01", "2026-01-02"],
      operator: "Synthetic runtime operator", allowUnprotectedExclusions: partial,
    }, deps);
    const excluded = new Set(partial ? ["Video/20260101_A001.mov", "Metadata/20260101_A001.xml"] : []);
    assert.deepEqual(new Set(plan.excludedFiles.map((file) => file.relativePath)), excluded);
    assert.equal(plan.wholeCardCovered, !partial);
    assert(plan.includedPaths.includes("Audio/20260101_Sound001.wav"), "unproven sound/video dependencies must be retained");
    assert(plan.includedPaths.includes("PRIVATE/CLIP/20260101_B001.mov"), "camera packages must not split by date");
    const engine = new BackupEngine(), destinations = ["one", "two"].map(name => path.join(root, partial ? "selected" : "all-selected", name));
    for (const destination of destinations) await fs.mkdir(destination, { recursive: true });
    const task = engine.createTask({ name: partial ? "Selected range" : "All selected", sourcePath: source,
      destinationPaths: destinations, hashAlgorithm: "sha256", namingTemplate: "display-only", copyMode: "mirror",
      devices: [], shootingDate: "2026-01-02", generateThumbnails: false, selection: plan });
    assert.deepEqual(task.inventoryScope, backupSelectionScope(plan));
    assert.equal(task.totalFiles, paths.length - excluded.size);
    const result = await new Promise<BackupTask>((resolve, reject) => {
      const timeout = setTimeout(() => { engine.cancelTask(task.id); reject(new Error("selected range runtime timeout")); }, 120_000);
      engine.once("settled", completed => { clearTimeout(timeout); resolve(completed); });
      engine.startTask(task.id);
    });
    assert.equal(result.status, "completed", result.errorMessage);
    assert.deepEqual(new Set(result.fileRecords.map(file => file.relativePath)), new Set(plan.includedPaths));
    assert.equal(taskTrustState(result).contentVerified, true);
    if (partial) assert.equal(taskTrustState(result).countableCopies, 0, "selected success must not certify a whole card");
    else assert.equal(taskTrustState(result).countableCopies, taskTrustState(result).copies.independentCopies);
    for (const destination of result.destinations) {
      assert.equal(destination.verified, true);
      const target = destination.resolvedPath!;
      for (const relative of plan.includedPaths)
        assert.equal(await hashFile(path.join(target, relative), "sha256"), before.files.find(([file]) => file === relative)![1]);
      for (const relative of excluded)
        await assert.rejects(fs.stat(path.join(target, relative)), { code: "ENOENT" });
      assert((await fs.stat(path.join(target, "Empty"))).isDirectory());
      const declaration = await detectBackupSelectionMarker(target);
      assert.equal(declaration.detected, partial, "every partial copy needs an on-disk scope warning, not a whole-card claim");
      if (partial) {
        const marker = declaration.markers.find(item => item.taskId === task.id);
        assert(marker && marker.status === "selected-scope");
        assert.equal(marker.selectionDigest, plan.digest);
        const serialized = await fs.readFile(marker.path, "utf8"), contents = JSON.parse(serialized);
        assert.equal(contents.wholeCardCovered, false);
        assert.equal(contents.verificationClaim, "none");
        assert(!serialized.includes(source), "portable scope warnings must not expose absolute source paths");
        assert.deepEqual(new Set(contents.includedFiles.map((file: { relativePath: string }) => file.relativePath)), new Set(plan.includedPaths));
        assert.deepEqual(new Set(contents.excludedFiles.map((file: { relativePath: string }) => file.relativePath)), excluded);
      }
    }
    if (partial) {
      // Delete only the generated warning inside this script's own fixture.
      // Reverification is also a completion path and must restore the mandatory
      // declaration, not merely re-read the selected media successfully.
      const firstTarget = result.destinations[0].resolvedPath!;
      const declaration = await detectBackupSelectionMarker(firstTarget);
      const ownMarker = declaration.markers.find(item => item.taskId === task.id)!;
      assert(ownMarker.path.startsWith(`${root}${path.sep}`));
      await fs.unlink(ownMarker.path);
      const reverified = await engine.reverifyTask(task.id);
      assert.equal(reverified.status, "completed", reverified.errorMessage);
      assert.equal(taskTrustState(reverified).countableCopies, 0);
      assert((await detectBackupSelectionMarker(firstTarget)).markers.some(item =>
        item.taskId === task.id && item.status === "selected-scope"));
    }
    const checked = applyBackupSelectionInventory(await validateBackupSelectionPlan(plan, deps), plan);
    assert.equal(checked.scope?.fingerprint, result.inventoryScope?.fingerprint, "revalidated full-selection scope must match its frozen derived fingerprint");
    assert.deepEqual(await sourceSnapshot(source), before, "selection must not modify any original content or directories");
    cases.push(`${partial ? "selected subset" : "all-selected plan"}: real volume identity, actual two-target copy and independent SHA-256 readback, cross-directory sidecars, shared metadata, sound/video and camera package protection, source unchanged, frozen scope consistent${partial ? ", zero countable whole-card copies, mandatory on-disk scope warning including manual reverification" : ""}; same-volume targets are not physical two-disk acceptance`);
  }
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-runtime-check-")));
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
    await selectedRangeRuntime(root, cases);
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
