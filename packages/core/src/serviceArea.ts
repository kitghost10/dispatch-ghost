/**
 * Service-area enforcement. Checked in code before any booking or transfer —
 * open-receptionist: "the instruction lets the agent decline early and
 * politely, the check makes declining unavoidable".
 */
import type { TenantConfig } from "./tenant/config";

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Geocoder {
  /** Resolve a US ZIP or street address to a point. Return null when unknown. */
  geocode(query: string): Promise<(GeoPoint & { zip?: string }) | null>;
}

export type ServiceAreaResult =
  | { inArea: true; zip?: string; method: "zip" | "radius"; distanceMiles?: number }
  | { inArea: false; zip?: string; method: "zip" | "radius" | "unknown"; reason: string; distanceMiles?: number };

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;
const SPOKEN_DIGITS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/** Extract a ZIP from text, including spoken digits ("seven eight seven oh four"). */
export function extractZip(text: string): string | undefined {
  const direct = ZIP_RE.exec(text);
  if (direct) return direct[1];
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  let digits = "";
  for (const token of tokens) {
    if (/^\d+$/.test(token)) digits += token;
    else if (SPOKEN_DIGITS[token] !== undefined) digits += SPOKEN_DIGITS[token];
    else {
      if (digits.length === 5) return digits;
      digits = "";
    }
  }
  return digits.length === 5 ? digits : undefined;
}

export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export async function checkServiceArea(
  config: TenantConfig,
  input: { zip?: string; address?: string },
  geocoder?: Geocoder,
): Promise<ServiceAreaResult> {
  const area = config.serviceArea;
  const zip = input.zip ?? (input.address ? extractZip(input.address) : undefined);
  if (zip && area.zips.includes(zip)) return { inArea: true, zip, method: "zip" };
  if (area.radius) {
    if (!geocoder) {
      return { inArea: false, zip, method: "unknown", reason: "radius_configured_without_geocoder" };
    }
    const query = input.address ?? zip;
    if (!query) return { inArea: false, method: "unknown", reason: "no_location" };
    const point = await geocoder.geocode(query);
    if (!point) return { inArea: false, zip, method: "unknown", reason: "geocode_failed" };
    const distanceMiles = haversineMiles({ lat: area.radius.centerLat, lng: area.radius.centerLng }, point);
    const resolvedZip = zip ?? point.zip;
    if (distanceMiles <= area.radius.miles) return { inArea: true, zip: resolvedZip, method: "radius", distanceMiles };
    return { inArea: false, zip: resolvedZip, method: "radius", reason: "outside_radius", distanceMiles };
  }
  if (!zip) return { inArea: false, method: "unknown", reason: "no_zip" };
  return { inArea: false, zip, method: "zip", reason: "zip_not_listed" };
}
