/**
 * Slot generation. The slot underneath is exact (capacity math), the caller
 * hears a window: "between 9 and 11" (open-receptionist arrival_window_min).
 */
import { DateTime } from "luxon";
import type { ServiceConfig, TenantConfig } from "../tenant/config";
import type { Priority } from "../triage/types";
import { localNow, rangesFor } from "./hours";

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface Slot {
  /** Stable id: ISO start + service key. */
  id: string;
  serviceKey: string;
  start: string;
  end: string;
  windowStart: string;
  windowEnd: string;
  spoken: string;
}

export interface FindSlotsInput {
  config: TenantConfig;
  service: ServiceConfig;
  now: Date;
  busy: BusyInterval[];
  priority: Priority;
  limit?: number;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function spokenTime(dt: DateTime): string {
  return dt.minute === 0 ? dt.toFormat("h a") : dt.toFormat("h:mm a");
}

export function spokenWindow(start: DateTime, end: DateTime, now: DateTime): string {
  const sameDay = start.hasSame(now, "day");
  const tomorrow = start.hasSame(now.plus({ days: 1 }), "day");
  const day = sameDay ? "today" : tomorrow ? "tomorrow" : start.toFormat("cccc, LLLL d");
  if (start.equals(end)) return `${day} at ${spokenTime(start)}`;
  return `${day} between ${spokenTime(start)} and ${spokenTime(end)}`;
}

export function findSlots(input: FindSlotsInput): Slot[] {
  const { config, service, busy, priority } = input;
  const limit = input.limit ?? 3;
  const now = localNow(config, input.now);
  const earliest = now.plus({ minutes: config.booking.minLeadMinutes });
  const step = Math.max(30, service.arrivalWindowMin || 60);
  const out: Slot[] = [];
  const horizon = priority === "P2" || priority === "P1" ? Math.min(config.booking.horizonDays, 3) : config.booking.horizonDays;

  for (let d = 0; d <= horizon && out.length < limit; d++) {
    const day = now.startOf("day").plus({ days: d });
    const weekend = day.weekday >= 6;
    if (weekend && priority === "P3" && !config.booking.routineOnWeekends) continue;
    for (const range of rangesFor(config, day)) {
      const open = day.plus({ minutes: minutesOf(range.open) });
      const close = day.plus({ minutes: minutesOf(range.close) });
      for (let start = open; start.plus({ minutes: service.durationMin }) <= close; start = start.plus({ minutes: step })) {
        if (start < earliest) continue;
        const end = start.plus({ minutes: service.durationMin });
        const overlapping = busy.filter((b) => b.start < end.toJSDate() && b.end > start.toJSDate()).length;
        if (overlapping >= config.booking.capacity) continue;
        const windowEnd = start.plus({ minutes: service.arrivalWindowMin });
        out.push({
          id: `${service.key}@${start.toUTC().toISO()}`,
          serviceKey: service.key,
          start: start.toUTC().toISO() ?? "",
          end: end.toUTC().toISO() ?? "",
          windowStart: start.toISO() ?? "",
          windowEnd: windowEnd.toISO() ?? "",
          spoken: spokenWindow(start, windowEnd, now),
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  // P2 = same day: if today has openings, only offer today's.
  if (priority === "P2" || priority === "P1") {
    const today = out.filter((s) => DateTime.fromISO(s.start).setZone(config.timezone).hasSame(now, "day"));
    if (today.length > 0) return today;
  }
  return out;
}

export function matchService(config: TenantConfig, text: string, issueKey?: string): ServiceConfig | undefined {
  const t = text.toLowerCase();
  if (issueKey) {
    const byIssue = config.services.find((s) => s.key === issueKey || s.aliases.includes(issueKey));
    if (byIssue) return byIssue;
  }
  let best: { s: ServiceConfig; len: number } | undefined;
  for (const s of config.services) {
    for (const term of [s.label, ...s.aliases]) {
      const needle = term.toLowerCase();
      if (needle && t.includes(needle) && (!best || needle.length > best.len)) best = { s, len: needle.length };
    }
  }
  return best?.s;
}
