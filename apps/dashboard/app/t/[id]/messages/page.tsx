import { api } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import type { MissedText, Sms, Tenant } from "@/lib/types";
import { MessageInbox } from "./MessageInbox";
export const dynamic = "force-dynamic";
export default async function MessagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, missed, sms] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<MissedText[]>(`/api/tenants/${id}/missed-calls`), api<Sms[]>(`/api/tenants/${id}/sms`)]);
  return <><PageHeader eyebrow="CUSTOMER CONVERSATIONS" title="Messages" description="Every text and follow-up, together in one inbox."/><MessageInbox sms={sms} missed={missed} timezone={tenant.config.timezone}/></>;
}
