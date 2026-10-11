/**
 * Field-service management (FSM) integration boundary: ServiceTitan,
 * Housecall Pro, Jobber. Adapters push a booked job; availability still comes
 * from the calendar/booking engine unless an adapter implements it later.
 */
export interface FsmJobInput {
  tenantSettings: Record<string, string>;
  customerName: string;
  customerPhone: string;
  address: string;
  zip?: string | null;
  problem: string;
  priority: "P1" | "P2" | "P3";
  serviceKey: string;
  start: Date;
  end: Date;
  externalId: string;
}

export interface FsmJobResult {
  ref: string;
  dryRun: boolean;
  provider: string;
}

export interface FieldServiceAdapter {
  readonly name: "servicetitan" | "housecallpro" | "jobber" | "none";
  readonly enabled: boolean;
  createJob(input: FsmJobInput): Promise<FsmJobResult>;
}

export class FsmNotEnabledError extends Error {
  constructor(provider: string, flag: string) {
    super(`${provider} adapter is disabled. Set ${flag}=true to enable.`);
    this.name = "FsmNotEnabledError";
  }
}
