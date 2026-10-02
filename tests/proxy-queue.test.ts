import { expect, it } from "vitest";
import type { ProxyJob } from "../src/main/types";
import { mutateProxyQueue, orderedPendingProxies, reprioritizeProxy } from "../src/main/proxy-queue";
const job = (id: string, status: ProxyJob["status"] = "pending", createdAt = 1) => ({ id, status, createdAt } as ProxyJob);
it("orders priority then stable queue position without starting dependent or active jobs", () => {
  const jobs = [job("a"), job("b", "pending", 2), job("active", "running")];
  reprioritizeProxy(jobs, "b", 2);
  expect(orderedPendingProxies(jobs).map((item) => item.id)).toEqual(["b", "a"]);
  reprioritizeProxy(jobs, "a", 0, "b");
  expect(orderedPendingProxies(jobs).map((item) => item.id)).toEqual(["a", "b"]);
  expect(() => reprioritizeProxy(jobs, "active", 1)).toThrow("等待");
  expect(() => reprioritizeProxy(jobs, "a", 4)).toThrow("优先级");
});
it("batch controls target exact ids, keep completed outputs and clear stale retry approval", () => {
  const jobs = [job("a"), job("b", "running"), job("c", "completed"), job("failed", "failed")];
  const paused: string[] = [], cancelled: string[] = [];
  const controls = { pause: (job: ProxyJob) => { paused.push(job.id); }, cancel: (job: ProxyJob) => { cancelled.push(job.id); } };
  expect(() => mutateProxyQueue(jobs, ["a", "missing"], "cancel", controls)).toThrow("不存在");
  expect(jobs[0].status).toBe("pending");
  expect(mutateProxyQueue(jobs, ["a", "b", "c"], "pause", controls)).toBe(2);
  expect(paused).toEqual(["b"]); expect(jobs[0].pauseReason).toBe("user");
  expect(mutateProxyQueue(jobs, ["a", "b", "c"], "cancel", controls)).toBe(2);
  expect(cancelled).toEqual(["b"]); expect(jobs[2].status).toBe("completed");
  jobs[3].deliveryApproval = {} as any;
  expect(mutateProxyQueue(jobs, ["failed"], "retry", controls)).toBe(1);
  expect(jobs[3].deliveryApproval).toBeUndefined();
  expect(() => mutateProxyQueue(jobs, ["a", "a"], "retry", controls)).toThrow("不同");
});
