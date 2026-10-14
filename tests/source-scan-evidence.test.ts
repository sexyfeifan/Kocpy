import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import { scan } from "../src/main/backup/safety";
import { generateReport } from "../src/main/backup/ReportGenerator";
import { generateAscMhl } from "../src/main/backup/ManifestGenerator";
import type { BackupTask, InventoryExcludedEntry } from "../src/main/types";
import {
  sealWorkspaceState,
  validateWorkspaceState,
  workspaceDigest,
} from "../src/main/workspace-contract";

let root: string;
let source: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-scan-evidence-"));
  source = path.join(root, "source");
  await fs.mkdir(source);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function frozenTask(includeHidden = true) {
  const blockedDirectory = path.join(source, "DCIM", "locked&dir"),
    blockedFile = path.join(source, "private&take.mov");
  await fs.mkdir(blockedDirectory, { recursive: true });
  await fs.mkdir(path.join(source, ".Spotlight-V100"));
  await Promise.all([
    fs.writeFile(path.join(source, "DCIM", "clip.mov"), "generated-media"),
    fs.writeFile(path.join(blockedDirectory, "omitted.mov"), "unreadable-media"),
    fs.writeFile(path.join(source, ".Spotlight-V100", "index.bin"), "index"),
    fs.writeFile(path.join(source, ".hidden-note"), "generated-sidecar"),
    fs.writeFile(blockedFile, "unreadable-file"),
  ]);
  const readDirectory = fs.readdir,
    statEntry = fs.lstat;
  vi.spyOn(fs, "readdir").mockImplementation(
    (async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === blockedDirectory)
        throw Object.assign(new Error("generated directory permission denial"), {
          code: "EACCES",
        });
      return readDirectory(...args);
    }) as typeof fs.readdir,
  );
  vi.spyOn(fs, "lstat").mockImplementation(
    (async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === blockedFile)
        throw Object.assign(new Error("generated file permission denial"), {
          code: "EPERM",
        });
      return statEntry(...args);
    }) as typeof fs.lstat,
  );
  const task = new BackupEngine().createTask({
      name: "Generated scan evidence",
      sourcePath: source,
      destinationPaths: [path.join(root, "destination")],
      devices: [],
      hashAlgorithm: "sha256",
      namingTemplate: "generated-scope",
      shootingDate: "2026-10-14",
      includeHidden,
      automaticPdf: false,
    }),
    inventory = await scan(source, task.inventoryPolicy!);
  task.inventoryScope = structuredClone(inventory.scope!);
  task.totalFiles = task.completedFiles = inventory.files.length;
  task.totalBytes = task.transferredBytes = inventory.totalBytes;
  task.skippedFiles = inventory.skipped;
  task.skippedBytes = inventory.skippedBytes;
  task.status = "completed";
  task.completedAt = Date.now();
  task.copyProgress = task.verifyProgress = 100;
  task.destinations[0].verified = true;
  task.destinations[0].resolvedPath = task.destinations[0].path;
  task.destinations[0].bytesWritten = task.totalBytes;
  task.fileRecords = await Promise.all(
    inventory.files.map(async (file) => {
      const bytes = await fs.readFile(file.absolutePath),
        target = path.join(task.destinations[0].path, file.relativePath),
        checksum = createHash("sha256").update(bytes).digest("hex");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.absolutePath, target);
      const copiedChecksum = createHash("sha256")
        .update(await fs.readFile(target))
        .digest("hex");
      expect(copiedChecksum).toBe(checksum);
      return {
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        srcChecksum: checksum,
        ascMhlMd5: createHash("md5").update(bytes).digest("hex"),
        destinations: [{ path: target, checksum: copiedChecksum, verified: true }],
      };
    }),
  );
  return task;
}

const sealTask = (task: BackupTask) =>
  sealWorkspaceState({
    schemaVersion: 1,
    revision: 1,
    committedAt: 1,
    tasks: [task],
    projects: [],
    taskTombstones: [],
    projectTombstones: [],
  });

const excluded = (task: BackupTask, relativePath: string): InventoryExcludedEntry =>
  task.inventoryScope!.exclusions.find(
    (item) => item.relativePath === relativePath,
  )!;

