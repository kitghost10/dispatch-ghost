/**
 * Google Calendar via a service account (no SDK). The plumber shares their
 * dispatch calendar with the service account's email ("Make changes to
 * events"); the tenant config stores the calendar id.
 *
 * JWT bearer flow: https://developers.google.com/identity/protocols/oauth2/service-account
 */
import { createSign } from "node:crypto";
import type { BusyInterval, CalendarEventInput, CalendarProvider } from "./types";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const key = JSON.parse(text) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) throw new Error("Service account JSON needs client_email and private_key");
  return key;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function signServiceAccountJwt(key: ServiceAccountKey, scope: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud: key.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = "google";
  private token: { value: string; exp: number } | null = null;
  constructor(private readonly key: ServiceAccountKey, private readonly fetchImpl: typeof fetch = fetch) {}

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    const assertion = signServiceAccountJwt(this.key, "https://www.googleapis.com/auth/calendar", now);
    const res = await this.fetchImpl(this.key.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!res.ok) throw new Error(`Google token error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, exp: now + json.expires_in };
    return json.access_token;
  }

  private async api<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://www.googleapis.com/calendar/v3${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google Calendar ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async busy(calendarId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const json = await this.api<{ calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>("/freeBusy", {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: calendarId }],
    });
    const cal = json.calendars[calendarId];
    if (cal?.errors?.length) throw new Error(`Google freeBusy error for ${calendarId}: ${JSON.stringify(cal.errors).slice(0, 200)}`);
    return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createEvent(input: CalendarEventInput): Promise<{ id: string }> {
    const json = await this.api<{ id: string }>(`/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      summary: input.summary,
      description: input.description,
      ...(input.location ? { location: input.location } : {}),
      start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
      end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
    });
    return { id: json.id };
  }
}
