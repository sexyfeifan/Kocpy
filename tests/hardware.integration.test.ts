import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { BackupTask } from "../src/main/types";

const confirmation = "I_UNDERSTAND_THIS_WRITES_AND_REMOVES_SYNTHETIC_TEST_DATA";
const destinations: string[] = (() => {
  try {
    return JSON.parse(process.env.KOCPY_HARDWARE_DESTINATIONS || "[]");
  } catch {
    return [];
  }
})();
const enabled = destinations.length > 0;

interface VolumeEvidence {
  path: string;
  realPath: string;
  deviceId: number;
  filesystem?: string;
  volumeName?: string;
  volumeUuid?: string;
  deviceIdentifier?: string;
  parentWholeDisk?: string;
  busProtocol?: string;
  internal?: boolean;
  network?: boolean;
  virtual?: boolean;
}

function inside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function diskInfo(target: string): Record<string, unknown> {
  const xml = execFileSync("/usr/sbin/diskutil", ["info", "-plist", target]);
  const converted = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input: xml,
    encoding: "utf8",
  });
  if (converted.status !== 0) throw new Error(`Cannot read mounted-volume identity: ${target}`);
  return JSON.parse(converted.stdout);
}

async function inspectVolume(target: string): Promise<VolumeEvidence> {
  if (process.platform !== "darwin") throw new Error("Mounted-volume acceptance requires macOS.");
  const normalized = path.resolve(target);
  const relative = path.relative("/Volumes", normalized);
  if (!relative || relative.startsWith("..") || relative.split(path.sep).length !== 1)
    throw new Error(`Destination must be an exact mounted volume root under /Volumes: ${target}`);
  const realPath = await fs.realpath(normalized);
  const stats = await fs.stat(realPath);
  if (!stats.isDirectory()) throw new Error(`Destination is not a directory: ${target}`);
  const info = diskInfo(realPath);
  const mountPoint = String(info.MountPoint || "");
  if (path.resolve(mountPoint) !== realPath)
    throw new Error(`Destination is not the root of its mounted volume: ${target}`);
  const filesystem = String(info.FilesystemType || info.FilesystemName || "unknown");
  const busProtocol = info.BusProtocol ? String(info.BusProtocol) : undefined;
  if (info.Internal === true)
    throw new Error(`Internal volumes are not accepted as disposable hardware targets: ${target}`);
  if (info.ReadOnlyMedia === true || info.ReadOnlyVolume === true || info.Writable === false)
    throw new Error(`Destination is not writable: ${target}`);
  return {
    path: normalized,
    realPath,
    deviceId: stats.dev,
    filesystem,
    volumeName: String(info.VolumeName || path.basename(realPath)),
    volumeUuid: info.VolumeUUID ? String(info.VolumeUUID) : undefined,
    deviceIdentifier: info.DeviceIdentifier ? String(info.DeviceIdentifier) : undefined,
    parentWholeDisk: info.ParentWholeDisk ? String(info.ParentWholeDisk) : undefined,
    busProtocol,
    internal: typeof info.Internal === "boolean" ? info.Internal : undefined,
    network: /^(?:smbfs|nfs|afpfs|webdav)$/i.test(filesystem) || /network/i.test(busProtocol || ""),
    virtual: info.VirtualOrPhysical === "Virtual" || /disk image/i.test(busProtocol || ""),
  };
}

function physicalIndependence(volumes: VolumeEvidence[]) {
  if (volumes.length < 2) return "single-destination-only";
  if (volumes.some((volume) => volume.network)) return "network-storage-not-physically-provable";
  if (volumes.some((volume) => volume.virtual)) return "virtual-volumes-not-physical-disks";
  const parents = volumes.map((volume) => volume.parentWholeDisk).filter(Boolean) as string[];
  if (
    volumes.every((volume) => volume.internal === false) &&
    parents.length === volumes.length &&
    new Set(parents).size === volumes.length
  ) return "distinct-external-whole-disks";
  return "not-proven";
}

