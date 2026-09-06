import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSourceTreeIssues, sourceTreeIssue, verifySourceTree } from "../scripts/verify-source-tree.mjs";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kocpy-source-tree-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("source tree hygiene gate", () => {
  it("accepts intentional numeric names but identifies common sync artifacts", () => {
    expect(sourceTreeIssue("RELEASE_NOTES_0.1.35.md")).toBeNull();
    expect(sourceTreeIssue("camera-2.ts")).toBeNull();
    expect(sourceTreeIssue("Ui 2.tsx")).toBe("numbered duplicate filename");
    expect(sourceTreeIssue("._Ui.tsx")).toBe("AppleDouble metadata");
    expect(sourceTreeIssue("state (conflicted copy 2026-09-06).json")).toBe("sync conflict copy");
    expect(sourceTreeIssue("asset.png.icloud")).toBe("incomplete iCloud placeholder");
  });

  it("reports exact paths without deleting or changing a conflicting file", async () => {
    const root = await fixture();
    const file = path.join(root, "src", "Ui 2.tsx");
    await writeFile(file, "user-owned copy\n");

    await expect(verifySourceTree(root)).rejects.toThrow("src/Ui 2.tsx");
    expect(await readFile(file, "utf8")).toBe("user-owned copy\n");
    expect(await findSourceTreeIssues(root)).toEqual([
      { path: "src/Ui 2.tsx", issue: "numbered duplicate filename" },
    ]);
  });

  it("passes a clean source fixture", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "src", "Ui.tsx"), "export {};\n");
    await expect(verifySourceTree(root)).resolves.toEqual([]);
  });
});
