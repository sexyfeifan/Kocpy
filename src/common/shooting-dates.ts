import type { BackupTask, ProjectConfig } from "../main/types";

/** Read-time canonicalization only: never rewrites existing project/task data. */
export function shootingDateKey(value?: string): string {
  if (!value) return "";
  const digits = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!digits) return value;
  const iso = `${digits[1]}-${digits[2]}-${digits[3]}`;
  const time = Date.parse(`${iso}T12:00:00Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === iso
    ? iso
    : value;
}

export function projectDates(
  project: ProjectConfig,
  tasks: BackupTask[],
): string[] {
  const dates = new Set(
    tasks.map((task) => shootingDateKey(task.shootingDate)).filter(Boolean),
  );
  const start = shootingDateKey(
    project.shootingDateStart || project.shootingDate,
  );
  const end = shootingDateKey(project.shootingDateEnd || start);
  const from = Date.parse(`${start}T12:00:00Z`),
    to = Date.parse(`${end}T12:00:00Z`);
  for (
    let day = from, count = 0;
    Number.isFinite(day) && day <= to && count < 1000;
    day += 86400000, count++
  )
    dates.add(new Date(day).toISOString().slice(0, 10));
  return [...dates].sort();
}

/** Explicit user action: merge only this day's legacy aliases, preserving all
 * other dates. A decision must be clearable even if stored as YYYYMMDD. */
export function updateSchedule(
  project: ProjectConfig,
  dateValue: string,
  device?: string,
  decision: "unused" | "expected" | "clear" = "unused",
): ProjectConfig {
  const day = shootingDateKey(dateValue);
  const next = {
    ...project,
    restDays: [...(project.restDays || [])],
    unusedDevicesByDate: { ...project.unusedDevicesByDate },
    expectedDevicesByDate: { ...project.expectedDevicesByDate },
  };
  if (!device) {
    const rest = next.restDays.some((date) => shootingDateKey(date) === day);
    next.restDays = next.restDays.filter(
      (date) => shootingDateKey(date) !== day,
    );
    if (!rest) next.restDays.push(day);
  } else {
    for (const [key, selected] of [
      ["unusedDevicesByDate", decision === "unused"],
      ["expectedDevicesByDate", decision === "expected"],
    ] as const) {
      const values = new Set<string>();
      for (const [date, entries] of Object.entries(next[key])) {
        if (shootingDateKey(date) !== day) continue;
        entries
          .filter((value) => value !== device)
          .forEach((value) => values.add(value));
        delete next[key][date];
      }
      if (selected) values.add(device);
      next[key][day] = [...values];
    }
  }
  return next;
}
