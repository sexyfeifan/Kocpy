import type { BackupTask, ProjectConfig } from "../main/types";
import { assignedShootingDates } from "./date-allocation";
import { canonicalCalendarDate } from "./calendar-date";

/** Read-time canonicalization only: never rewrites existing project/task data. */
export function shootingDateKey(value?: string): string {
  if (!value) return "";
  return canonicalCalendarDate(value) || value;
}

export function projectDates(
  project: ProjectConfig,
  tasks: BackupTask[],
): string[] {
  const dates = new Set(
    tasks.flatMap((task) => [
      shootingDateKey(task.shootingDate),
      ...assignedShootingDates(task),
    ]).filter(Boolean),
  );
  const rawStart = project.shootingDateStart || project.shootingDate || "",
    rawEnd = project.shootingDateEnd || rawStart,
    start = canonicalCalendarDate(rawStart),
    end = canonicalCalendarDate(rawEnd);
  // Imported legacy records may contain a syntactically plausible but
  // impossible day. Keep that key visible for repair instead of silently
  // rolling it into a different real date through Date.parse/Date.UTC.
  if (!start || !end) {
    if (rawStart) dates.add(rawStart);
    if (rawEnd) dates.add(rawEnd);
    return [...dates].sort();
  }
  const from = Date.parse(`${start}T12:00:00Z`),
    to = Date.parse(`${end}T12:00:00Z`);
  if (from > to) {
    dates.add(start);
    dates.add(end);
    return [...dates].sort();
  }
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