function wait(engine: BackupEngine) {
  return new Promise<BackupTask>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("hardware test timeout")),
      30 * 60_000,
    );
    engine.once("settled", (task) => {
      clearTimeout(timer);
      resolve(task);
    });
  });
}
describe.skipIf(!enabled)("Opt-in mounted-volume stress verification", () => {
  it(
    "copies one large file and 1500 small files to every supplied mounted volume",
    async () => {
      const startedAt = new Date().toISOString();
      const resultFile = process.env.KOCPY_HARDWARE_RESULT || "";
      let source = "";
      let testDestinations: string[] = [];
      let volumes: VolumeEvidence[] = [];
      let taskResult: BackupTask | undefined;
      let failure = "";
      let sourceRemoved = false;
      let destinationsRemoved = false;
      try {
        if (process.env.KOCPY_HARDWARE_CONFIRM !== confirmation)
          throw new Error("Explicit generated-data write-test confirmation is missing.");
        if (!resultFile || !path.isAbsolute(resultFile))
          throw new Error("KOCPY_HARDWARE_RESULT must be a new absolute JSON path.");
        if (destinations.some((destination) => inside(destination, resultFile)))
          throw new Error("The result file must be outside every tested volume.");
        volumes = await Promise.all(destinations.map(inspectVolume));
        if (new Set(volumes.map((volume) => volume.realPath)).size !== volumes.length)
          throw new Error("The same mounted volume was supplied more than once.");
        if (new Set(volumes.map((volume) => volume.deviceId)).size !== volumes.length)
          throw new Error("Multiple destination paths resolve to the same mounted filesystem.");
        const localParents = volumes.map((volume) => volume.parentWholeDisk).filter(Boolean) as string[];
        if (new Set(localParents).size !== localParents.length)
          throw new Error("Multiple local destinations belong to the same physical whole disk.");

        source = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-hardware-source-"));
        testDestinations = destinations.map((destination) =>
          path.join(destination, `.kocpy-hardware-test-${randomUUID()}`),
        );
        await Promise.all(
          testDestinations.map((destination) =>
            fs.mkdir(destination, { recursive: true }),
          ),
        );
        const large = await fs.open(
          path.join(source, "large-camera-clip.bin"),
          "w",
        );
        try {
          const block = Buffer.alloc(1024 * 1024, 0xa5);
          for (let i = 0; i < 256; i++) await large.write(block);
        } finally {
          await large.close();
        }
        await fs.mkdir(path.join(source, "SMALL"));
        await Promise.all(
          Array.from({ length: 1500 }, (_, i) =>
            fs.writeFile(
              path.join(
                source,
                "SMALL",
                `clip-${String(i).padStart(5, "0")}.dat`,
              ),
              Buffer.from(`frame-${i}`),
            ),
          ),
        );
        const engine = new BackupEngine(),
          task = engine.createTask({
            name: "hardware-stress",
            sourcePath: source,
            destinationPaths: testDestinations,
            hashAlgorithm: "sha256",
            namingTemplate: "hardware-stress",
            devices: [],
            shootingDate: "",
            copyMode: "normal",
          });
        const done = wait(engine);
        engine.startTask(task.id);
        const result = await done;
        taskResult = result;
        if (result.status !== "completed") {
          const destinationErrors = result.destinations
            .map((destination) => destination.error)
            .filter(Boolean)
            .join("；");
          throw new Error(
            `Backup engine finished with status ${result.status}${destinationErrors ? `: ${destinationErrors}` : ""}`,
          );
        }
        expect(result.totalFiles).toBe(1501);
        expect(result.destinations.every((d) => d.verified)).toBe(true);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (source) {
          await fs.rm(source, { recursive: true, force: true });
          sourceRemoved = true;
        }
        await Promise.all(
          testDestinations.map((destination) =>
            fs.rm(destination, { recursive: true, force: true }),
          ),
        );
        destinationsRemoved = true;
        if (resultFile && path.isAbsolute(resultFile)) {
          await fs.mkdir(path.dirname(resultFile), { recursive: true });
          const report = {
            schemaVersion: 1,
            product: "Kocpy",
            version: JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")).version,
            test: "mounted-volume-backup-verification",
            architecture: process.arch,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: failure ? "FAIL" : taskResult?.status === "completed" ? "PASS" : "FAIL",
            failure: failure || undefined,
            syntheticFixture: {
              largeFileBytes: 256 * 1024 * 1024,
              smallFiles: 1500,
              recommendedFreeBytesPerDestination: 600 * 1024 * 1024,
            },
            volumes,
            physicalIndependence: physicalIndependence(volumes),
            task: taskResult
              ? {
                  id: taskResult.id,
                  status: taskResult.status,
                  totalFiles: taskResult.totalFiles,
                  totalBytes: taskResult.totalBytes,
                  hashAlgorithm: taskResult.hashAlgorithm,
                  destinations: taskResult.destinations.map((destination) => ({
                    path: destination.path,
                    volumeUuid: destination.volumeUuid,
                    verified: destination.verified,
                    bytesWritten: destination.bytesWritten,
                    checksum: destination.checksum,
                    error: destination.error,
                  })),
                }
              : undefined,
            cleanup: { sourceRemoved, destinationsRemoved },
            limitations: [
              "Generated data only; no production media was read or modified.",
              "A passing run proves this finite mounted-volume exercise, not indefinite field reliability.",
              "Network storage cannot establish the provider's underlying physical fault domains.",
            ],
          };
          await fs.writeFile(resultFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        }
      }
    },
    30 * 60_000,
  );
});
