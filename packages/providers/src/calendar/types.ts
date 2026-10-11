export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEventInput {
  calendarId: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location?: string;
  timezone: string;
}

export interface CalendarProvider {
  readonly name: string;
  busy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]>;
  createEvent(input: CalendarEventInput): Promise<{ id: string }>;
}