describe("source scan exclusions remain explicit in downstream evidence", () => {
  it("persists scanner-produced system and permission records without inventing measured subtree bytes", async () => {
    const task = await frozenTask(),
      sealed = sealTask(task),
      restored = validateWorkspaceState(JSON.parse(JSON.stringify(sealed)));
    expect(restored.tasks[0].inventoryPolicy?.sourceReadPolicy).toBe(
      "skip-system-and-permission-errors",
    );
    expect(restored.tasks[0].inventoryScope).toEqual(task.inventoryScope);
    expect(task.inventoryScope?.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: ".Spotlight-V100",
          reason: "system-directory",
          bytesUnknown: true,
        }),
        expect.objectContaining({
          relativePath: "DCIM/locked&dir",
          reason: "permission-denied",
          permissionCode: "EACCES",
          bytesUnknown: true,
        }),
        expect.objectContaining({
          relativePath: "private&take.mov",
          reason: "permission-denied",
          permissionCode: "EPERM",
          bytesUnknown: true,
        }),
      ]),
    );
  });

  it("reports distinct reasons and warns that excluded bytes and subtree counts are unknown", async () => {
    const task = await frozenTask(false),
      html = (await generateReport(task)).toString();
    expect(html).toContain("系统隐藏目录");
    expect(html).toContain("无读取权限（EACCES）");
    expect(html).toContain("无读取权限（EPERM）");
    expect(html).toContain("用户选择过滤隐藏条目");
    expect(html).toContain("大小未知的排除条目");
    expect(html).toContain("汇总字节仅含已知部分");
    expect(html).toContain("未扫描目录内的文件数量与字节未计入统计");
    expect(html).toContain("明确过滤范围 · complete-v2");
    expect(html).toContain("DCIM/locked&amp;dir");
    expect(html).toContain("范围内内容校验通过 · 权限排除 2 项");
    expect(html).not.toContain("完整文件范围 · complete-v2");
  });

  it("exports every frozen exclusion as an escaped ASC MHL ignore in complete mode", async () => {
    const task = await frozenTask(),
      xml = generateAscMhl(task);
    expect(task.inventoryPolicy?.mode).toBe("complete");
    expect(xml).toContain("<pattern>.Spotlight-V100</pattern>");
    expect(xml).toContain("<pattern>DCIM/locked&amp;dir</pattern>");
    expect(xml).toContain("<pattern>private&amp;take.mov</pattern>");
    expect(xml).toContain('<path size="17">.hidden-note</path>');
    expect(xml).not.toContain("index.bin");
    expect(xml).not.toContain("omitted.mov");
    task.inventoryScope = undefined;
    expect(() => generateAscMhl(task)).toThrow(/缺少冻结的排除范围/);
  });

  it.each([
    {
      name: "ordinary material mislabeled as system directory",
      mutate: (task: BackupTask) => {
        excluded(task, ".Spotlight-V100").relativePath = "ordinary-material";
      },
    },
    {
      name: "unsupported permission code",
      mutate: (task: BackupTask) => {
        excluded(task, "DCIM/locked&dir").permissionCode = "EIO" as never;
      },
    },
    {
      name: "missing permission code",
      mutate: (task: BackupTask) => {
        delete excluded(task, "DCIM/locked&dir").permissionCode;
      },
    },
    {
      name: "system subtree missing unknown-size marker",
      mutate: (task: BackupTask) => {
        delete excluded(task, ".Spotlight-V100").bytesUnknown;
      },
    },
    {
      name: "permission subtree missing unknown-size marker",
      mutate: (task: BackupTask) => {
        delete excluded(task, "DCIM/locked&dir").bytesUnknown;
      },
    },
    {
      name: "unstatable file missing unknown-size marker",
      mutate: (task: BackupTask) => {
        delete excluded(task, "private&take.mov").bytesUnknown;
      },
    },
    {
      name: "new exclusions attached to a historical strict policy",
      mutate: (task: BackupTask) => {
        delete task.inventoryPolicy!.sourceReadPolicy;
        delete task.inventoryScope!.policy.sourceReadPolicy;
      },
    },
  ])("rejects $name even with a newly calculated workspace digest", async ({ mutate }) => {
    const task = await frozenTask(),
      candidate = structuredClone(sealTask(task));
    mutate(task);
    expect(() => sealTask(task)).toThrow(/文件范围排除记录无效/);
    mutate(candidate.tasks[0]);
    const { digest: _digest, ...body } = candidate;
    candidate.digest = workspaceDigest(body);
    expect(() => validateWorkspaceState(candidate)).toThrow(/文件范围排除记录无效/);
  });
});
