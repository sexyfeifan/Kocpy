import { projectDates } from "../common/shooting-dates";
import { assertProjectDayDeviceAllowed } from "../common/project-day-devices";
import { requireCalendarDate } from "../common/calendar-date";
import { assertProjectTimeRules, shootingTimeZone } from "../common/time-context";
import { makeProjectFolderName } from "./project-path";
import type { BackupTask, ProjectConfig, TaskConfig } from "./types";

const staleProjectPathMessage =
  "项目目录配置已变化，请重新选择项目并核对路径后再开始";

function realCalendarDate(value: string): string {
  return requireCalendarDate(
    value,
    "拍摄日期无效，请重新选择真实拍摄日",
  );
}

/**
 * Authorize a new project task against the current main-process project.
 *
 * Project path metadata is deliberately compared before it is replaced. This
 * makes an already-open composer fail closed after a project rename or rule
 * edit instead of silently writing to a path different from the one reviewed
 * by the operator. Existing tasks and their frozen paths are never rewritten.
 */
export function authorizeProjectTaskConfig(
  project: ProjectConfig,
  projectTasks: BackupTask[],
  config: TaskConfig,
): TaskConfig {
  if (!config.projectId || config.projectId !== project.id)
    throw new Error("备份请求与当前拍摄项目不一致，请重新选择项目");

  const shootingDate = realCalendarDate(config.shootingDate);
  assertProjectTimeRules(project);
  if (config.projectTimeZone !== project.projectTimeZone || config.shootingTimeZone !== shootingTimeZone(project, shootingDate) || config.shootingDayBoundaryHour !== project.shootingDayBoundaryHour)
    throw new Error("项目拍摄时区或大夜规则已变化，请重新打开备份并核对日期范围");
  const expectedMetadata: Pick<
    TaskConfig,
    | "projectName"
    | "projectStartDate"
    | "projectFolderName"
    | "projectNamingRule"
  > = {
    projectName: project.name,
    projectStartDate: project.shootingDateStart || project.shootingDate,
    projectFolderName:
      project.projectFolderName ||
      makeProjectFolderName(
        project.shootingDateStart || project.shootingDate || shootingDate,
        project.name,
      ),
    projectNamingRule: project.namingRule,
  };
  const metadataFields = Object.keys(expectedMetadata) as Array<
    keyof typeof expectedMetadata
  >;
  if (
    metadataFields.some(
      (field) =>
        !Object.prototype.hasOwnProperty.call(config, field) ||
        config[field] !== expectedMetadata[field],
    )
  )
    throw new Error(staleProjectPathMessage);

  const related = projectTasks.filter((task) => task.projectId === project.id);
  if (!projectDates(project, related).includes(shootingDate))
    throw new Error("拍摄日期不在当前项目拍摄周期内");
  if (config.devices.length !== 1)
    throw new Error("项目备份必须选择一个设备和对应机位");
  assertProjectDayDeviceAllowed(
    project,
    shootingDate,
    config.devices[0],
    config.cameraPosition,
  );

  return {
    ...config,
    ...expectedMetadata,
    shootingDate,
  };
}
