import { AgencyShell } from "@/components/AgencyShell";
import { api } from "@/lib/api";
import type { Tenant } from "@/lib/types";

export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await api<Tenant>(`/api/tenants/${id}`);
  return <AgencyShell tenant={{ id: tenant.id, name: tenant.name }}>{children}</AgencyShell>;
}
