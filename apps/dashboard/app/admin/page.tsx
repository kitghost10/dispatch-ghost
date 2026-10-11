import { AgencyShell } from "@/components/AgencyShell";
import { api } from "@/lib/api";
import type { ProviderSetup, Tenant } from "@/lib/types";
import type { AgencySettings } from "../../../../packages/core/src/tenant/config";
import { PageHeader } from "@/components/PageHeader";
import { AdminSettings } from "./AdminSettings";
export const dynamic = "force-dynamic";
export default async function AdminPage() {
  const [initial, setup] = await Promise.all([
    api<{ config: Tenant["config"]; settings: AgencySettings; accounts: Array<{ id: string; name: string; status: string }> }>("/api/agency/settings"),
    api<ProviderSetup>("/api/setup"),
  ]);
  return <AgencyShell><PageHeader eyebrow="AGENCY SETTINGS" title="Admin panel" description="Your agency defaults. One change, every client."/><AdminSettings initial={initial} setup={setup} /></AgencyShell>;
}
