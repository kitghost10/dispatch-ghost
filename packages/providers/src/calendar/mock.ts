import type { BusyInterval, CalendarEventInput, CalendarProvider } from "./types";

export class MockCalendarProvider implements CalendarProvider {
  readonly name = "mock";
  readonly events: Array<CalendarEventInput & { id: string }> = [];
  extraBusy: BusyInterval[] = [];

  async busy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    return [
      ...this.extraBusy,
      ...this.events.filter((e) => e.calendarId === calendarId).map((e) => ({ start: e.start, end: e.end })),
    ].filter((b) => b.start < to && b.end > from);
  }

  async createEvent(input: CalendarEventInput): Promise<{ id: string }> {
    const id = `evt_mock_${this.events.length + 1}`;
    this.events.push({ ...input, id });
    return { id };
  }
}
