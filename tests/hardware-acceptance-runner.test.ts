import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = path.resolve("scripts/run-hardware-acceptance.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hardware acceptance command safety", () => {
  it("documents generated data, cleanup scope and explicit confirmation", () => {
    const run = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("256 MiB");
    expect(run.stdout).toContain("1,500 small files");
    expect(run.stdout).toContain("--confirm-write-test");
    expect(run.stdout).toContain("never overwritten");
  });

  it("provides a read-only plan without starting the integration test", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "kocpy-hardware-plan-"));
    roots.push(output);
    const result = path.join(output, "result.json");
    const run = spawnSync(
      process.execPath,
      [
        script,
        "--destination",
        "/Volumes/Kocpy-Disposable-A",
        "--result",
        result,
        "--plan",
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      destinations: ["/Volumes/Kocpy-Disposable-A"],
      result,
      generatedSmallFiles: 1500,
      recommendedFreeBytesPerDestination: 600 * 1024 * 1024,
      existingFilesTouched: false,
    });
  });

  it("refuses nested paths, result files on the target and unconfirmed execution", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "kocpy-hardware-refusal-"));
    roots.push(output);
    const nested = spawnSync(
      process.execPath,
      [script, "--destination", "/Volumes/Test/subfolder", "--result", path.join(output, "a.json"), "--plan"],
      { encoding: "utf8" },
    );
    expect(nested.status).toBe(2);
    expect(nested.stderr).toContain("exact mounted volume root");

    const unsafeResult = spawnSync(
      process.execPath,
      [script, "--destination", "/Volumes/Test", "--result", "/Volumes/Test/result.json", "--plan"],
      { encoding: "utf8" },
    );
    expect(unsafeResult.status).toBe(2);
    expect(unsafeResult.stderr).toContain("outside every tested destination");

    const unconfirmed = spawnSync(
      process.execPath,
      [script, "--destination", "/Volumes/Test", "--result", path.join(output, "b.json")],
      { encoding: "utf8" },
    );
    expect(unconfirmed.status).toBe(2);
    expect(unconfirmed.stderr).toContain("--confirm-write-test");
  });
});
