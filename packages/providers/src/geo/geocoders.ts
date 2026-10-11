import type { Geocoder, GeoPoint } from "@sb/core";

/**
 * US Census Bureau geocoder (free, no key) for full street addresses.
 * https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 * ZIP-only queries are not supported by this API; tenants using a radius
 * should also generate a ZIP list (scripts/zips-in-radius.ts).
 */
export class CensusGeocoder implements Geocoder {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async geocode(query: string): Promise<(GeoPoint & { zip?: string }) | null> {
    if (/^\d{5}$/.test(query.trim())) return null;
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(query)}&benchmark=Public_AR_Current&format=json`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: { addressMatches?: Array<{ coordinates: { x: number; y: number }; addressComponents?: { zip?: string } }> } };
    const m = json.result?.addressMatches?.[0];
    if (!m) return null;
    return { lat: m.coordinates.y, lng: m.coordinates.x, ...(m.addressComponents?.zip ? { zip: m.addressComponents.zip } : {}) };
  }
}

/** Fixed lookup table for tests and mock mode. */
export class StaticGeocoder implements Geocoder {
  constructor(private readonly table: Record<string, GeoPoint & { zip?: string }>) {}
  async geocode(query: string) {
    const key = Object.keys(this.table).find((k) => query.includes(k));
    return key ? this.table[key]! : null;
  }
}
