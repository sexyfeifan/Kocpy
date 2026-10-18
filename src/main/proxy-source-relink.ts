import { promises as fs } from "node:fs";
import path from "node:path";
import { safeChild, inside } from "./backup/safety";
import { hashFile } from "./backup/BackupEngine";
import type { BackupTask, ProxyJob } from "./types";

/** Rebind only pending/paused/failed jobs with the exact frozen task/file/hash.
 * Already-produced outputs and running encoders are never retargeted. */
export async function relinkProxySources(jobs: ProxyJob[], task: BackupTask, previousRoot: string,
  root: string, operator: string): Promise<ProxyJob[]> {
  const verified = new Map<string, { path: string; modifiedAt: number }>();
  const result: ProxyJob[] = [];
  for (const job of jobs) {
    if (!previousRoot || !["pending", "paused", "failed"].includes(job.status) ||
      job.sourceTaskId !== task.id || !inside(job.input, previousRoot)) { result.push(job); continue; }
    const evidence = job.sourceEvidence;
    const record = task.fileRecords.find(file => file.relativePath === job.sourceRelativePath);
    if (!evidence || !record || evidence.taskId !== task.id || evidence.relativePath !== record.relativePath ||
      evidence.path !== job.input || path.resolve(job.input) !== path.resolve(previousRoot, record.relativePath) ||
      evidence.hashAlgorithm !== task.hashAlgorithm || evidence.checksum !== record.srcChecksum || evidence.bytes !== record.size) {
      // Keep legacy evidence unchanged; never invent the missing original binding.
      result.push({ ...job, error: "副本位置已更新，但此代理缺少一致的冻结源证据；请从素材库重新加入代理队列" });
      continue;
    }
    let target = verified.get(record.relativePath);
    if (!target) {
      const file = await safeChild(root, record.relativePath), before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== record.size ||
        await hashFile(file, task.hashAlgorithm) !== evidence.checksum)
        throw new Error(`代理新位置与冻结源证据不符：${record.relativePath}；未修改代理队列`);
      const after = await fs.lstat(file);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || after.size !== before.size)
        throw new Error(`代理新位置在核对期间发生变化：${record.relativePath}`);
      target = { path: file, modifiedAt: after.mtimeMs }; verified.set(record.relativePath, target);
    }
    const at = Date.now();
    result.push({ ...job, input: target.path, sourceEvidence: { ...evidence, path: target.path,
      modifiedAt: target.modifiedAt, capturedAt: at },
      sourceRelinks: [...(job.sourceRelinks || []), { from: job.input, to: target.path, operator, at,
        checksum: evidence.checksum, hashAlgorithm: evidence.hashAlgorithm }],
      outputEvidence: undefined, validation: undefined, deliveryApproval: undefined, deliveryCheck: undefined,
      preflight: undefined, error: undefined,
    });
  }
  return result;
}
