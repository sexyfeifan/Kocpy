import { it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
vi.mock("node:crypto", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: () => "12345678-1234-1234-1234-123456789012",
}));
import { makeProxy } from "../src/main/proxy";
import { ffmpegPath } from "../src/main/ffmpeg";
it("does not overwrite a colliding proxy or remove another job's staging file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kocpy-proxy-exclusive-"));
  try {
    const input = path.join(root, "input.mp4"), output = path.join(root, "proxy");
    await fs.mkdir(output);
    await promisify(execFile)(ffmpegPath(), ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-t", "0.5", "-c:v", "libx264", input]);
    const final = path.join(output, "input_proxy_720p_123456.mp4");
    const otherPartial = path.join(output, "input_proxy_720p_123456.partial.mp4");
    await fs.writeFile(final, "existing final");
    await fs.writeFile(otherPartial, "another job");
    await expect(makeProxy(input, output, "h264", "720p")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(final, "utf8")).toBe("existing final");
    expect(await fs.readFile(otherPartial, "utf8")).toBe("another job");
    expect((await fs.readdir(output)).sort()).toEqual([path.basename(final), path.basename(otherPartial)].sort());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
