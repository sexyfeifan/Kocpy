import { canonicalCalendarDate } from "./calendar-date";

/** Calendar attribution is explicit. These rules only interpret date clues. */
export interface ProjectTimeRules {
  projectTimeZone?: string;
  shootingDayTimeZones?: Record<string, string>;
  /** Advisory only; never authorizes exclusion or a shooting-date change. */
  shootingDayBoundaryHour?: number;
}
export interface TimeContext {
  schemaVersion: 1;
  capturedAt: number;
  workstationTimeZone: string;
  workstationOffsetMinutes: number;
  projectTimeZone?: string;
  shootingTimeZone?: string;
  shootingDate?: string;
  shootingDayBoundaryHour?: number;
}
const zoneCache = new Map<string, boolean>();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100 || !/^[A-Za-z_+\-/0-9]+$/.test(value)) return false;
  if (zoneCache.has(value)) return zoneCache.get(value)!;
  let valid = false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); valid = true; } catch { /* Reject unknown zones. */ }
  if (zoneCache.size >= 1024) zoneCache.clear();
  zoneCache.set(value, valid); return valid;
}
export function assertProjectTimeRules(value: ProjectTimeRules) {
  if (value.projectTimeZone !== undefined && !validTimeZone(value.projectTimeZone)) throw new Error("项目时区无效，请选择有效的 IANA 时区");
  if (value.shootingDayBoundaryHour !== undefined && (!Number.isInteger(value.shootingDayBoundaryHour) || value.shootingDayBoundaryHour < 0 || value.shootingDayBoundaryHour > 12)) throw new Error("大夜参考分界须为 0–12 时；仅作提示，不自动筛选");
  if (value.shootingDayTimeZones !== undefined) {
    const map = value.shootingDayTimeZones;
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > 1000 || Object.entries(map).some(([day, zone]) => canonicalCalendarDate(day) !== day || !validTimeZone(zone))) throw new Error("拍摄日时区设置无效");
  }
}
export function shootingTimeZone(rules: ProjectTimeRules, day?: string) {
  return (day && rules.shootingDayTimeZones?.[day]) || rules.projectTimeZone;
}
export function captureTimeContext(rules: ProjectTimeRules = {}, shootingDate?: string, at = Date.now()): TimeContext {
  assertProjectTimeRules(rules);
  if (shootingDate) {
    const canonical = canonicalCalendarDate(shootingDate);
    if (!canonical) throw new Error("拍摄归属日无效，无法记录时间上下文");
    shootingDate = canonical;
  }
  return { schemaVersion: 1, capturedAt: at,
    workstationTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    workstationOffsetMinutes: -new Date(at).getTimezoneOffset(),
    ...(rules.projectTimeZone ? { projectTimeZone: rules.projectTimeZone } : {}),
    ...(shootingTimeZone(rules, shootingDate) ? { shootingTimeZone: shootingTimeZone(rules, shootingDate) } : {}),
    ...(shootingDate ? { shootingDate } : {}),
    ...(rules.shootingDayBoundaryHour !== undefined ? { shootingDayBoundaryHour: rules.shootingDayBoundaryHour } : {}) };
}
export function validTimeContext(value: unknown): value is TimeContext {
  const v = value as TimeContext;
  return !!v && v.schemaVersion === 1 && Number.isFinite(v.capturedAt) && Number.isFinite(new Date(v.capturedAt).getTime()) && validTimeZone(v.workstationTimeZone) && Number.isInteger(v.workstationOffsetMinutes) && Math.abs(v.workstationOffsetMinutes) <= 840 &&
    (v.projectTimeZone === undefined || validTimeZone(v.projectTimeZone)) && (v.shootingTimeZone === undefined || validTimeZone(v.shootingTimeZone)) &&
    (v.shootingDate === undefined || canonicalCalendarDate(v.shootingDate) === v.shootingDate) &&
    (v.shootingDayBoundaryHour === undefined || Number.isInteger(v.shootingDayBoundaryHour) && v.shootingDayBoundaryHour >= 0 && v.shootingDayBoundaryHour <= 12);
}
/** A confirmed filter cannot silently change its date-interpretation rules. */
export function assertSelectionTimeContext(context: TimeContext | undefined, rules: ProjectTimeRules, day?: string) {
  if (!context) return; // Existing legacy plans retain their original evidence.
  const canonical = day ? canonicalCalendarDate(day) : undefined;
  if (!validTimeContext(context) || context.shootingDate !== canonical || context.projectTimeZone !== rules.projectTimeZone || context.shootingTimeZone !== shootingTimeZone(rules, canonical) || context.shootingDayBoundaryHour !== rules.shootingDayBoundaryHour)
    throw new Error("筛选后的拍摄归属日或时区规则已变化，请重新分析并确认范围");
}
export function calendarDateInZone(at: number, zone: string) {
  if (!validTimeZone(zone)) throw new Error("日期分析时区无效");
  if (!dayFormatters.has(zone)) {
    if (dayFormatters.size >= 64) dayFormatters.clear();
    dayFormatters.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  }
  const p = dayFormatters.get(zone)!.formatToParts(at);
  const get = (type: string) => p.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
/** Offset-bearing timestamps can be converted. Unzoned camera clocks stay unconverted. */
export function mediaCalendarDate(raw: string | undefined, zone?: string) {
  if (!raw) return undefined;
  const value = raw.trim().replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  const day = value.slice(0, 10);
  if (canonicalCalendarDate(day) !== day) return undefined;
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    if (!Number.isFinite(Date.parse(value))) return undefined;
    if (zone) return calendarDateInZone(Date.parse(value), zone);
  }
  return day;
}
export function overnightHint(raw: string | undefined, context?: TimeContext) {
  if (!raw || !context?.shootingTimeZone || !context.shootingDayBoundaryHour || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) return undefined;
  const at = Date.parse(raw), hour = Number(new Intl.DateTimeFormat("en", { timeZone: context.shootingTimeZone, hour: "2-digit", hourCycle: "h23" }).format(at));
  if (hour >= context.shootingDayBoundaryHour) return undefined;
  const day = calendarDateInZone(at, context.shootingTimeZone);
  const previous = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return `当地凌晨 ${hour} 时：可能归属 ${previous} 的大夜（参考分界 ${context.shootingDayBoundaryHour}:00），必须人工确认，不自动改归属或跳过`;
}
/** No hidden machine-local fallback: legacy records display UTC, explicitly unknown. */
export function formatEvidenceTime(at: number, context?: TimeContext, view: "shooting" | "operation" = "operation") {
  const known = validTimeContext(context), zone = known ? (view === "shooting" ? context.shootingTimeZone || "UTC" : context.workstationTimeZone) : "UTC";
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return "时间未记录或无效";
  const text = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).format(at);
  return `${text} [${zone}]${!known ? "（原时区未记录）" : view === "shooting" && !context.shootingTimeZone ? "（拍摄时区未记录）" : ""}`;
}
export function timeContextSummary(context?: TimeContext) {
  return validTimeContext(context) ? `拍摄时区：${context.shootingTimeZone || "未确认"}；操作时区：${context.workstationTimeZone}；拍摄归属日：${context.shootingDate || "未指定"}（人工确认，不按午夜自动切换）` : "历史时区未记录；操作时间以 UTC 展示，不推定拍摄地。";
}
export function projectTimeRulesSummary(rules: ProjectTimeRules) {
  const overrides = Object.entries(rules.shootingDayTimeZones || {}).sort().map(([day, zone]) => `${day}: ${zone}`).join("；");
  return `项目拍摄时区：${rules.projectTimeZone || "未记录"}${overrides ? `；逐日覆盖：${overrides}` : ""}；大夜参考分界：${rules.shootingDayBoundaryHour ? `${rules.shootingDayBoundaryHour}:00（仅建议）` : "未启用"}`;
}
