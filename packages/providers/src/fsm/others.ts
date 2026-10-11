/**
 * Housecall Pro and Jobber adapters.
 *
 * Housecall Pro: REST shape (POST /customers, POST /jobs with schedule
 * start/end, Bearer API key) cross-checked with NoBanks/housecallpro-mcp
 * (MIT, housecallpro_mcp/client.py). Behind FSM_HOUSECALLPRO_ENABLED;
 * dry-run unless FSM_HOUSECALLPRO_LIVE=true. Secret: HOUSECALLPRO_API_KEY.
 *
 * Jobber: GraphQL (clientCreate + jobCreate / requestCreate) needs an OAuth
 * app per account; stubbed until a Jobber pilot tenant exists.
 */
import { FsmNotEnabledError, type FieldServiceAdapter, type FsmJobInput, type FsmJobResult } from "./types";

export class HousecallProAdapter implements FieldServiceAdapter {
  readonly name = "housecallpro" as const;
  constructor(
    private readonly env: { enabled: boolean; live: boolean; apiKey?: string; baseUrl?: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (m: string, d?: unknown) => void = () => undefined,
  ) {}
  get enabled() {
    return this.env.enabled;
  }
  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.env.baseUrl ?? "https://api.housecallpro.com"}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.apiKey}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Housecall Pro ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as Record<string, unknown>;
  }
  async createJob(input: FsmJobInput): Promise<FsmJobResult> {
    if (!this.env.enabled) throw new FsmNotEnabledError("Housecall Pro", "FSM_HOUSECALLPRO_ENABLED");
    const [first, ...last] = input.customerName.split(/\s+/);
    const customer = { first_name: first ?? input.customerName, last_name: last.join(" ") || "-", mobile_phone: input.customerPhone };
    const job = { description: `[${input.priority}] ${input.problem}`, schedule: { start_time: input.start.toISOString(), end_time: input.end.toISOString() } };
    if (!this.env.live) {
      this.log("housecallpro dry-run job", { customer, job });
      return { ref: `dry-run:${input.externalId}`, dryRun: true, provider: this.name };
    }
    if (!this.env.apiKey) throw new Error("HOUSECALLPRO_API_KEY not set");
    const created = await this.post("/customers", customer);
    const res = await this.post("/jobs", { customer_id: created.id, ...job });
    return { ref: String(res.id ?? ""), dryRun: false, provider: this.name };
  }
}

export class JobberAdapter implements FieldServiceAdapter {
  readonly name = "jobber" as const;
  constructor(private readonly env: { enabled: boolean }) {}
  get enabled() {
    return this.env.enabled;
  }
  async createJob(_input: FsmJobInput): Promise<FsmJobResult> {
    if (!this.env.enabled) throw new FsmNotEnabledError("Jobber", "FSM_JOBBER_ENABLED");
    throw new Error("Jobber adapter not implemented yet: requires a Jobber OAuth app (GraphQL clientCreate + requestCreate). See docs/field-service.md.");
  }
}

export class NoFsmAdapter implements FieldServiceAdapter {
  readonly name = "none" as const;
  readonly enabled = false;
  async createJob(input: FsmJobInput): Promise<FsmJobResult> {
    return { ref: "", dryRun: true, provider: `none:${input.externalId}` };
  }
}
