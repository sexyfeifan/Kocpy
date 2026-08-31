import { describe, it, expect } from "vitest";
import { copyEvidenceSummary } from "../src/common/copy-evidence";
import { storageDomains } from "../src/main/storage-topology";
import { BackupEngine } from "../src/main/backup/BackupEngine";
import type { Destination } from "../src/main/types";

function targets(): Destination[] {
  const task = new BackupEngine().createTask({ name: "synthetic", sourcePath: "/tmp/source", destinationPaths: ["/tmp/a", "/tmp/b"], hashAlgorithm: "sha256", devices: [], namingTemplate: "A001", shootingDate: "" });
  task.destinations.forEach((destination, index) => {
    destination.verified = true;
    destination.volumeUuid = `volume-${index}`;
    destination.storageEvidence = { assessmentId: "inspection-1", checkedAt: 1, volumeUuid: destination.volumeUuid, kind: "local-physical", domains: [`disk${index}`], reason: "test" };
  });
  return task.destinations;
}
describe("independent copy evidence", () => {
  it("treats malformed imported topology as unknown without crashing", () => {
    for (const value of [undefined, null, "disk1", [], ["nonsense"], [null]]) {
      const ds = targets();
      ds[1].storageEvidence!.domains = value as any;
      expect(copyEvidenceSummary(ds)).toMatchObject({ independentCopies: 1, independencePending: true });
    }
    const ds = targets();
    ds[1].storageEvidence!.checkedAt = NaN;
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
  });
  it("requires contemporaneous disjoint physical domains, not just different UUIDs", () => {
    const ds = targets();
    expect(copyEvidenceSummary(ds).independentCopies).toBe(2);
    ds[1].storageEvidence!.domains = ["disk0"];
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
    ds[1].storageEvidence = undefined;
    expect(copyEvidenceSummary(ds)).toMatchObject({ independentCopies: 1, independencePending: true });
    ds[0].storageEvidence = undefined;
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
  });
  it("does not combine node names from different inspections or changed identities", () => {
    const ds = targets();
    ds[1].storageEvidence!.assessmentId = "after-replug";
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
    ds[1].storageEvidence!.assessmentId = "inspection-1";
    ds[1].volumeUuid = "changed";
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
    ds[0].verified = false;
    ds[1].verified = false;
    expect(copyEvidenceSummary(ds).independentCopies).toBe(0);
  });
  it("does not double-count aliases or overlapping multi-disk groups", () => {
    const ds = targets();
    ds[1].volumeUuid = ds[0].volumeUuid!.toUpperCase();
    ds[1].storageEvidence!.volumeUuid = ds[1].volumeUuid;
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
    ds[1].volumeUuid = ds[1].storageEvidence!.volumeUuid = "other-volume";
    ds[0].storageEvidence!.domains = ["disk0", "disk1"];
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
    ds[1].storageEvidence!.kind = "unknown";
    expect(copyEvidenceSummary(ds).independentCopies).toBe(1);
  });
});
const field = (key: string, value: string) => `<key>${key}</key><string>${value}</string>`;
const whole = `<key>WholeDisk</key><true/>${field("VirtualOrPhysical", "Physical")}`;
describe("macOS topology parsing", () => {
  it("maps APFS volumes and ordinary partitions to the same whole disk", async () => {
    const fixture: Record<string, string> = {
      disk3s1: field("APFSPhysicalStore", "disk0s2"),
      disk3s2: field("APFSPhysicalStore", "disk0s2"),
      disk0s2: field("ParentWholeDisk", "disk0"),
      disk0s3: field("ParentWholeDisk", "disk0"), disk0: whole,
    };
    for (const node of ["disk3s1", "disk3s2", "disk0s3"])
      expect((await storageDomains(node, async (key) => fixture[key])).domains).toEqual(["disk0"]);
  });
  it.each(["Virtual", "Unknown"])("does not certify %s disks", async (kind) => {
    expect((await storageDomains("disk1", async () => `<key>WholeDisk</key><true/>${field("VirtualOrPhysical", kind)}`)).domains).toEqual([]);
  });
  it("keeps RAID, query failures, cycles and network stores unknown", async () => {
    for (const xml of [whole + "<key>RAIDMaster</key><true/>", whole + field("MediaName", "Hardware RAID"), field("ParentWholeDisk", "disk1")])
      expect((await storageDomains("disk1", async () => xml)).domains).toEqual([]);
    expect((await storageDomains("disk1", async () => { throw new Error("query failed"); })).domains).toEqual([]);
    expect((await storageDomains("//nas/share", async () => { throw new Error("must not query"); })).domains).toEqual([]);
  });
});
