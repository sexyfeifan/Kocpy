/**
 * Parse the two date representations accepted by Kocpy without allowing the
 * JavaScript Date constructor to normalize an impossible calendar day.
 */
export function canonicalCalendarDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!match) return undefined;
  const iso = `${match[1]}-${match[2]}-${match[3]}`,
    time = Date.parse(`${iso}T12:00:00Z`);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== iso
  )
    return undefined;
  return iso;
}

export function requireCalendarDate(value: unknown, message: string): string {
  const canonical = canonicalCalendarDate(value);
  if (!canonical) throw new Error(message);
  return canonical;
}

export function compactCalendarDate(value: unknown, message: string): string {
  return requireCalendarDate(value, message).replace(/-/g, "");
}
