import path from "node:path";
import { canonicalCalendarDate } from "../common/calendar-date";
import { taskDateContributions } from "../common/date-allocation";
import type { BackupTask, ProjectConfig } from "./types";
import type { ArchiveTransferContext } from "./archive-transfer";
import { taskOutputRoots } from "./backup/task-output-root";

const contained = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

/** Report context only. A project association cannot enlarge the copied scope
 * or certify missing historical material. Callers canonicalize the selected
 * source and at most the configured project roots, not every offline task. */
export function scopedArchiveTransferContext(
  project: ProjectConfig,
  tasks: BackupTask[],
  canonicalSource: string,
  canonicalProjectRoots: string[],
): ArchiveTransferContext {
  const source = path.resolve(canonicalSource);
  const projectRootSelected = canonicalProjectRoots.some((root) => path.resolve(root) === source);
  const related = tasks.filter((task) => task.projectId === project.id &&
    taskOutputRoots(task).some((root) => contained(source, path.resolve(root))));
  const dates = [...new Set(related.flatMap((task) => taskDateContributions(task)
    .map((item) => canonicalCalendarDate(item.shootingDate)).filter(Boolean)))].sort();
  const history = related.flatMap((task) => {
    const messages: string[] = [];
    if (["failed", "cancelled", "unverified"].includes(task.status))
      messages.push(`${task.name} 的历史任务状态为 ${task.status}`);
    const manifest = task.externalManifest;
    if (manifest && manifest.status !== "verified") messages.push(
      `${task.name} 的既有清单状态为 ${manifest.status}（缺失 ${manifest.missing.length}、额外 ${manifest.extra.length}、大小异常 ${manifest.sizeMismatches.length}、哈希异常 ${manifest.checksumMismatches.length}）`,
    );
    return messages;
  });
  return {
    projectId: project.id,
    archiveName: projectRootSelected ? project.name : `${project.name} · 选定目录 ${path.basename(source)}`,
    archiveNameSource: "project",
    shootingDate: dates.length > 1 ? `${dates[0]} 至 ${dates.at(-1)}` : dates[0] || undefined,
    historicalEvidence: [
      projectRootSelected
        ? "所选源与已配置项目根目录相符；本次只证明冻结源范围的转存，不证明项目历史素材齐全。"
        : "本次仅转存与项目关联的选定目录，不宣称包含整个项目或全部拍摄日。",
      dates.length
        ? "拍摄日期来自所选目录内关联任务的已记录归属，不是按文件时间自动推断，也不是历史完整性证明。"
        : "未从所选目录内的关联任务确认拍摄日期；不以项目计划日期代替。",
      ...[...new Set(history)].slice(0, 198),
    ],
  };
}
