import { api } from "@/lib/api";
import type { Tenant, ProviderSetup } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { SettingsEditor } from "./SettingsEditor";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, setup] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<ProviderSetup>("/api/setup")]);
  return (
    <>
      <PageHeader eyebrow="RECEPTIONIST SETTINGS" title="Client setup" description={`Personalize the receptionist for ${tenant.name}.`}/>
      <SettingsEditor tenantId={id} initial={JSON.stringify(tenant.config, null, 2)} setup={setup} numbers={tenant.numbers} />
    </>
  );
}
