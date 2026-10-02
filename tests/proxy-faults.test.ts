import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
const faults = vi.hoisted(() => ({ errors: [] as string[], encoders: [] as string[] }));
vi.mock("../src/main/proxy-encoder", async original => ({
  ...await original<typeof import("../src/main/proxy-encoder")>(),
  selectProxyEncoder: async () => ({ encoder: "h264_videotoolbox" }),
}));
vi.mock("node:child_process", async original => {
  const { EventEmitter } = await import("node:events");
  return { ...await original<typeof import("node:child_process")>(), spawn: (_binary: string, args: string[]) => {
    const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    faults.encoders.push(args[args.indexOf("-c:v") + 1]);
    let cancelled = false;
    child.kill = () => { cancelled = true; };
    setImmediate(async () => {
      const error = faults.errors.shift();
      if (error) child.stderr.emit("data", Buffer.from(error));
      else if (!cancelled) await fs.writeFile(args.at(-1)!, "synthetic encoded bytes", { flag: "wx" });
      child.emit("close", cancelled || error ? 1 : 0);
    });
    return child;
  } };
});
import { makeProxy } from "../src/main/proxy";
async function fixture(run: (input: string, output: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-fault-"));
  try {
    const input = path.join(root, "source.mov"), output = path.join(root, "proxies");
    await fs.writeFile(input, "synthetic source"); await fs.mkdir(output);
    await fs.writeFile(path.join(output, "existing.mov"), "preserve");
    await run(input, output);
    expect(await fs.readFile(path.join(output, "existing.mov"), "utf8")).toBe("preserve");
    expect((await fs.readdir(output)).some(name => name.startsWith(".kocpy-proxy-"))).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
it("retries only an automatic hardware compatibility failure and records software evidence", async () => {
  faults.errors = ["cannot create compression session"]; faults.encoders = [];
  await fixture(async (input, output) => {
    const result = await makeProxy(input, output, "h264", "720p", { advanced: { encoder: "auto" } });
    expect(faults.encoders).toEqual(["h264_videotoolbox", "libx264"]);
    expect(result.encoder).toBe("libx264"); expect(result.encoderFallback).toBeTruthy();
  });
});
it.each(["No space left on device", "Permission denied", "Input/output error", "Invalid data found"])("does not retry fatal error %s or leave partial output", async message => {
  faults.errors = [message]; faults.encoders = [];
  await fixture(async (input, output) => {
    await expect(makeProxy(input, output, "h264", "720p", { advanced: { encoder: "auto" } })).rejects.toThrow(message);
    expect(faults.encoders).toHaveLength(1);
    expect(await fs.readdir(output)).toEqual(["existing.mov"]);
  });
});
it("hardware-required failure never silently retries", async () => {
  faults.errors = ["cannot create compression session"]; faults.encoders = [];
  await fixture(async (input, output) => {
    await expect(makeProxy(input, output, "h264", "720p", { advanced: { encoder: "hardware" } })).rejects.toThrow("compression");
    expect(faults.encoders).toHaveLength(1);
    expect(await fs.readdir(output)).toEqual(["existing.mov"]);
  });
});
