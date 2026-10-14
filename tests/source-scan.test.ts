import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { completeInventoryPolicy, scan } from "../src/main/backup/safety";

let root: string;
let source: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-source-scan-"));
  source = path.join(root, "source");
  await fs.mkdir(source);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const denied = (code: string) => Object.assign(new Error(`${code}: denied by fixture`), { code });

function denyReadDirectory(target: string, code: string, beforeThrow?: () => void) {
  const original = fs.readdir;
  return vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === target) {
      beforeThrow?.();
      throw denied(code);
    }
    return original(...args);
  }) as typeof fs.readdir);
}

function denyStat(target: string, code: string) {
  const original = fs.lstat;
  return vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === target) throw denied(code);
    return original(...args);
  }) as typeof fs.lstat);
}

const filePaths = (inventory: Awaited<ReturnType<typeof scan>>) =>
  inventory.files.map((file) => file.relativePath);

describe("source scan system-directory and permission handling", () => {
  it("excludes known macOS system directories at every depth without reading their metadata or contents", async () => {
    const names = [
      ".Spotlight-V100", ".Trashes", ".fseventsd", ".TemporaryItems",
      ".DocumentRevisions-V100", ".PKInstallSandboxManager",
      ".PKInstallSandboxManager-SystemSoftware",
    ];
    await fs.mkdir(path.join(source, "media"));
    await fs.writeFile(path.join(source, "media", "clip.mov"), "media");
    const blocked = new Set<string>();
    for (const parent of [source, path.join(source, "media")]) {
      for (const name of names) {
        const directory = path.join(parent, name);
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "index.bin"), "system data");
        blocked.add(directory);
      }
    }
    const originalStat = fs.lstat;
    const originalRead = fs.readdir;
    const statSpy = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (blocked.has(String(args[0]))) throw denied("EPERM");
      return originalStat(...args);
    }) as typeof fs.lstat);
    const readSpy = vi.spyOn(fs, "readdir").mockImplementation((async (...args: Parameters<typeof fs.readdir>) => {
      if (blocked.has(String(args[0]))) throw denied("EPERM");
      return originalRead(...args);
    }) as typeof fs.readdir);

    const inventory = await scan(source, completeInventoryPolicy(true));
    expect(filePaths(inventory)).toEqual([path.join("media", "clip.mov")]);
    expect(inventory.directories).toEqual(["media"]);
    expect(inventory.skipped).toBe(blocked.size);
    expect(inventory.scope?.excludedDirectories).toBe(blocked.size);
    expect(inventory.exclusions).toEqual(expect.arrayContaining([...blocked].map((directory) =>
      expect.objectContaining({ relativePath: path.relative(source, directory), kind: "directory",
        reason: "system-directory", bytesUnknown: true }))));
    expect(inventory.exclusions).toHaveLength(blocked.size);
    expect(statSpy.mock.calls.some(([target]) => blocked.has(String(target)))).toBe(false);
    expect(readSpy.mock.calls.some(([target]) => blocked.has(String(target)))).toBe(false);
  });

  it("preserves ordinary hidden files and directories, AppleDouble, and regular files with system-directory names", async () => {
    const files = [".DS_Store", "._clip.mov", ".hidden-note", ".Spotlight-V100", ".Trashes-copy"];
    for (const name of files) await fs.writeFile(path.join(source, name), name);
    await fs.mkdir(path.join(source, ".camera"));
    await fs.writeFile(path.join(source, ".camera", "clip.mov"), "footage");

    const inventory = await scan(source, completeInventoryPolicy(true));
    expect(filePaths(inventory).sort()).toEqual([...files, path.join(".camera", "clip.mov")].sort());
    expect(inventory.directories).toEqual([".camera"]);
    expect(inventory.exclusions).toEqual([]);
  });

  it.each(["EPERM", "EACCES"])("continues sibling media after a descendant directory readdir %s", async (code) => {
    const target = path.join(source, "b-denied");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "unreadable.mov"), "private");
    await fs.writeFile(path.join(source, "a-before.mov"), "first");
    await fs.mkdir(path.join(source, "z-after"));
    await fs.writeFile(path.join(source, "z-after", "clip.mov"), "last");
    denyReadDirectory(target, code);

    const inventory = await scan(source, completeInventoryPolicy(true));
    expect(filePaths(inventory)).toEqual(["a-before.mov", path.join("z-after", "clip.mov")]);
    expect(inventory.totalBytes).toBe(9);
    expect(inventory.directories).toEqual(["z-after"]);
    expect(inventory.directoryMetadata.map((entry) => entry.relativePath)).toEqual(["z-after"]);
    expect(inventory.exclusions).toEqual([expect.objectContaining({
      relativePath: "b-denied", kind: "directory", bytes: 0,
      reason: "permission-denied", permissionCode: code, bytesUnknown: true,
    })]);
    expect(inventory.scope).toMatchObject({ includedFiles: 2, includedBytes: 9,
      includedDirectories: 1, includedDirectoryPaths: ["z-after"], excludedDirectories: 1 });
  });

  it.each(["EPERM", "EACCES"])("records denied descendant file and directory lstat %s while scanning siblings", async (code) => {
    await fs.mkdir(path.join(source, "blocked-directory"));
    await fs.writeFile(path.join(source, "blocked-file.mov"), "unknown contents");
    await fs.writeFile(path.join(source, "visible.mov"), "readable");
    const originalStat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (path.basename(String(args[0])).startsWith("blocked-")) throw denied(code);
      return originalStat(...args);
    }) as typeof fs.lstat);

    const inventory = await scan(source, completeInventoryPolicy(true));
    expect(filePaths(inventory)).toEqual(["visible.mov"]);
    expect(inventory.totalBytes).toBe(8);
    expect(inventory.directories).toEqual([]);
    expect(inventory.directoryMetadata).toEqual([]);
    expect(inventory.exclusions).toEqual([
      expect.objectContaining({ relativePath: "blocked-directory", kind: "directory",
        reason: "permission-denied", permissionCode: code, bytesUnknown: true }),
      expect.objectContaining({ relativePath: "blocked-file.mov", kind: "file",
        reason: "permission-denied", permissionCode: code, bytesUnknown: true }),
    ]);
    expect(inventory.scope).toMatchObject({ excludedFiles: 1, excludedDirectories: 1, excludedBytes: 0 });
  });

  it.each(["lstat", "readdir"] as const)("records a hidden directory permission denial from %s under the filtered policy without duplicating its exclusion", async (operation) => {
    const target = path.join(source, ".hidden-camera");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "clip.mov"), "unreadable");
    await fs.writeFile(path.join(source, "clip.mov"), "readable");
    if (operation === "lstat") denyStat(target, "EACCES");
    else denyReadDirectory(target, "EACCES");

    const inventory = await scan(source, completeInventoryPolicy(false));
    expect(filePaths(inventory)).toEqual(["clip.mov"]);
    expect(inventory.exclusions).toEqual([expect.objectContaining({
      relativePath: ".hidden-camera", kind: "directory", reason: "permission-denied",
      permissionCode: "EACCES", bytesUnknown: true,
    })]);
    expect(inventory.skipped).toBe(1);
    expect(inventory.directories).toEqual([]);
    expect(inventory.directoryMetadata).toEqual([]);
  });

  it.each(["lstat", "readdir"] as const)("fails when the selected root itself has a permission-denied %s", async (operation) => {
    if (operation === "lstat") denyStat(source, "EPERM");
    else denyReadDirectory(source, "EACCES");
    await expect(scan(source, completeInventoryPolicy(true))).rejects.toThrow(/无法读取素材(?:源|目录)/);
  });

  it.each(["EIO", "ENOENT"])("keeps descendant readdir and lstat %s failures fatal", async (code) => {
    const target = path.join(source, "camera");
    await fs.mkdir(target);
    const reader = denyReadDirectory(target, code);
    await expect(scan(source, completeInventoryPolicy(true))).rejects.toThrow(/无法读取素材目录：camera/);
    reader.mockRestore();
    denyStat(target, code);
    await expect(scan(source, completeInventoryPolicy(true))).rejects.toThrow(/无法读取素材条目：camera/);
  });

  it("keeps symlinks fatal, including a symlink named after a system directory", async () => {
    const target = path.join(root, "target");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(source, ".Spotlight-V100"));
    await expect(scan(source, completeInventoryPolicy(true))).rejects.toThrow(/符号链接/);
  });

  it("keeps special files fatal", async () => {
    await fs.writeFile(path.join(source, "device"), "fixture");
    const original = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const result = await original(...args);
      return String(args[0]) === path.join(source, "device")
        ? Object.assign(result, { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false })
        : result;
    }) as typeof fs.lstat);
    await expect(scan(source, completeInventoryPolicy(true))).rejects.toThrow(/不支持的特殊文件：device/);
  });

  it("preserves frozen strict policy behavior when the new source-read policy is absent", async () => {
    const policy = completeInventoryPolicy(true);
    delete policy.sourceReadPolicy;
    const target = path.join(source, ".Spotlight-V100");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old-index.bin"), "preserved");
    expect(filePaths(await scan(source, policy))).toEqual([path.join(".Spotlight-V100", "old-index.bin")]);
    denyReadDirectory(target, "EPERM");
    await expect(scan(source, policy)).rejects.toThrow(/无法读取素材目录/);
  });

  it("preserves the historical boolean scanner's strict permission behavior", async () => {
    const target = path.join(source, "camera");
    await fs.mkdir(target);
    denyReadDirectory(target, "EPERM");
    await expect(scan(source, true)).rejects.toThrow(/无法读取素材目录/);
  });

  it("changes scope fingerprints when permission codes change or an excluded directory becomes readable", async () => {
    const target = path.join(source, "camera");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "clip.mov"), "media");
    const policy = completeInventoryPolicy(true, 1);
    const firstDenial = denyReadDirectory(target, "EPERM");
    const first = await scan(source, policy);
    const unchanged = await scan(source, policy);
    expect(unchanged.scope?.fingerprint).toBe(first.scope?.fingerprint);
    firstDenial.mockRestore();
    const secondDenial = denyReadDirectory(target, "EACCES");
    const second = await scan(source, policy);
    expect(second.scope?.fingerprint).not.toBe(first.scope?.fingerprint);
    secondDenial.mockRestore();
    const readable = await scan(source, policy);
    expect(readable.scope?.fingerprint).not.toBe(second.scope?.fingerprint);
    expect(filePaths(readable)).toEqual([path.join("camera", "clip.mov")]);
  });

  it("honors cancellation while a denied descendant directory is being read", async () => {
    const target = path.join(source, "camera");
    await fs.mkdir(target);
    await fs.writeFile(path.join(source, "z-after.mov"), "media");
    const controller = new AbortController();
    denyReadDirectory(target, "EPERM", () => controller.abort());
    await expect(scan(source, completeInventoryPolicy(true), controller.signal)).rejects.toThrow(/abort/i);
  });
});
