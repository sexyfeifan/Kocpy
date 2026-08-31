import { promises as fs, constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { VolumeIdentity } from "../common/volume-identity";
const exec = promisify(execFile);
export function isTimeMachineVolume(
  name: string,
  diskInfo = "",
  mountLine = "",
) {
  return (
    name === ".timemachine" ||
    /^com\.apple\.TimeMachine(?:\.|$)/i.test(name) ||
    /Backups\.backupdb/i.test(name) ||
    /的备份$/.test(name) ||
    /(?:\/\.timemachine|com\.apple\.TimeMachine|Time Machine|Role:\s*Backup)/i.test(
      diskInfo + " " + mountLine,
    )
  );
}
export function parseDfMount(output: string) {
  for (const line of output.split("\n").reverse()) {
    const match = line.match(/^(.+?)\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/);
    if (match)
      return { filesystem: match[1].trim(), mountPoint: match[2].trim() };
  }
  throw new Error("无法确定路径所属的挂载卷，请检查磁盘连接后重试");
}
export function diskPlistField(output: string, key: string) {
  return output
    .match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1]
    ?.replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
export async function volumeIdentity(dir: string): Promise<VolumeIdentity> {
  const resolved = await fs.realpath(dir),
    stat = await fs.stat(resolved);
  const mount = parseDfMount(
    (await exec("/bin/df", ["-P", resolved], { timeout: 6000 })).stdout,
  );
  if ((await fs.stat(mount.mountPoint)).dev !== stat.dev)
    throw new Error("路径所属磁盘在检查期间发生变化，请重新检查连接");
  let output = "";
  const localDisk =
    process.platform === "darwin" && /^\/dev\/disk\d/.test(mount.filesystem);
  if (localDisk) {
    try {
      // diskutil accepts the device / mount point, NOT an arbitrary child directory.
      output = (
        await exec("/usr/sbin/diskutil", ["info", "-plist", mount.filesystem], {
          timeout: 6000,
        })
      ).stdout;
    } catch {
      throw new Error(
        "磁盘身份暂时无法读取，已安全停止。请检查连接并重新检查；不能据此判定 UUID 已变化。",
      );
    }
  }
  const uuid =
    diskPlistField(output, "VolumeUUID") || diskPlistField(output, "DiskUUID");
  if (localDisk && !uuid)
    throw new Error(
      "磁盘身份查询未返回 UUID，已安全停止。请重新检查连接，不要将未知身份视为原磁盘。",
    );
  if (
    (await fs.stat(resolved)).dev !== stat.dev ||
    (await fs.stat(mount.mountPoint)).dev !== stat.dev
  )
    throw new Error("磁盘在身份检查期间已断开或更换，请重新检查连接");
  const reportedMount = diskPlistField(output, "MountPoint");
  if (reportedMount && (await fs.stat(reportedMount)).dev !== stat.dev)
    throw new Error("磁盘查询结果与当前路径不一致，已安全停止");
  const deviceNode = diskPlistField(output, "DeviceNode");
  return {
    id: uuid || String(stat.dev),
    uuid,
    deviceNode,
    name:
      diskPlistField(output, "VolumeName") ||
      path.basename(mount.mountPoint) ||
      "Macintosh HD",
    device: String(stat.dev),
    mountPoint: mount.mountPoint,
    fileSystem: diskPlistField(output, "FilesystemType"),
  };
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
    ...names
      .filter((n) => n !== "Macintosh HD" && !isTimeMachineVolume(n))
      .map((n) => "/Volumes/" + n),
  ];
  const rows = await Promise.all(
    roots.map(async (p) => {
      try {
        const started = performance.now();
        const info = await driveInfo(p);
        const latencyMs = Math.round(performance.now() - started);
        let stdout = "";
        try {
          stdout = (
            await exec("/usr/sbin/diskutil", ["info", p], { timeout: 6000 })
          ).stdout;
        } catch {
          /* Network filesystems may not have diskutil metadata. */
        }
        const mountOutput = await exec("/sbin/mount", [], {
          timeout: 6000,
        }).then(
          (result) => result.stdout,
          () => "",
        );
        const escaped = p.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
        const mountLine =
          mountOutput
            .split("\n")
            .find((line) => new RegExp(` on ${escaped} \\\(`).test(line)) || "";
        if (isTimeMachineVolume(pathName(p), stdout, mountLine)) return null;
        const protocol =
          mountLine.match(/\(([^,\s]+)/)?.[1] ||
          /Protocol:\s*(.+)/i.exec(stdout)?.[1]?.trim() ||
          "local";
        const isNetwork = /smbfs|nfs|afpfs|webdav|cifs/i.test(
          protocol + " " + mountLine,
        );
        const writable = await fs.access(p, constants.W_OK).then(
          () => true,
          () => false,
        );
        const source =
          /Protocol:\s+SD Card/i.test(stdout) ||
          (await fs.access(p + "/DCIM").then(
            () => true,
            () => false,
          ));
        const canEject =
          p !== "/" &&
          (isNetwork ||
            /Ejectable:\s+Yes|Removable Media:\s+Removable/i.test(stdout));
        return {
          name: p === "/" ? "Macintosh HD" : p.split("/").pop()!,
          path: p,
          ...info,
          deviceType:
            p === "/"
              ? "system"
              : source
                ? "source"
                : isNetwork
                  ? "network"
                  : "destination",
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
function pathName(value: string) {
  return value.split("/").filter(Boolean).pop() || value;
}
export function resolveEjectTarget<
  T extends { path: string; canEject: boolean },
>(volumes: T[], volume: string): T | undefined {
  const requested = path.resolve(volume),
    target = volumes
      .filter(
        (candidate) =>
          candidate.canEject &&
          (requested === path.resolve(candidate.path) ||
            requested.startsWith(`${path.resolve(candidate.path)}${path.sep}`)),
      )
      .sort((left, right) => right.path.length - left.path.length)[0];
  return target;
}
export async function ejectVolume(volume: string) {
  const volumes = await listVolumes(),
    target = resolveEjectTarget(volumes, volume);
  if (!target) throw new Error("该设备不支持安全推出");
  await exec(
    "/usr/sbin/diskutil",
    [target.isNetwork ? "unmount" : "eject", target.path],
    { timeout: 15000 },
  );
  return true;
}
