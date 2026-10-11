/**
 * Plumbing tenant configuration — the "onboarding template".
 *
 * Everything a Sonic Bold account manager fills in when a new plumber signs up
 * lives here and is validated with zod before it can reach a live call. The
 * schema is deliberately explicit: a receptionist that guesses a fee, an area
 * or an on-call number is worse than one that takes a message.
 */
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24h HH:MM");
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +15125550100");
const zip5 = z.string().regex(/^\d{5}$/, "Use a 5-digit ZIP");

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export const timeRangeSchema = z
  .object({ open: hhmm, close: hhmm })
  .refine((r) => r.open < r.close, { message: "open must be before close (split overnight ranges across days)" });
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const weeklyHoursSchema = z.object({
  mon: z.array(timeRangeSchema).default([]),
  tue: z.array(timeRangeSchema).default([]),
  wed: z.array(timeRangeSchema).default([]),
  thu: z.array(timeRangeSchema).default([]),
  fri: z.array(timeRangeSchema).default([]),
  sat: z.array(timeRangeSchema).default([]),
  sun: z.array(timeRangeSchema).default([]),
});
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export const serviceSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  /** Words a caller might use; used to map loose descriptions to a service. */
  aliases: z.array(z.string()).default([]),
  /** How long the truck is blocked on the calendar. */
  durationMin: z.number().int().min(15).max(8 * 60).default(60),
  /** What the caller hears: "between 9 and 11". 0 = exact time. */
  arrivalWindowMin: z.number().int().min(0).max(8 * 60).default(120),
  /** Optional "starting at" price. Only spoken if pricing.allowStartingAtPrices. */
  startingAtPrice: z.number().nonnegative().optional(),
  bookable: z.boolean().default(true),
});
export type ServiceConfig = z.infer<typeof serviceSchema>;

export const onCallShiftSchema = z.object({
  name: z.string().min(1),
  phone: e164,
  /** Days this person covers after hours. */
  days: z.array(z.enum(DAYS)).min(1),
  /** Optional ISO dates (YYYY-MM-DD) for rotating weeks; if set, shift only applies within. */
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Lower number = tried first. */
  order: z.number().int().default(0),
});
export type OnCallShift = z.infer<typeof onCallShiftSchema>;

