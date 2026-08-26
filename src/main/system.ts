import { promises as fs, constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export async function volumeIdentity(dir: string) {
  const stat = await fs.stat(dir);
  let output = "";
  try { output = (await exec("/usr/sbin/diskutil", ["info", dir], { timeout: 6000 })).stdout; } catch { /* Network mounts may not be represented by diskutil. */ }
  const field = (name: string) => output.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const uuid = field("Volume UUID") || field("Disk / Partition UUID");
  const deviceNode = field("Device Node");
  const name = field("Volume Name") || (dir === "/" ? "Macintosh HD" : dir.split("/").filter(Boolean).pop()) || dir;
  return { id: uuid || deviceNode || String(stat.dev), uuid, deviceNode, name, device: String(stat.dev) };
}
export async function driveInfo(dir: string) {
  const st = await fs.statfs(dir);
  return {
    total: st.blocks * st.bsize,
    free: st.bavail * st.bsize,
    used: (st.blocks - st.bfree) * st.bsize,
  };
}
export async function listVolumes() {
  const names = await fs.readdir("/Volumes");
  const roots = [
    "/",
    ...names.filter((n) => n !== "Macintosh HD").map((n) => "/Volumes/" + n),
  ];
  const rows = await Promise.all(
    roots.map(async (p) => {
      try {
        const started = performance.now();
        const info = await driveInfo(p);
        const latencyMs = Math.round(performance.now() - started);
        let stdout = "";
        try { stdout = (await exec("/usr/sbin/diskutil", ["info", p], { timeout: 6000 })).stdout; } catch { /* Network filesystems may not have diskutil metadata. */ }
        const mountOutput = await exec("/sbin/mount", [], { timeout: 6000 }).then((result) => result.stdout, () => "");
        const escaped = p.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
        const mountLine = mountOutput.split("\n").find((line) => new RegExp(` on \${escaped} \\\(`).test(line)) || "";
        const protocol = mountLine.match(/\(([^,\s]+)/)?.[1] || (/Protocol:\s*(.+)/i.exec(stdout)?.[1]?.trim()) || "local";
        const isNetwork = /smbfs|nfs|afpfs|webdav|cifs/i.test(protocol + " " + mountLine);
        const writable = await fs.access(p, constants.W_OK).then(() => true, () => false);
        const source =
          /Protocol:\s+SD Card/i.test(stdout) ||
          (await fs.access(p + "/DCIM").then(
            () => true,
            () => false,
          ));
        const canEject =
          p !== "/" &&
          (isNetwork || /Ejectable:\s+Yes|Removable Media:\s+Removable/i.test(stdout));
        return {
          name: p === "/" ? "Macintosh HD" : p.split("/").pop()!,
          path: p,
          ...info,
          deviceType: p === "/" ? "system" : source ? "source" : isNetwork ? "network" : "destination",
          canEject,
          isNetwork,
          protocol,
          latencyMs,
          writable,
          identity: await volumeIdentity(p),
        };
      } catch {
        return null;
      }
    }),
  );
  return rows.filter((v): v is NonNullable<typeof v> => v !== null);
}
export async function ejectVolume(volume: string) {
  const volumes = await listVolumes();
  const target = volumes.find((v) => v.path === volume && v.canEject);
  if (!target)
    throw new Error("该设备不支持安全推出");
  await exec("/usr/sbin/diskutil", [target.isNetwork ? "unmount" : "eject", volume], { timeout: 15000 });
  return true;
}
