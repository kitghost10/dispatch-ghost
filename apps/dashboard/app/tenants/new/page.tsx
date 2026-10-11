import { AgencyShell } from "@/components/AgencyShell";
import { api } from "@/lib/api";
import type { AgencySettings } from "../../../../../packages/core/src/tenant/config";
import { PageHeader } from "@/components/PageHeader";
import { OnboardingForm } from "./OnboardingForm";

export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  const [template, agency] = await Promise.all([api<{ services: unknown[]; example: Record<string, unknown> }>("/api/onboarding/template"), api<{ settings: AgencySettings }>("/api/agency/settings")]);
  return (
    <AgencyShell>
      <PageHeader eyebrow="GROW YOUR AGENCY" title="Add a client" description="A few details. Their own receptionist. Ready to make a great first impression."/>
      <OnboardingForm services={template.services} agencySettings={agency.settings} />
    </AgencyShell>
  );
}
