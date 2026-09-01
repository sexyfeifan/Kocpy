import { createHash, randomUUID } from "node:crypto";
import {
  projectDates,
  shootingDateKey,
  updateSchedule,
} from "../common/shooting-dates";
import { groupLogicalVolumes } from "../common/logical-volumes";
import { projectCloseoutSummary } from "./project-closeout";
export { groupLogicalVolumes } from "../common/logical-volumes";
import type {
  BackupTask,
  ProjectConfig,
  ProjectRuleDefinition,
  ProjectRuleSnapshot,
  ProjectTemplate,
  TemplateApplicationEvidence,
} from "./types";

const clone = <T>(value: T): T => structuredClone(value);

export function projectRuleDefinition(project: ProjectConfig): ProjectRuleDefinition {
  const shootingDateStart =
    project.shootingDateStart || project.shootingDate || "";
  return {
    projectFolderName: project.projectFolderName || "",
    shootingDateStart,
    shootingDateEnd: project.shootingDateEnd || shootingDateStart,
    devices: [...(project.devices || [])],
    volumePrefix: project.volumePrefix || "",
    volumePrefixByDevice: { ...(project.volumePrefixByDevice || {}) },
    devicePositions: Object.fromEntries(
      Object.entries(project.devicePositions || {}).map(([key, values]) => [key, [...values]]),
    ),
    destinationPaths: [...(project.destinationPaths || [])],
    requiredCopies: project.requiredCopies || 2,
    namingRule:
      project.namingRule ||
      "{date}_{project}/{shootingDate}/{device}/{position}/{card}",
    completionActions: [...(project.completionActions || ["report"])],
    checklists: (project.checklists || []).map((item) => ({ ...item })),
  };
}

const ruleJson = (rules: ProjectRuleDefinition) => JSON.stringify(rules);
const ruleSha256 = (rules: ProjectRuleDefinition) =>
  createHash("sha256").update(ruleJson(rules)).digest("hex");

function snapshot(
  project: ProjectConfig,
  revision: number,
  reason: ProjectRuleSnapshot["reason"],
  at: number,
  operator: string,
): ProjectRuleSnapshot {
  const rules = projectRuleDefinition(project);
  return {
    id: randomUUID(),
    revision,
    createdAt: at,
    operator: operator.trim() || "Kocpy",
    reason,
    sha256: ruleSha256(rules),
    rules,
  };
}

/** Append-only rule evidence. It never edits an existing snapshot. */
export function appendProjectRuleSnapshot(
  previous: ProjectConfig | undefined,
  incoming: ProjectConfig,
  options: {
    at?: number;
    operator?: string;
    reason?: ProjectRuleSnapshot["reason"];
  } = {},
): ProjectConfig {
  const at = options.at || Date.now();
  const operator = options.operator || "Kocpy";
  const result = clone(incoming);
  const snapshots = clone(previous?.ruleSnapshots || []);

  // Project editing is not an authority to rewrite operational history. These
  // fields can only be changed by their dedicated audited IPC operations.
  if (previous) {
    result.restDays = clone(previous.restDays || []);
    result.unusedDevicesByDate = clone(previous.unusedDevicesByDate || {});
    result.expectedDevicesByDate = clone(previous.expectedDevicesByDate || {});
    result.dailyPlanDecisions = clone(previous.dailyPlanDecisions || []);
    result.templateApplications = clone(previous.templateApplications || []);
    result.handoffNotes = clone(previous.handoffNotes || []);
    result.checklistRuns = clone(previous.checklistRuns || []);
    result.boundRoots = clone(previous.boundRoots || []);
    result.takeoverEvents = clone(previous.takeoverEvents || []);
  } else {
    result.restDays = [];
    result.unusedDevicesByDate = {};
    result.expectedDevicesByDate = {};
    result.dailyPlanDecisions = [];
    result.templateApplications = [];
    result.handoffNotes = [];
    result.checklistRuns = [];
    result.boundRoots = [];
    result.takeoverEvents = [];
  }

  if (!snapshots.length && previous) {
    snapshots.push(snapshot(previous, 1, "legacy-baseline", at, operator));
  }
  const currentRules = projectRuleDefinition(incoming);
  const active = snapshots.find(
    (item) => item.id === (previous?.activeRuleSnapshotId || incoming.activeRuleSnapshotId),
  ) || snapshots.at(-1);
  if (!active || active.sha256 !== ruleSha256(currentRules)) {
    snapshots.push(
      snapshot(
        incoming,
        (snapshots.at(-1)?.revision || 0) + 1,
        options.reason || (previous ? "project-updated" : "project-created"),
        at,
        operator,
      ),
    );
  }
  result.ruleSnapshots = snapshots;
  result.activeRuleSnapshotId = snapshots.at(-1)!.id;
  return result;
}

export function attachTaskEvidence(task: BackupTask, project?: ProjectConfig): BackupTask {
  task.logicalVolumeId ||= task.id;
  task.operationAttemptId ||= task.id;
  if (project?.activeRuleSnapshotId)
    task.projectRuleSnapshotId ||= project.activeRuleSnapshotId;
  return task;
}

