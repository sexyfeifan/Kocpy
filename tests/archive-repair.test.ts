import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { repairArchiveFile } from "../src/main/archive-repair";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-archive-repair-"));
  roots.push(root);
  const sourcePath = path.join(root, "healthy.bin"),
    targetPath = path.join(root, "archive", "clip.bin"),
    source = Buffer.from("authoritative healthy content"),
    damaged = Buffer.from("damaged original content");
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(sourcePath, source);
  await fs.writeFile(targetPath, damaged);
  return {
    root,
    sourcePath,
    targetPath,
    source,
    damaged,
    checksum: createHash("sha256").update(source).digest("hex"),
  };
}

describe("archive repair publication", () => {
  it("rehashes the source, preserves the damaged original and verifies publication", async () => {
    const data = await fixture(),
      result = await repairArchiveFile({
        sourcePath: data.sourcePath,
        targetPath: data.targetPath,
        expectedChecksum: data.checksum,
        hashAlgorithm: "sha256",
      });
    expect(await fs.readFile(data.targetPath)).toEqual(data.source);
    expect(result.preservedPath).toBeTruthy();
    expect(await fs.readFile(result.preservedPath!)).toEqual(data.damaged);
    expect(result.publishedChecksum).toBe(data.checksum);
  });

  it.each(["after-copy", "after-preserve", "after-publish"] as const)(
    "never deletes the last preserved bytes when failure is injected %s",
    async (failAt) => {
      const data = await fixture();
      let preservedPath: string | undefined;
      await expect(
        repairArchiveFile({
          sourcePath: data.sourcePath,
          targetPath: data.targetPath,
          expectedChecksum: data.checksum,
          hashAlgorithm: "sha256",
          failAt,
          onPreserved: (value) => {
            preservedPath = value;
          },
        }),
      ).rejects.toThrow("注入故障");
      const files = await fs.readdir(path.dirname(data.targetPath));
      expect(files.some((name) => name.includes(".partial"))).toBe(false);
      const contents = await Promise.all(
        files.map((name) => fs.readFile(path.join(path.dirname(data.targetPath), name))),
      );
      expect(contents.some((bytes) => bytes.equals(data.damaged))).toBe(true);
      if (failAt === "after-preserve" || failAt === "after-publish") {
        expect(preservedPath).toBeTruthy();
        expect(await fs.readFile(preservedPath!)).toEqual(data.damaged);
      } else expect(preservedPath).toBeUndefined();
    },
  );

  it("refuses a source that no longer matches the baseline", async () => {
    const data = await fixture();
    await fs.writeFile(data.sourcePath, "changed source");
    await expect(
      repairArchiveFile({
        sourcePath: data.sourcePath,
        targetPath: data.targetPath,
        expectedChecksum: data.checksum,
        hashAlgorithm: "sha256",
      }),
    ).rejects.toThrow("权威基线");
    expect(await fs.readFile(data.targetPath)).toEqual(data.damaged);
  });
});
