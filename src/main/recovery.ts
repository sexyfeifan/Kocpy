import { promises as fs, constants } from "node:fs";
import type { BackupTask } from "./types";
import { volumeIdentity, driveInfo } from "./system";
import { compareVolumeIdentity } from "../common/volume-identity";
import type { RecoveryCheck, RecoveryReport } from "../common/recovery";

// Read-only: no hashes are adopted, no task/UUID is changed, and no files are created.
export async function inspectTaskRecovery(
  task: BackupTask,
): Promise<RecoveryReport> {
  const targets = [
    {
      role: "source" as const,
      label: "素材源",
      path: task.sourcePath,
      expectedUuid: task.sourceVolumeUuid,
      expectedId: task.sourceVolumeId,
      required: true,
    },
    ...task.destinations.map((d) => ({
      role: "destination" as const,
      label: d.label,
      path: d.path,
      resolvedPath: d.resolvedPath,
      expectedUuid: d.volumeUuid,
      expectedId: d.volumeId,
      required: !d.verified,
    })),
  ];
  const checks: RecoveryCheck[] = await Promise.all(
    targets.map(async (target) => {
      const check: RecoveryCheck = {
        ...target,
        status: "unavailable",
        blocking: target.required,
        note: "",
      };
      try {
        // Inspect an existing final root as well, not just its selected parent.
        // A missing root can be created during normal retry; other access failures must stop it.
        if ("resolvedPath" in target && target.resolvedPath) {
          try {
            await fs.stat(target.resolvedPath);
            check.path = target.resolvedPath;
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (!(await fs.stat(check.path)).isDirectory())
          throw new Error("记录路径不是文件夹");
        const current = await volumeIdentity(check.path);
        check.current = current;
        check.status = compareVolumeIdentity(
          target.expectedUuid,
          target.expectedId,
          current,
        );
        if (check.status === "changed" || check.status === "unavailable") {
          check.note =
            check.status === "changed"
              ? "当前身份与旧记录不同。连接原盘；换盘请另建任务。"
              : "未读取到原记录要求的 UUID，请检查连接后重试。";
          return check;
        }
        await fs.access(
          check.path,
          target.role === "source" ? constants.R_OK : constants.W_OK,
        );
        if (target.role === "destination") {
          check.freeBytes = (await driveInfo(check.path)).free;
          if (target.required && check.freeBytes <= 0)
            throw new Error("目标盘无可用空间；请处理空间后重新检查");
        }
        check.blocking = false;
        check.note =
          check.status === "legacy-match"
            ? "旧记录未保存 UUID，仅旧设备标识匹配；不是历史完整性证明。正式重试仍会预检和回读。"
            : check.status === "unrecorded"
              ? "旧任务尚无身份记录，重试前会建立本次身份并执行完整预检。"
              : "当前记录身份一致、路径可访问；尚未重新核对素材哈希。";
        if (!target.required)
          check.note += " 此目标已校验，普通失败重试不会改写它。";
      } catch (error: any) {
        check.status = "unavailable";
        check.note = `${error.code ? error.code + " · " : ""}${error.message || error}`;
      }
      return check;
    }),
  );
  const native = !task.provenance || task.provenance === "kocpy-transfer";
  const sourceChanged =
    /素材源.*(变化|改变)|源文件.*(变化|改变)/.test(task.errorMessage || "") &&
    !/磁盘|UUID/.test(task.errorMessage || "");
  return {
    taskId: task.id,
    checkedAt: Date.now(),
    checks,
    canRetry:
      native &&
      ["failed", "cancelled"].includes(task.status) &&
      task.destinations.some((d) => !d.verified) &&
      !checks.some((c) => c.blocking) &&
      !sourceChanged,
    explanation: !native
      ? "这是接管记录，请使用首次基线或外部清单处理，不进行普通复制恢复。"
      : sourceChanged
        ? "源素材已经发生变化，确认当前素材后另建任务，保留旧记录。"
        : "此检查仅确认当前连接、权限和记录身份，不修改任务或素材。恢复前再次检查，只重试未通过目标，仍执行空间预检、断点验证和独立回读。",
  };
}