export function recordDailyPlanDecision(
  project: ProjectConfig,
  input: {
    date: string;
    scheduleKey?: string;
    decision: "expected" | "unused" | "clear" | "rest" | "working";
    operator: string;
    note?: string;
    at?: number;
  },
): ProjectConfig {
  if (!input.operator.trim()) throw new Error("请填写每日计划操作人");
  if (input.operator.trim().length > 120)
    throw new Error("每日计划操作人最多 120 个字符");
  if ((input.note?.trim().length || 0) > 1000)
    throw new Error("每日计划说明最多 1000 个字符");
  const date = shootingDateKey(input.date);
  const dateValue = Date.parse(`${date}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(dateValue) ||
    new Date(dateValue).toISOString().slice(0, 10) !== date
  )
    throw new Error("拍摄日期无效");
  if (
    input.scheduleKey &&
    (input.scheduleKey.length > 160 ||
      /[\\/]/.test(input.scheduleKey) ||
      input.scheduleKey.split("::").length > 2 ||
      input.scheduleKey.split("::").some((part) => !part.trim()))
  )
    throw new Error("设备或机位名称无效");
  let next = clone(project);
  if (input.decision === "rest" || input.decision === "working") {
    const isRest = next.restDays?.some((item) => shootingDateKey(item) === date);
    if ((input.decision === "rest") !== Boolean(isRest))
      next = updateSchedule(next, date);
  } else if (input.scheduleKey) {
    next = updateSchedule(next, date, input.scheduleKey, input.decision);
  } else {
    throw new Error("请选择设备或机位");
  }
  next.dailyPlanDecisions = [
    ...(project.dailyPlanDecisions || []),
    {
      id: randomUUID(),
      date,
      scheduleKey: input.scheduleKey,
      decision: input.decision,
      operator: input.operator.trim(),
      note: input.note?.trim() || undefined,
      ruleSnapshotId: project.activeRuleSnapshotId,
      at: input.at || Date.now(),
    },
  ];
  return next;
}

export function appendTemplateApplicationEvidence(
  project: ProjectConfig,
  template: ProjectTemplate,
  selectedFields: string[],
  changes: TemplateApplicationEvidence["changes"],
  resultingRuleSnapshotId: string,
  operator = "Kocpy",
  at = Date.now(),
): ProjectConfig {
  return {
    ...project,
    templateApplications: [
      ...(project.templateApplications || []),
      {
        id: randomUUID(),
        at,
        operator,
        templateId: template.id,
        templateName: template.name,
        templateRevision: template.revision || 1,
        selectedFields: [...selectedFields],
        changes: changes.map((item) => ({ ...item })),
        resultingRuleSnapshotId,
      },
    ],
  };
}

export function appendProjectHandoffEvidence(
  project: ProjectConfig,
  tasks: BackupTask[],
  input: {
    operator: string;
    note: string;
    scope?: "day" | "project";
    shootingDate?: string;
    exceptions?: string[];
    at?: number;
  },
): ProjectConfig {
  if (!input.operator.trim()) throw new Error("请填写实际交接人姓名");
  if (!input.note.trim()) throw new Error("请输入交接内容");
  if (input.operator.trim().length > 120)
    throw new Error("交接人姓名最多 120 个字符");
  if (input.note.trim().length > 4000)
    throw new Error("交接内容最多 4000 个字符");
  const scope = input.scope || "project";
  const shootingDate = input.shootingDate
    ? shootingDateKey(input.shootingDate)
    : undefined;
  if (scope === "day" && !shootingDate)
    throw new Error("按拍摄日交接时必须选择日期");
  if (
    scope === "day" &&
    !projectDates(project, tasks).includes(shootingDate!)
  )
    throw new Error("交接日期不在当前项目拍摄周期内");
  const exceptions = (input.exceptions || [])
    .map((item) => item.trim())
    .filter(Boolean);
  if (exceptions.length > 100 || exceptions.some((item) => item.length > 500))
    throw new Error("交接例外最多 100 项，每项最多 500 个字符");
  const scopedTasks =
      scope === "day"
        ? tasks.filter(
            (task) => shootingDateKey(task.shootingDate || "") === shootingDate,
          )
        : tasks,
    dates = scope === "day" ? [shootingDate!] : projectDates(project, tasks),
    closeout = projectCloseoutSummary(project, scopedTasks, dates),
    logicalVolumes = groupLogicalVolumes(
      scopedTasks,
      project.requiredCopies || 2,
    );
  return {
    ...project,
    handoffNotes: [
      ...(project.handoffNotes || []),
      {
        id: randomUUID(),
        at: input.at || Date.now(),
        operator: input.operator.trim(),
        note: input.note.trim(),
        scope,
        shootingDate,
        exceptions,
        ruleSnapshotId: project.activeRuleSnapshotId,
        closeoutEvidence: {
          logicalVolumes: logicalVolumes.length,
          compliantVolumes: logicalVolumes.filter((item) => item.compliant)
            .length,
          pendingCells: closeout.pending.length,
          unconfirmedCells: closeout.unconfirmed.length,
          requiredCopies: project.requiredCopies || 2,
        },
      },
    ],
  };
}
