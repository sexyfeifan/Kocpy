import type { Destination } from "../main/types";

/** Device node names are comparable ONLY within one observed topology snapshot.
 * They are not persistent hardware identities and must never be mixed across
 * retries, machines or historical imports. */
export interface StorageEvidence {
  assessmentId: string;
  checkedAt: number;
  volumeUuid?: string;
  kind: "local-physical" | "unknown";
  domains: string[];
  reason: string;
}

export function volumeCopyKey(destination: Destination): string {
  if (destination.volumeUuid) return `uuid:${destination.volumeUuid.toUpperCase()}`;
  if (destination.volumeId) return `id:${destination.volumeId}`;
  return "unknown-volume";
}

/** A single verified instance is one copy; unknown relations never add a second
 * independent copy. Up to four destinations: enumerate disjoint subsets rather
 * than greedily counting (overlapping multi-disk containers are possible). */
export function copyEvidenceSummary(destinations: Destination[]) {
  const verified = destinations.filter((d) => d.verified);
  const groups = new Map<string, Destination[]>();
  let unknown = 0;
  for (const destination of verified) {
    const evidence = destination.storageEvidence;
    if (!evidence || evidence.kind !== "local-physical" ||
      typeof evidence.assessmentId !== "string" || !evidence.assessmentId ||
      !Number.isFinite(evidence.checkedAt) || evidence.checkedAt <= 0 ||
      !Array.isArray(evidence.domains) || !evidence.domains.length || evidence.domains.length > 16 ||
      !evidence.domains.every((domain) => typeof domain === "string" && /^disk\d+$/.test(domain)) ||
      typeof evidence.volumeUuid !== "string" || !evidence.volumeUuid ||
      typeof destination.volumeUuid !== "string" || !destination.volumeUuid ||
      evidence.volumeUuid.toUpperCase() !== destination.volumeUuid.toUpperCase()) {
      unknown++;
      continue;
    }
    const group = groups.get(evidence.assessmentId) || [];
    group.push(destination);
    groups.set(evidence.assessmentId, group);
  }
  let independentCopies = verified.length ? 1 : 0;
  for (const group of groups.values()) {
    // Invalid imported records do not get an exponential path or a safety claim.
    if (group.length > 4) { unknown += group.length; continue; }
    for (let mask = 1; mask < 2 ** group.length; mask++) {
      const domains = new Set<string>(), volumes = new Set<string>();
      let count = 0, disjoint = true;
      for (let index = 0; index < group.length; index++) {
        if (!(mask & (1 << index))) continue;
        const item = group[index], key = volumeCopyKey(item);
        const current = item.storageEvidence!.domains;
        if (volumes.has(key) || current.some((domain) => domains.has(domain))) {
          disjoint = false;
          break;
        }
        volumes.add(key);
        current.forEach((domain) => domains.add(domain));
        count++;
      }
      if (disjoint) independentCopies = Math.max(independentCopies, count);
    }
  }
  return {
    verifiedTargets: verified.length,
    independentCopies,
    independencePending: verified.length > 1 && (unknown > 0 || groups.size > 1),
    unknownTargets: unknown,
  };
}
