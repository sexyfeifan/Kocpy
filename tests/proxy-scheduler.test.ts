import { expect, it } from "vitest";
import { ProxyRunRegistry, validateProxyConcurrency, type ProxyResources } from "../src/main/proxy-scheduler";
import { resumeBackupPausedProxyJobs } from "../src/main/resource-policy";
import type { ProxyJob } from "../src/main/types";

const ssd: ProxyResources = { keys: ["physical:ssd"], exclusive: false, autoLimit: 2, reason: "SSD" };
const job = (id: string, concurrency: ProxyJob["concurrency"] = 2) => ({ id, concurrency, status: "pending" } as ProxyJob);

it("latches persistence failure until an explicit successful save recovery", () => {
  const runs = new ProxyRunRegistry();
  const controller = runs.reserve(job("active"), ssd, 3)!;
  runs.failPersistence(new Error("disk full"));
  expect(runs.persistenceError).toContain("disk full");
  expect(runs.reserve(job("next"), ssd, 3)).toBeUndefined();
  expect(controller.signal.aborted).toBe(false);
  runs.release("active");
  expect(runs.reserve(job("next"), ssd, 3)).toBeUndefined();
  runs.persistenceError = undefined;
  expect(runs.reserve(job("next"), ssd, 3)).toBeDefined();
});

it("reserves slots atomically, rejects duplicate launches and respects batch and global limits", () => {
  const runs = new ProxyRunRegistry();
  expect(runs.reserve(job("one"), ssd, 3)).toBeDefined();
  expect(runs.reserve(job("one"), ssd, 3)).toBeUndefined();
  expect(runs.reserve(job("two"), ssd, 3)).toBeDefined();
  expect(runs.reserve(job("three", 3), ssd, 3)).toBeUndefined();
  runs.release("one");
  runs.release("two");
  for (const id of ["a", "b", "c"]) expect(runs.reserve(job(id, 3), ssd, 3)).toBeDefined();
  // Lowering the ceiling does not abort already running workers.
  expect(runs.reserve(job("d", 3), ssd, 1)).toBeUndefined();
  expect([...runs.runs.values()].every((run) => !run.controller.signal.aborted)).toBe(true);
});

it("serializes shared mechanical/network resources and treats unknown discovery as exclusive", () => {
  const runs = new ProxyRunRegistry();
  const disk = { ...ssd, exclusive: true, autoLimit: 1 as const };
  expect(runs.reserve(job("disk", 3), disk, 3)).toBeDefined();
  expect(runs.reserve(job("same", 3), ssd, 3)).toBeUndefined();
  expect(runs.reserve(job("other", 3), { ...ssd, keys: ["physical:other"] }, 3)).toBeDefined();
  expect(runs.reserve(job("unknown", 3), { ...disk, keys: ["unknown-storage"] }, 3)).toBeUndefined();
  runs.release("disk"); runs.release("other");
  expect(runs.reserve(job("automatic", "auto"), disk, 3)).toBeDefined();
  expect(runs.reserve(job("other-auto", "auto"), { ...ssd, keys: ["other"] }, 3)).toBeUndefined();
});

it("pauses every worker for backup while preserving user pauses and individual cancellation", () => {
  const runs = new ProxyRunRegistry();
  const jobs = [job("a", 3), job("b", 3), job("c", 3)];
  const signals = jobs.map((item) => runs.reserve(item, ssd, 3)!.signal);
  runs.pause(jobs[0], "user");
  for (const item of jobs) runs.pause(item, "backup-priority");
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(jobs.map((item) => item.pauseReason)).toEqual(["user", "backup-priority", "backup-priority"]);
  // Cancelling a worker whose pause is in flight must remain cancellation.
  runs.cancel("c");
  expect(runs.runs.get("c")!.pauseReason).toBeUndefined();
  expect(runs.runs.get("a")!.pauseReason).toBe("user");
  for (const item of jobs) { item.status = "paused"; runs.release(item.id); }
  jobs[2].status = "cancelled";
  expect(runs.busy).toBe(false);
  expect(resumeBackupPausedProxyJobs(jobs)).toBe(1);
  expect(jobs.map((item) => item.status)).toEqual(["paused", "pending", "cancelled"]);
});

it("does not let backup turn an in-flight cancellation into an automatic pause", () => {
  const runs = new ProxyRunRegistry(), item = job("cancel");
  runs.reserve(item, ssd, 2);
  runs.cancel(item.id);
  expect(runs.pause(item, "backup-priority")).toBe(false);
  expect(item.pauseReason).toBeUndefined();
});

it("rejects invalid IPC and persisted concurrency choices", () => {
  for (const value of [0, 4, -1, NaN, "2", null]) expect(() => validateProxyConcurrency(value)).toThrow();
  expect(validateProxyConcurrency("auto")).toBe("auto");
  expect(new ProxyRunRegistry().reserve(job("legacy", undefined), ssd, 3)).toBeDefined();
});
