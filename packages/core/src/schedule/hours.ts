import { DateTime } from "luxon";
import { DAYS, type Day, type OnCallShift, type TenantConfig, type TimeRange } from "../tenant/config";

export function localNow(config: TenantConfig, now: Date): DateTime {
  const dt = DateTime.fromJSDate(now, { zone: config.timezone });
  if (!dt.isValid) throw new Error(`Invalid tenant timezone ${config.timezone}`);
  return dt;
}

export function dayKey(dt: DateTime): Day {
  // luxon weekday: 1 = Monday ... 7 = Sunday
  return DAYS[dt.weekday - 1] as Day;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function rangesFor(config: TenantConfig, dt: DateTime): TimeRange[] {
  if (config.holidays.includes(dt.toISODate() ?? "")) return [];
  return config.hours[dayKey(dt)] ?? [];
}

export function isOpen(config: TenantConfig, now: Date): boolean {
  const dt = localNow(config, now);
  const minute = dt.hour * 60 + dt.minute;
  return rangesFor(config, dt).some((r) => minute >= minutesOf(r.open) && minute < minutesOf(r.close));
}

/** Next time the office opens (for "we open at 7 tomorrow"). */
export function nextOpening(config: TenantConfig, now: Date): DateTime | null {
  let dt = localNow(config, now);
  for (let i = 0; i < 14; i++) {
    const day = dt.startOf("day");
    for (const r of rangesFor(config, day)) {
      const open = day.plus({ minutes: minutesOf(r.open) });
      if (open > localNow(config, now)) return open;
    }
    dt = day.plus({ days: 1 });
  }
  return null;
}

/**
 * On-call people for "now", in dial order. After-hours shifts are keyed by the
 * local calendar day; a shift listing "mon" covers Monday 00:00–23:59 outside
 * office hours. Rotations use startDate/endDate.
 */
export function resolveOnCall(config: TenantConfig, now: Date): Array<{ name: string; phone: string }> {
  if (!config.onCall.enabled) return [];
  const dt = localNow(config, now);
  const date = dt.toISODate() ?? "";
  const today = dayKey(dt);
  const matches = config.onCall.shifts
    .filter((s: OnCallShift) => s.days.includes(today))
    .filter((s) => (!s.startDate || s.startDate <= date) && (!s.endDate || date <= s.endDate))
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ name: s.name, phone: s.phone }));
  if (matches.length === 0 && config.onCall.fallbackPhone) {
    return [{ name: "On-call", phone: config.onCall.fallbackPhone }];
  }
  return matches;
}

export function inQuietHours(config: TenantConfig, now: Date): boolean {
  const dt = localNow(config, now);
  const minute = dt.hour * 60 + dt.minute;
  const start = minutesOf(config.sms.quietHours.start);
  const end = minutesOf(config.sms.quietHours.end);
  return start > end ? minute >= start || minute < end : minute >= start && minute < end;
}
