import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  assertPortableRevisionDescends,
  preparePortableProject,
  publishPortableProject,
  readPortableProject,
  validatePortableProject,
  verifyPortablePayload,
} from "../src/main/portable-project";
import { validatePortableHistory } from "../src/common/portable-project";
import type { BackupTask, ProjectConfig } from "../src/main/types";
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await fs.rm(r, { recursive: true, force: true });
});
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-portable-"));
  roots.push(parent);
  const root = path.join(parent, "synthetic-project");
  await fs.mkdir(path.join(root, "20261015", "FX3", "CARD"), {
    recursive: true,
  });
  const rel = "20261015/FX3/CARD/clip.mp4";
  await fs.writeFile(path.join(root, rel), "generated-media");
  await fs.writeFile(path.join(root, ".sidecar"), "keep-hidden");
  const project: ProjectConfig = {
    id: "fixture-project",
    name: "合成项目",
    devices: ["FX3"],
    volumePrefix: "CARD_",
    shootingDateStart: "2026-10-15",
    shootingDateEnd: "2026-10-16",
  };
  return { root, rel, parent, project };
}
async function baseline() {
  const f = await fixture(),
    prepared = await preparePortableProject(f.root, f.project);
  const result = await publishPortableProject(prepared, "测试操作人");
  return { ...f, ...result };
}
describe("portable project evidence", () => {
  it("reads all hidden payload, builds current baseline, roundtrips on another path without inventing task history", async () => {
    const f = await baseline();
    expect(f.document.provenance).toBe("current-baseline");
    expect(f.document.files).toHaveLength(2);
    expect(f.document.rolls).toEqual([]);
    const moved = path.join(f.parent, "Mac-B");
    await fs.cp(f.root, moved, { recursive: true });
    expect(
      (await verifyPortablePayload(moved, f.sha256)).document.project.id,
    ).toBe(f.project.id);
    expect(await fs.readFile(path.join(f.root, f.rel), "utf8")).toBe(
      "generated-media",
    );
  });
  it("retains original task expectations and confirmed dates, not task-day assumptions", async () => {
    const f = await fixture(),
      location = path.join(f.root, f.rel);
    const task = {
      id: "full-task-id",
      projectId: f.project.id,
      name: "CARD",
      namingTemplate: "CARD",
      devices: ["FX3"],
      status: "completed",
      totalFiles: 1,
      totalBytes: 15,
      hashAlgorithm: "sha256",
      shootingDate: "2026-10-15",
      destinations: [
        { path: path.dirname(location), resolvedPath: path.dirname(location) },
      ],
      fileRecords: [
        {
          relativePath: "clip.mp4",
          size: 15,
          srcChecksum: sha("generated-media"),
          destinations: [
            {
              path: location,
              checksum: sha("generated-media"),
              verified: true,
            },
          ],
        },
      ],
    } as BackupTask;
    const p = await preparePortableProject(f.root, f.project, [task]);
    expect(p.document.provenance).toBe("recorded-history");
    expect(p.document.rolls[0].id).toBe(task.id);
    await publishPortableProject(p, "测试");
  });
  it("keeps missing MHL evidence and accepts only specifically confirmed intentional removal in a new revision", async () => {
    const f = await fixture(),
      mhlRel = "20261015/FX3/CARD/original.mhl",
      raw = `<hash><file>missing.mov</file><sha256>${sha("missing")}</sha256><size>7</size></hash>`;
    await fs.writeFile(path.join(f.root, mhlRel), raw);
    const p = await preparePortableProject(f.root, f.project);
    expect(p.inspection.missing).toEqual(["20261015/FX3/CARD/missing.mov"]);
    await expect(publishPortableProject(p, "测试")).rejects.toThrow("逐项确认");
    await expect(
      publishPortableProject(p, "测试", p.inspection.missing),
    ).rejects.toThrow("原因");
    const result = await publishPortableProject(
      p,
      "测试",
      p.inspection.missing,
      "授权范围内有意移除",
    );
    expect(result.document.exclusions[0].expected.checksum).toBe(
      sha("missing"),
    );
    expect(await fs.readFile(path.join(f.root, mhlRel), "utf8")).toBe(raw);
    await verifyPortablePayload(f.root, result.sha256);
    await fs.writeFile(path.join(f.root, p.inspection.missing[0]), "missing");
    await expect(verifyPortablePayload(f.root, result.sha256)).rejects.toThrow(
      "基线不匹配",
    );
  });
  it("preserves exact prior metadata and audit on revision, without editing original file records", async () => {
    const f = await baseline(),
      raw = await fs.readFile(path.join(f.root, ".kocpyproject"));
    await fs.unlink(path.join(f.root, f.rel));
    const p = await preparePortableProject(f.root, f.project);
    const next = await publishPortableProject(
      p,
      "交接人",
      [f.rel],
      "已确认不交付",
    );
    expect(next.document.previousSha256).toBe(f.sha256);
    expect(
      await fs.readFile(
        path.join(f.root, ".kocpyproject-history", `${f.sha256}.json`),
      ),
    ).toEqual(raw);
    expect(next.document.exclusions[0].operator).toBe("交接人");
    await verifyPortablePayload(f.root, next.sha256);
  });
  it("cannot suppress a wrong checksum, size difference, or unselected missing path", async () => {
    const f = await baseline();
    await fs.writeFile(path.join(f.root, f.rel), "WRONG-media");
    const p = await preparePortableProject(f.root, f.project);
    expect(p.inspection.mismatches).toEqual([f.rel]);
    await expect(
      publishPortableProject(p, "测试", [], "manual"),
    ).rejects.toThrow("内容/大小差异");
    await expect(verifyPortablePayload(f.root, f.sha256)).rejects.toThrow(
      "基线不匹配",
    );
  });
  it("checks secondary MHL algorithm instead of silently preferring task or portable evidence", async () => {
    const f = await baseline();
    await fs.writeFile(
      path.join(f.root, "external.mhl"),
      `<hash><file>${f.rel}</file><md5>${"0".repeat(32)}</md5></hash>`,
    );
    const p = await preparePortableProject(f.root, f.project);
    expect(p.inspection.mismatches.some((v) => v.includes("外部清单"))).toBe(
      true,
    );
    await expect(publishPortableProject(p, "测试")).rejects.toThrow(
      "内容/大小差异",
    );
  });
  it("rejects stale preview after payload, metadata or inventory changes", async () => {
    const f = await baseline(),
      p = await preparePortableProject(f.root, f.project);
    await fs.writeFile(path.join(f.root, f.rel), "different-media");
    await expect(publishPortableProject(p, "测试")).rejects.toThrow(
      "范围已变化",
    );
    expect((await readPortableProject(f.root))!.sha256).toBe(f.sha256);
  });
  it("stops after cancellation and never commits a baseline", async () => {
    const f = await fixture(),
      controller = new AbortController();
    await expect(
      preparePortableProject(f.root, f.project, [], {
        signal: controller.signal,
        progress: () => controller.abort(),
      }),
    ).rejects.toThrow("取消");
    expect(await readPortableProject(f.root)).toBeUndefined();
  });
  it("keeps pending exclusion changes uncommitted if publish is cancelled", async () => {
    const f = await baseline(),
      p = await preparePortableProject(f.root, f.project),
      c = new AbortController();
    c.abort();
    await expect(
      publishPortableProject(p, "测试", [], "", { signal: c.signal }),
    ).rejects.toThrow("取消");
    expect((await readPortableProject(f.root))!.sha256).toBe(f.sha256);
  });
  it("does not follow symbolic links or overwrite foreign project identities", async () => {
    const f = await baseline();
    await expect(
      preparePortableProject(f.root, { ...f.project, id: "other" }),
    ).rejects.toThrow("另一项目");
    await fs.symlink(path.join(f.root, f.rel), path.join(f.root, "alias.mov"));
    await expect(preparePortableProject(f.root, f.project)).rejects.toThrow(
      "符号链接",
    );
  });
  it("rejects poisoned metadata symlink and unsafe revision storage", async () => {
    const f = await fixture();
    await fs.symlink(
      path.join(f.root, f.rel),
      path.join(f.root, ".kocpyproject"),
    );
    await expect(readPortableProject(f.root)).rejects.toThrow();
    await fs.unlink(path.join(f.root, ".kocpyproject"));
    const p = await preparePortableProject(f.root, f.project);
    await fs.symlink(f.parent, path.join(f.root, ".kocpyproject-history"));
    await expect(publishPortableProject(p, "测试")).rejects.toThrow(
      "目录不安全",
    );
    expect(await readPortableProject(f.root)).toBeUndefined();
  });
  it("does not take over a crash/concurrent writer lock", async () => {
    const f = await fixture(),
      p = await preparePortableProject(f.root, f.project);
    await fs.writeFile(
      path.join(f.root, ".kocpyproject.lock"),
      "interrupted writer evidence",
    );
    await expect(publishPortableProject(p, "测试")).rejects.toThrow();
    expect(
      await fs.readFile(path.join(f.root, ".kocpyproject.lock"), "utf8"),
    ).toBe("interrupted writer evidence");
  });
  it("rechecks metadata digest, schema, duplicate case aliases and traversal even with recalculated integrity", async () => {
    const f = await baseline();
    const sign = (doc: any) => {
      const { integrity: _, ...rest } = doc;
      return { ...rest, integrity: sha(JSON.stringify(rest)) };
    };
    expect(() =>
      validatePortableProject({ ...f.document, operator: "tampered" }),
    ).toThrow("摘要");
    expect(() =>
      validatePortableProject(sign({ ...f.document, schemaVersion: 2 })),
    ).toThrow("版本");
    expect(() =>
      validatePortableProject(
        sign({
          ...f.document,
          files: [{ ...f.document.files[0], path: "../escape" }],
        }),
      ),
    ).toThrow("格式");
    expect(() =>
      validatePortableProject(
        sign({
          ...f.document,
          files: [
            ...f.document.files,
            {
              ...f.document.files[0],
              path: f.document.files[0].path.toUpperCase(),
            },
          ],
        }),
      ),
    ).toThrow("重复");
  });
  it("detects new unrecorded files before NAS certification; rebaseline can include them", async () => {
    const f = await baseline();
    await fs.writeFile(path.join(f.root, "extra.xml"), "extra");
    await expect(verifyPortablePayload(f.root, f.sha256)).rejects.toThrow(
      "新增文件",
    );
    const next = await publishPortableProject(
      await preparePortableProject(f.root, f.project),
      "测试",
    );
    expect(next.document.files).toHaveLength(3);
    await verifyPortablePayload(f.root, next.sha256);
  });
  it("validates exchanged portable history without granting delete authority", () => {
    expect(() => validatePortableHistory([{ root: "/tmp" }])).toThrow();
    expect(() => validatePortableHistory([])).not.toThrow();
  });
  it("automatic compilation retains old hashes, makes no fresh verification claim, and cannot bypass NAS reread", async () => {
    const f = await baseline();
    await fs.writeFile(path.join(f.root, f.rel), "generated-MEDIA");
    const p = await preparePortableProject(f.root, f.project, [], {
      recordedHashesOnly: true,
    });
    expect(p.document.verification).toBe("recorded-hashes");
    expect(p.document.files.find((v) => v.path === f.rel)!.checksum).toBe(
      sha("generated-media"),
    );
    const compiled = await publishPortableProject(p, "自动记录");
    await expect(
      verifyPortablePayload(f.root, compiled.sha256, {
        recordedHashesOnly: true,
      }),
    ).rejects.toThrow("基线不匹配");
  });
  it("updates metadata and devices without rewriting task facts or accepting another identity", async () => {
    const f = await baseline();
    const p = await preparePortableProject(f.root, {
      ...f.project,
      name: "新项目名",
      devices: ["FX3", "临时机"],
    });
    const next = await publishPortableProject(p, "测试");
    expect(next.document.project.devices).toEqual(["FX3", "临时机"]);
    expect(next.document.project.name).toBe("新项目名");
    expect(next.document.project.id).toBe(f.project.id);
    expect(next.document.previousSha256).toBe(f.sha256);
  });
  it("retains a verifiable ancestry across skipped revisions and refuses reverse/foreign chains", async () => {
    const f = await baseline();
    const second = await publishPortableProject(
      await preparePortableProject(f.root, f.project),
      "二次",
    );
    const third = await publishPortableProject(
      await preparePortableProject(f.root, f.project),
      "三次",
    );
    await expect(
      assertPortableRevisionDescends(f.root, third, f.sha256),
    ).resolves.toBeUndefined();
    await expect(
      assertPortableRevisionDescends(f.root, third, second.sha256),
    ).resolves.toBeUndefined();
    await expect(
      assertPortableRevisionDescends(f.root, second, third.sha256),
    ).rejects.toThrow("旧修订");
    await fs.writeFile(
      path.join(f.root, ".kocpyproject-history", `${second.sha256}.json`),
      "corrupt history",
    );
    await expect(
      assertPortableRevisionDescends(f.root, third, f.sha256),
    ).rejects.toThrow("摘要不匹配");
  });
  it("does not ignore supported manifest JSON historical missing entries", async () => {
    const f = await fixture();
    await fs.writeFile(
      path.join(f.root, "manifest-original.json"),
      JSON.stringify({
        files: [
          {
            path: "intentional-absent.mov",
            checksum: sha("old content"),
            size: 11,
          },
        ],
      }),
    );
    const p = await preparePortableProject(f.root, f.project);
    expect(p.document.provenance).toBe("manifest-history");
    expect(p.inspection.missing).toEqual(["intentional-absent.mov"]);
    await expect(publishPortableProject(p, "测试")).rejects.toThrow("逐项确认");
  });
  it("reauthorizes the frozen volume before metadata writes and refuses a swapped disk", async () => {
    const f = await baseline();
    let changed = false,
      calls = 0;
    const p = await preparePortableProject(f.root, f.project, [], {
      authorizeRoot: async () => {
        calls++;
        if (changed) throw new Error("volume identity changed");
      },
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    changed = true;
    await expect(publishPortableProject(p, "测试")).rejects.toThrow(
      "volume identity changed",
    );
    expect((await readPortableProject(f.root))!.sha256).toBe(f.sha256);
  });
});
