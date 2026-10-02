import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
it("plans read-only generated scope and refuses existing results, app-contained paths and unknown options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-runner-"));
  try {
    const app = path.join(root, "Kocpy.app"), result = path.join(root, "result.json");
    await fs.mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
    await fs.mkdir(path.join(app, "Contents/Resources"));
    await fs.writeFile(path.join(app, "Contents/MacOS/Kocpy"), "not executed in plan");
    await fs.writeFile(path.join(app, "Contents/Resources/app.asar"), "fixture");
    const run = (args: string[]) => spawnSync(process.execPath, ["scripts/run-proxy-acceptance.mjs", ...args], { encoding: "utf8" });
    const args = ["--app", app, "--result", result, "--plan"];
    expect(run(args).status).toBe(0);
    expect(JSON.parse(run(args).stdout)).toMatchObject({ applicationReadOnly: true, generatedFixturesOnly: true, nleImportExecuted: false, physicalStorageExecuted: false });
    expect(await fs.stat(result).catch(() => undefined)).toBeUndefined();
    expect(run(["--app", app, "--result", path.join(app, "result.json"), "--plan"]).status).not.toBe(0);
    await fs.writeFile(result, "existing");
    expect(run(args).status).not.toBe(0);
    expect(await fs.readFile(result, "utf8")).toBe("existing");
    expect(run(["--unexpected"]).status).not.toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
