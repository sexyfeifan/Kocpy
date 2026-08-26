import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
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
        const info = await driveInfo(p);
        const { stdout } = await exec("/usr/sbin/diskutil", ["info", p], {
          timeout: 6000,
        });
        const source =
          /Protocol:\s+SD Card/i.test(stdout) ||
          (await fs.access(p + "/DCIM").then(
            () => true,
            () => false,
          ));
        const canEject =
          p !== "/" &&
          /Ejectable:\s+Yes|Removable Media:\s+Removable/i.test(stdout);
        return {
          name: p === "/" ? "Macintosh HD" : p.split("/").pop()!,
          path: p,
          ...info,
          deviceType: p === "/" ? "system" : source ? "source" : "destination",
          canEject,
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
  if (!volumes.some((v) => v.path === volume && v.canEject))
    throw new Error("该设备不支持安全推出");
  await exec("/usr/sbin/diskutil", ["eject", volume], { timeout: 15000 });
  return true;
}
