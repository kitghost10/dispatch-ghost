/**
 * The plumbing onboarding template. `createTenantFromTemplate` merges an
 * account manager's answers over these defaults and validates the result.
 */
import { parseTenantConfig, type TenantConfig, type TenantConfigInput } from "./config";

export const PLUMBING_SERVICES: TenantConfigInput["services"] = [
  {
    key: "emergency_repair",
    label: "Emergency plumbing repair",
    aliases: ["burst_pipe", "flooding", "active_leak", "sewage_backup", "no_water", "sump_pump_failure", "frozen_pipe", "burst", "leak", "flood", "sewer"],
    durationMin: 120,
    arrivalWindowMin: 60,
  },
  {
    key: "water_heater",
    label: "Water heater repair",
    aliases: ["no_hot_water", "water_heater_leak", "water heater", "hot water", "tankless"],
    durationMin: 120,
    arrivalWindowMin: 120,
  },
  {
    key: "drain_cleaning",
    label: "Drain cleaning",
    aliases: ["clogged_drain", "toilet_clog", "drain", "clog", "clogged", "backed up"],
    durationMin: 90,
    arrivalWindowMin: 120,
  },
  {
    key: "general_repair",
    label: "General plumbing repair",
    aliases: ["running_toilet", "dripping_faucet", "garbage_disposal", "low_water_pressure", "unknown", "faucet", "toilet", "disposal"],
    durationMin: 60,
    arrivalWindowMin: 120,
  },
  {
    key: "install_estimate",
    label: "Installation estimate",
    aliases: ["fixture_install", "water_heater_install", "install", "replace", "new"],
    durationMin: 60,
    arrivalWindowMin: 120,
  },
];

export const PLUMBING_TEMPLATE_DEFAULTS: Omit<TenantConfigInput, "brand" | "serviceArea" | "pricing"> = {
  timezone: "America/Chicago",
  services: PLUMBING_SERVICES,
  hours: {
    mon: [{ open: "07:00", close: "18:00" }],
    tue: [{ open: "07:00", close: "18:00" }],
    wed: [{ open: "07:00", close: "18:00" }],
    thu: [{ open: "07:00", close: "18:00" }],
    fri: [{ open: "07:00", close: "18:00" }],
    sat: [{ open: "08:00", close: "12:00" }],
    sun: [],
  },
  onCall: { enabled: true, shifts: [], alwaysAlertOnEmergency: true },
  transfer: { dialTimeoutSec: 20, emergencyCallbackMinutes: 10 },
  recording: { enabled: true, preamble: "This call may be recorded for quality and training purposes." },
  sms: { enabled: true, missedCallTextBack: true, aiReplies: true },
  booking: { mode: "calendar", horizonDays: 7, minLeadMinutes: 60, capacity: 2, adultRequired: true, routineOnWeekends: false },
  triage: { vulnerableOccupantUpgradesToP1: false, transferP1DuringHours: false },
  fieldService: { provider: "none", settings: {} },
  calendar: { provider: "none" },
};

export interface OnboardingAnswers {
  brand: TenantConfigInput["brand"];
  pricing: TenantConfigInput["pricing"];
  serviceArea: TenantConfigInput["serviceArea"];
  timezone?: string;
  hours?: TenantConfigInput["hours"];
  services?: TenantConfigInput["services"];
  onCall?: TenantConfigInput["onCall"];
  transfer?: TenantConfigInput["transfer"];
  recording?: TenantConfigInput["recording"];
  sms?: TenantConfigInput["sms"];
  voice?: TenantConfigInput["voice"];
  booking?: TenantConfigInput["booking"];
  triage?: TenantConfigInput["triage"];
  fieldService?: TenantConfigInput["fieldService"];
  calendar?: TenantConfigInput["calendar"];
  notOffered?: string[];
  holidays?: string[];
}

export function createTenantFromTemplate(answers: OnboardingAnswers): TenantConfig {
  const d = PLUMBING_TEMPLATE_DEFAULTS;
  return parseTenantConfig({
    ...d,
    ...answers,
    onCall: { ...d.onCall, ...answers.onCall },
    transfer: { ...d.transfer, ...answers.transfer },
    recording: { ...d.recording, ...answers.recording },
    sms: { ...d.sms, ...answers.sms },
    booking: { ...d.booking, ...answers.booking },
    triage: { ...d.triage, ...answers.triage },
    fieldService: { ...d.fieldService, ...answers.fieldService },
    calendar: { ...d.calendar, ...answers.calendar },
  });
}

/** Demo tenant used by mock mode, seeds and the scenario suite. */
export const DEMO_ANSWERS: OnboardingAnswers = {
  brand: {
    companyName: "Lone Star Rapid Plumbing",
    spokenName: "Lone Star Plumbing",
    agentName: "Riley",
    website: "https://example.com",
    primaryColor: "#0B5FFF",
    licensedBondedInsured: true,
  },
  timezone: "America/Chicago",
  pricing: { tripFee: 89, tripFeeLabel: "service call fee", afterHoursTripFee: 149, creditedTowardRepair: true, allowStartingAtPrices: false },
  serviceArea: {
    zips: ["78701", "78702", "78703", "78704", "78705", "78712", "78721", "78722", "78723", "78741", "78745", "78751", "78756", "78757"],
    description: "central Austin",
  },
  onCall: {
    enabled: true,
    shifts: [
      { name: "Marco (on-call)", phone: "+15125550111", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], order: 0 },
      { name: "Dana (backup)", phone: "+15125550112", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], order: 1 },
    ],
    fallbackPhone: "+15125550113",
    alwaysAlertOnEmergency: true,
  },
  transfer: { officeNumber: "+15125550100", dialTimeoutSec: 20, emergencyCallbackMinutes: 10 },
  triage: { vulnerableOccupantUpgradesToP1: false, transferP1DuringHours: false, gasUtilityLine: "Texas Gas Service (emergency number on your gas bill)" },
};

export function demoTenantConfig(): TenantConfig {
  return createTenantFromTemplate(DEMO_ANSWERS);
}
