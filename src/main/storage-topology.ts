import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { diskPlistField, volumeIdentity } from "./system";
import { assertVolumeIdentity } from "../common/volume-identity";
import type { StorageEvidence } from "../common/copy-evidence";
import type { Destination } from "./types";

const exec = promisify(execFile);
type Query = (device: string) => Promise<string>;
const flag = (xml: string, key: string) => new RegExp(`<key>${key}</key>\\s*<true\\s*/>`).test(xml);

/** Resolve known local partitions/APFS stores to whole devices. Network, disk
 * images and opaque RAID stay unknown. No serials/private paths are persisted. */
export async function storageDomains(device: string, query: Query): Promise<{ domains: string[]; reason: string }> {
  const visited = new Set<string>();
  async function visit(node: string): Promise<string[]> {
    if (!/^disk\d+(?:s\d+)*$/.test(node) || visited.size >= 16 || visited.has(node))
      throw new Error("无法确定存储拓扑");
    visited.add(node);
    const xml = await query(node);
    if (flag(xml, "RAIDMaster") || flag(xml, "RAIDSlice") ||
      /raid/i.test(diskPlistField(xml, "MediaName") || ""))
      throw new Error("阵列底层关系未知");
    const stores = [...xml.matchAll(/<key>APFSPhysicalStore<\/key>\s*<string>(disk\d+(?:s\d+)*)<\/string>/g)].map((m) => m[1]);
    if (stores.length) return (await Promise.all(stores.map(visit))).flat();
    const whole = diskPlistField(xml, "ParentWholeDisk");
    if (!flag(xml, "WholeDisk")) {
      if (!whole || whole === node) throw new Error("缺少物理磁盘关系");
      return visit(whole);
    }
    const physical = diskPlistField(xml, "VirtualOrPhysical");
    // Apple Silicon internal SSDs report Unknown despite being the built-in media.
    const appleInternal = flag(xml, "Internal") &&
      diskPlistField(xml, "BusProtocol") === "Apple Fabric" &&
      /^APPLE SSD /i.test(diskPlistField(xml, "MediaName") || "");
    if (physical !== "Physical" && !appleInternal)
      throw new Error("虚拟磁盘或底层介质关系未知");
    return [node];
  }
  try {
    const domains = [...new Set(await visit(device.replace(/^\/dev\//, "")))].sort();
    return { domains, reason: "同次系统拓扑检查：分区与 APFS 物理存储归并到整盘；不代表供电、机箱或灾备独立。" };
  } catch (error) {
    return { domains: [], reason: error instanceof Error ? error.message : "物理存储关系未知" };
  }
}

/** Called after readback, never as a substitute for it. One snapshot for all
 * verified destinations also prevents an old retry from inflating the count. */
export async function refreshStorageEvidence(destinations: Destination[]) {
  const assessmentId = randomUUID(), checkedAt = Date.now();
  const cache = new Map<string, Promise<string>>();
  const query: Query = (node) => {
    if (!cache.has(node)) cache.set(node, exec("/usr/sbin/diskutil", ["info", "-plist", node], { timeout: 6000 }).then((r) => r.stdout));
    return cache.get(node)!;
  };
  const results = await Promise.all(destinations.filter((d) => d.verified).map(async (destination) => {
    const identity = await volumeIdentity(destination.resolvedPath || destination.path);
    assertVolumeIdentity(destination.volumeUuid, destination.volumeId, identity, `${destination.label} `);
    const topology = identity.deviceNode && process.platform === "darwin"
      ? await storageDomains(identity.deviceNode, query)
      : { domains: [], reason: "网络存储或此平台没有可验证的物理拓扑" };
    const evidence: StorageEvidence = {
      assessmentId, checkedAt, volumeUuid: identity.uuid,
      kind: topology.domains.length ? "local-physical" : "unknown", ...topology,
    };
    return { destination, evidence };
  }));
  // Reconfirm all mount identities after querying topology, before committing.
  for (const { destination, evidence } of results) {
    const current = await volumeIdentity(destination.resolvedPath || destination.path);
    assertVolumeIdentity(evidence.volumeUuid, destination.volumeId, current, `${destination.label} `);
  }
  for (const { destination, evidence } of results) destination.storageEvidence = evidence;
}
