import Link from "next/link";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { CallsTable } from "@/components/CallsTable";
import type { Call, Tenant } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CallsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ priority?: string }> }) {
  const { id } = await params;
  const { priority } = await searchParams;
  const q = priority && /^P[0-3]$/.test(priority) ? `&priority=${priority}` : "";
  const [tenant, calls] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<Call[]>(`/api/tenants/${id}/calls?limit=200${q}`)]);
  return (
    <>
      <PageHeader eyebrow="CONVERSATIONS" title="Calls" description="See what callers needed and how the receptionist handled it."/>
      <div className="tabs">
        <Link href={`/t/${id}/calls`} aria-current={!q ? "page" : undefined}>All calls</Link>
        {["P0", "P1", "P2", "P3"].map((p) => <Link key={p} href={`/t/${id}/calls?priority=${p}`} aria-current={priority === p ? "page" : undefined}>{({ P0: "Life safety", P1: "Urgent", P2: "Same-day", P3: "Routine" } as Record<string, string>)[p]}</Link>)}
      </div>
      <CallsTable tenantId={id} calls={calls} tz={tenant.config.timezone} />
    </>
  );
}
