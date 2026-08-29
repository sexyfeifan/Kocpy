import { createHash } from "node:crypto";
import type { BackupTask, ProjectConfig, ProjectTemplate, WorkspaceMergeResult } from "./types";

export const taskFingerprint = (task: BackupTask) => createHash("sha256").update(JSON.stringify({ sourceVolume: task.sourceVolumeUuid || task.sourceVolumeId, files: task.fileRecords.map((file) => [file.relativePath, file.size, file.srcChecksum]).sort() })).digest("hex");

export function sourceSuggestion(tasks: BackupTask[], input: { volumeId?: string; files: Array<{ relativePath: string; size: number }> }) {
  const signature = createHash("sha256").update(JSON.stringify(input.files.map((file) => [file.relativePath, file.size]).sort())).digest("hex");
  const duplicate = tasks.find((task) => createHash("sha256").update(JSON.stringify(task.fileRecords.map((file) => [file.relativePath, file.size]).sort())).digest("hex") === signature);
  const history = tasks.filter((task) => input.volumeId && (task.sourceVolumeUuid === input.volumeId || task.sourceVolumeId === input.volumeId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const recent = duplicate || history[0];
  return { duplicateTaskId: duplicate?.id, duplicateTaskName: duplicate?.name, projectId: recent?.projectId, device: recent?.devices[0], cameraPosition: recent?.cameraPosition, nextVolume: Math.max(1, ...tasks.filter((task) => task.projectId && task.projectId === recent?.projectId && task.devices[0] === recent?.devices[0]).map((task) => task.volumeNumber || 0)) + 1 };
}

export function templateFromProject(project: ProjectConfig, name = project.name): ProjectTemplate {
  const now = Date.now(); return { id: `template-${project.id}`, name, devices: [...project.devices], volumePrefix: project.volumePrefix, requiredCopies: project.requiredCopies || 2, namingRule: project.namingRule || "{date}_{project}/{shootingDate}/{device}/{card}", completionActions: [...(project.completionActions || ["report"])], createdAt: now, updatedAt: now };
}

export function mergeWorkspace(current: { projects: ProjectConfig[]; tasks: BackupTask[] }, incoming: { projects?: ProjectConfig[]; tasks?: BackupTask[] }): { projects: ProjectConfig[]; tasks: BackupTask[]; result: WorkspaceMergeResult } {
  const projects = [...current.projects], tasks = [...current.tasks], conflicts: string[] = []; let projectsAdded = 0, projectsUpdated = 0, tasksAdded = 0, duplicates = 0;
  for (const project of incoming.projects || []) { const index = projects.findIndex((item) => item.id === project.id); if (index < 0) { projects.push(project); projectsAdded++; } else if (JSON.stringify(projects[index]) !== JSON.stringify(project)) { projects[index] = { ...projects[index], ...project, handoffNotes: [...(projects[index].handoffNotes || []), ...(project.handoffNotes || [])].filter((note, i, all) => all.findIndex((other) => other.id === note.id) === i) }; projectsUpdated++; conflicts.push(`项目 ${project.name} 配置已合并`); } }
  const fingerprints = new Map(tasks.map((task) => [taskFingerprint(task), task]));
  for (const task of incoming.tasks || []) { const fingerprint = taskFingerprint(task); if (tasks.some((item) => item.id === task.id) || fingerprints.has(fingerprint)) { duplicates++; continue; } if (tasks.some((item) => item.projectId === task.projectId && item.name === task.name && item.shootingDate === task.shootingDate)) conflicts.push(`素材卷名称冲突：${task.name}`); tasks.push(task); fingerprints.set(fingerprint, task); tasksAdded++; }
  return { projects, tasks, result: { projectsAdded, projectsUpdated, tasksAdded, duplicates, conflicts, importedAt: Date.now() } };
}
