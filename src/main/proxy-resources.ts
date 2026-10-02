import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { volumeIdentity } from "./system";
import { storageDomains } from "./storage-topology";
import type { ProxyResources } from "./proxy-scheduler";
const exec = promisify(execFile);

export async function existingProxyOutputAncestor(directory: string): Promise<string> {
  let current = path.resolve(directory);
  while (true) {
    try { await fs.stat(current); return current; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function assessProxyResources(input: string, output: string): Promise<ProxyResources> {
  const cache = new Map<string, Promise<string>>();
  const query = (node: string) => {
    if (!cache.has(node)) cache.set(node, exec("/usr/sbin/diskutil", ["info", "-plist", node], { timeout: 6000 }).then((result) => result.stdout));
    return cache.get(node)!;
  };
  try {
    const identities = await Promise.all([volumeIdentity(input), existingProxyOutputAncestor(output).then(volumeIdentity)]);
    let solid = true;
    const keys = new Set<string>();
    for (const identity of identities) {
      const topology = identity.deviceNode && process.platform === "darwin"
        ? await storageDomains(identity.deviceNode, query) : { domains: [] };
      if (!topology.domains.length) {
        solid = false;
        keys.add(`mount:${identity.mountSourceDigest || identity.device}`);
      } else {
        for (const domain of topology.domains) {
          keys.add(`physical:${domain}`);
          if (!/<key>SolidState<\/key>\s*<true\s*\/>/.test(await query(domain))) solid = false;
        }
      }
    }
    const autoLimit = solid && os.availableParallelism() >= 4 && os.totalmem() >= 8 * 1024 ** 3 ? 2 : 1;
    return { keys: [...keys], exclusive: !solid, autoLimit,
      reason: solid ? `本地 SSD；自动上限 ${autoLimit}` : "机械盘、网络盘或未知介质：同设备串行" };
  } catch {
    return { keys: ["unknown-storage"], exclusive: true, autoLimit: 1, reason: "磁盘信息暂不可用，保守串行" };
  }
}
