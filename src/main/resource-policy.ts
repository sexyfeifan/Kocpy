import type { ProxyJob } from "./types";

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const count = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency) || 1),
  );
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export function resumeBackupPausedProxyJobs(jobs: ProxyJob[]) {
  let resumed = 0;
  for (const job of jobs)
    if (job.status === "paused" && job.pauseReason === "backup-priority") {
      job.status = "pending";
      job.pauseReason = undefined;
      job.error = undefined;
      job.progress = 0;
      resumed++;
    }
  return resumed;
}

export function claimBackupPriorityPause(
  job: ProxyJob,
  pauseAlreadyRequested: boolean,
) {
  if (pauseAlreadyRequested) return false;
  job.pauseReason = "backup-priority";
  return true;
}
