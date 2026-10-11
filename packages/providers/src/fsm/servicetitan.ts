/**
 * ServiceTitan adapter — pushes a Booking into ServiceTitan's CRM "booking
 * provider" inbox, where the CSR converts it to a job. This is ServiceTitan's
 * intended path for third-party lead sources and avoids needing job-type/
 * business-unit/campaign ids up front.
 *
 * Endpoints and auth (client_credentials against auth.servicetitan.io, the
 * ST-App-Key header) cross-checked with montrellcruse/servicetitan-mcp
 * (MIT, src/client.ts and src/contracts). No code copied.
 *
 * Behind flags:
 *   FSM_SERVICETITAN_ENABLED=true   adapter is active (otherwise throws)
 *   FSM_SERVICETITAN_LIVE=true      actually POSTs; otherwise dry-run (logs payload, returns dry-run ref)
 * Secrets (env): SERVICETITAN_CLIENT_ID, SERVICETITAN_CLIENT_SECRET, SERVICETITAN_APP_KEY
 * Tenant settings: tenantId (ST tenant), bookingProviderId, environment (production|integration)
 */
import { FsmNotEnabledError, type FieldServiceAdapter, type FsmJobInput, type FsmJobResult } from "./types";

export interface ServiceTitanEnv {
  enabled: boolean;
  live: boolean;
  clientId?: string;
  clientSecret?: string;
  appKey?: string;
}

const HOSTS = {
  production: { auth: "https://auth.servicetitan.io", api: "https://api.servicetitan.io" },
  integration: { auth: "https://auth-integration.servicetitan.io", api: "https://api-integration.servicetitan.io" },
};

export function buildServiceTitanBooking(input: FsmJobInput) {
  const [street, ...rest] = input.address.split(",").map((s) => s.trim());
  return {
    source: "Sonic Bold AI Receptionist",
    name: input.customerName,
    summary: `[${input.priority}] ${input.problem}`.slice(0, 2000),
    isFirstTimeClient: true,
    externalId: input.externalId,
    start: input.start.toISOString(),
    address: { street: street ?? input.address, city: rest[0] ?? "", state: rest[1]?.split(" ")[0] ?? "", zip: input.zip ?? "", country: "USA" },
    contacts: [{ type: "MobilePhone", value: input.customerPhone, memo: "Caller ID" }],
    priority: input.priority === "P1" ? "Urgent" : input.priority === "P2" ? "High" : "Normal",
  };
}

export class ServiceTitanAdapter implements FieldServiceAdapter {
  readonly name = "servicetitan" as const;
  private token: { value: string; exp: number } | null = null;
  constructor(private readonly env: ServiceTitanEnv, private readonly fetchImpl: typeof fetch = fetch, private readonly log: (m: string, d?: unknown) => void = () => undefined) {}

  get enabled() {
    return this.env.enabled;
  }

  private async accessToken(host: string): Promise<string> {
    const now = Date.now() / 1000;
    if (this.token && this.token.exp - 60 > now) return this.token.value;
    if (!this.env.clientId || !this.env.clientSecret) throw new Error("SERVICETITAN_CLIENT_ID / SERVICETITAN_CLIENT_SECRET not set");
    const res = await this.fetchImpl(`${host}/connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.env.clientId, client_secret: this.env.clientSecret }),
    });
    if (!res.ok) throw new Error(`ServiceTitan auth ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, exp: now + json.expires_in };
    return json.access_token;
  }

  async createJob(input: FsmJobInput): Promise<FsmJobResult> {
    if (!this.env.enabled) throw new FsmNotEnabledError("ServiceTitan", "FSM_SERVICETITAN_ENABLED");
    const stTenant = input.tenantSettings.tenantId;
    const provider = input.tenantSettings.bookingProviderId;
    if (!stTenant || !provider) throw new Error("ServiceTitan tenant settings need tenantId and bookingProviderId");
    const body = buildServiceTitanBooking(input);
    if (!this.env.live) {
      this.log("servicetitan dry-run booking", { stTenant, provider, body });
      return { ref: `dry-run:${input.externalId}`, dryRun: true, provider: this.name };
    }
    if (!this.env.appKey) throw new Error("SERVICETITAN_APP_KEY not set");
    const hosts = HOSTS[input.tenantSettings.environment === "integration" ? "integration" : "production"];
    const res = await this.fetchImpl(`${hosts.api}/crm/v2/tenant/${encodeURIComponent(stTenant)}/booking-provider/${encodeURIComponent(provider)}/bookings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken(hosts.auth)}`, "ST-App-Key": this.env.appKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ServiceTitan booking ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id?: number | string };
    return { ref: String(json.id ?? ""), dryRun: false, provider: this.name };
  }
}