export const tenantConfigSchema = z.object({
  brand: z.object({
    companyName: z.string().min(1),
    agentName: z.string().min(1).default("Riley"),
    /** Short spoken name for the company, e.g. "Acme Plumbing". */
    spokenName: z.string().optional(),
    website: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0B5FFF"),
    logoUrl: z.string().url().optional(),
    licenseNumber: z.string().optional(),
    licensedBondedInsured: z.boolean().default(true),
  }),
  timezone: z.string().refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid timezone").default("America/Chicago"),
  voice: z.object({
    enabled: z.boolean().default(true),
    provider: z.enum(["agency", "elevenlabs", "openai-realtime", "deepgram-openrouter"]).default("agency"),
    model: z.string().trim().min(1).optional(),
    transcriptionModel: z.string().trim().min(1).optional(),
    speechModel: z.string().trim().min(1).optional(),
  }).default({}),
  services: z.array(serviceSchema).min(1),
  /** Trades the company does NOT do (declined politely, never booked). */
  notOffered: z.array(z.string()).default(["electrical", "hvac", "air conditioning", "gas line", "roofing", "appliance repair"]),
  pricing: z.object({
    /** Trip / diagnostic fee in USD. Stated early, unprompted. */
    tripFee: z.number().nonnegative(),
    tripFeeLabel: z.string().default("service call fee"),
    /** If set, used outside business hours instead of tripFee. */
    afterHoursTripFee: z.number().nonnegative().optional(),
    creditedTowardRepair: z.boolean().default(true),
    allowStartingAtPrices: z.boolean().default(false),
    financingAvailable: z.boolean().default(false),
  }),
  serviceArea: z
    .object({
      zips: z.array(zip5).default([]),
      /** Optional radius around the shop. Needs a geocoder to resolve caller addresses. */
      radius: z
        .object({ centerLat: z.number(), centerLng: z.number(), miles: z.number().positive().max(250) })
        .optional(),
      /** Human description the agent may say ("Austin and Round Rock"). */
      description: z.string().default(""),
    })
    .refine((a) => a.zips.length > 0 || a.radius, { message: "Configure at least a ZIP list or a radius" }),
  hours: weeklyHoursSchema,
  /** Dates (YYYY-MM-DD) treated as fully after-hours. */
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
  onCall: z.object({
    enabled: z.boolean().default(true),
    shifts: z.array(onCallShiftSchema).default([]),
    /** Used when no shift matches. */
    fallbackPhone: e164.optional(),
    /** Send an SMS alert to on-call for every P1 even when the transfer connects. */
    alwaysAlertOnEmergency: z.boolean().default(true),
  }),
  transfer: z.object({
    /** Office line for business-hours transfers (billing, complaints, "I want a human"). */
    officeNumber: e164.optional(),
    dialTimeoutSec: z.number().int().min(5).max(60).default(20),
    /** Callback SLA for failed emergency transfers. */
    emergencyCallbackMinutes: z.number().int().min(1).max(120).default(10),
  }),
  recording: z.object({
    enabled: z.boolean().default(true),
    /** Spoken before the AI picks up. Two-party-consent states require notice. */
    preamble: z.string().default("This call may be recorded for quality and training purposes."),
  }),
  sms: z.object({
    enabled: z.boolean().default(true),
    missedCallTextBack: z.boolean().default(true),
    missedCallTemplate: z
      .string()
      .default(
        "Hi, this is {company}. Sorry we missed your call! Reply here with what's going on and your ZIP code and we'll get you scheduled. For a gas smell or flooding near electrical, leave the home and call 911. Reply STOP to opt out.",
      ),
    aiReplies: z.boolean().default(true),
    provider: z.enum(["agency", "openai", "openrouter"]).default("agency"),
    model: z.string().trim().min(1).optional(),
    helpText: z.string().default("{company}: For help call {phone}. Msg&data rates may apply. Reply STOP to opt out."),
    /** No proactive texts outside these local hours (TCPA-style quiet hours). Replies to inbound are allowed. */
    quietHours: z.object({ start: hhmm, end: hhmm }).default({ start: "21:00", end: "08:00" }),
  }),
  booking: z.object({
    mode: z.enum(["calendar", "request"]).default("calendar"),
    horizonDays: z.number().int().min(1).max(60).default(7),
    minLeadMinutes: z.number().int().min(0).default(60),
    /** Parallel trucks available per slot. */
    capacity: z.number().int().min(1).max(50).default(1),
    adultRequired: z.boolean().default(true),
    /** Offer weekend slots for routine work. */
    routineOnWeekends: z.boolean().default(false),
  }),
  triage: z.object({
    /** Upgrade "no hot water" / "no water" with infant, elderly or medical need from P2 to P1. */
    vulnerableOccupantUpgradesToP1: z.boolean().default(false),
    /** Treat any P1 during business hours as a live transfer to the office (otherwise book first slot). */
    transferP1DuringHours: z.boolean().default(false),
    /** Gas utility emergency line the agent may read out (e.g. "Atmos Energy 866-322-8667"). */
    gasUtilityLine: z.string().optional(),
  }),
  fieldService: z.object({
    provider: z.enum(["none", "servicetitan", "housecallpro", "jobber"]).default("none"),
    /** Adapter-specific non-secret settings (IDs). Secrets live in env / secret store. */
    settings: z.record(z.string()).default({}),
  }),
  calendar: z.object({
    provider: z.enum(["none", "google"]).default("none"),
    calendarId: z.string().optional(),
  }),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type TenantConfigInput = z.input<typeof tenantConfigSchema>;

export function parseTenantConfig(input: unknown): TenantConfig {
  return tenantConfigSchema.parse(input);
}

export function safeParseTenantConfig(input: unknown) {
  return tenantConfigSchema.safeParse(input);
}

export function spokenCompany(config: TenantConfig): string {
  return config.brand.spokenName ?? config.brand.companyName;
}

/** Only shared operational sections can be applied across client accounts. */
export const agencySettingsSchema = tenantConfigSchema.pick({ voice: true, sms: true, recording: true, booking: true }).partial().extend({ triage: tenantConfigSchema.shape.triage.omit({ gasUtilityLine: true }).optional() }).strict();
export type AgencySettings = z.infer<typeof agencySettingsSchema>;
export function applyAgencySettings(config: TenantConfig, settings: AgencySettings): TenantConfig {
  return parseTenantConfig({ ...config, ...settings, triage: { ...config.triage, ...settings.triage } });
}
