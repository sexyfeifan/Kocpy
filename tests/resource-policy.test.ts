import { describe, expect, it } from "vitest";
import {
  claimBackupPriorityPause,
  mapWithConcurrency,
  resumeBackupPausedProxyJobs,
} from "../src/main/resource-policy";
import type { ProxyJob } from "../src/main/types";

function proxy(id: string, pauseReason?: ProxyJob["pauseReason"]): ProxyJob {
  return {
    id,
    input: `/input/${id}.mov`,
    name: `${id}.mov`,
    outputDir: "/output",
    format: "h264",
    resolution: "1080p",
    status: "paused",
    progress: 42,
    createdAt: 1,
    pauseReason,
  };
}

describe("background resource policy", () => {
  it("bounds asynchronous media probes and preserves result order", async () => {
    let active = 0,
      peak = 0;
    const values = await mapWithConcurrency(
      Array.from({ length: 40 }, (_, index) => index),
      5,
      async (value) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return value * 2;
      },
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(values).toEqual(Array.from({ length: 40 }, (_, index) => index * 2));
  });

  it("only auto-resumes proxies paused by backup priority", () => {
    const jobs = [
      proxy("automatic", "backup-priority"),
      proxy("manual", "user"),
    ];
    expect(resumeBackupPausedProxyJobs(jobs)).toBe(1);
    expect(jobs[0]).toMatchObject({ status: "pending", progress: 0 });
    expect(jobs[0].pauseReason).toBeUndefined();
    expect(jobs[1]).toMatchObject({ status: "paused", pauseReason: "user" });
  });

  it("does not convert an in-flight user pause into an automatic resume", () => {
    const manual = proxy("manual", "user");
    manual.status = "running";
    expect(claimBackupPriorityPause(manual, true)).toBe(false);
    expect(manual.pauseReason).toBe("user");

    const automatic = proxy("automatic");
    automatic.status = "running";
    expect(claimBackupPriorityPause(automatic, false)).toBe(true);
    expect(automatic.pauseReason).toBe("backup-priority");
  });
});
