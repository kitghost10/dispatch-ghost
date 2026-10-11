import Link from "next/link";
import { AgencyShell } from "@/components/AgencyShell";
import { Icon, type IconName } from "@/components/Icon";
import { api } from "@/lib/api";
import type { TenantSummary, Tenant } from "@/lib/types";
import { ClientDirectory } from "./ClientDirectory";
export const dynamic = "force-dynamic";
export default async function TenantsPage() {
  const summaries = await api<TenantSummary[]>("/api/tenants");
  const tenants = await Promise.all(summaries.map(async (client) => {
    if (client.channels) return client;
    const detail = await api<Tenant>(`/api/tenants/${client.id}`);
    return { ...client, channels: { voice: detail.config.voice.enabled, sms: detail.config.sms.enabled }, agentName: detail.config.brand.agentName };
  }));
  const stats: Array<{ label: string; value: number; detail: string; icon: IconName }> = [
    { label: "Client accounts", value: tenants.length, detail: `${tenants.filter((t) => t.status === "active").length} active receptionists`, icon: "clients" },
    { label: "Calls this week", value: tenants.reduce((sum, t) => sum + t.stats.calls7d, 0), detail: "Across all client accounts", icon: "phone" },
    { label: "Appointments booked", value: tenants.reduce((sum, t) => sum + t.stats.bookings7d, 0), detail: "In the last 7 days", icon: "calendar" },
    { label: "Open follow-ups", value: tenants.reduce((sum, t) => sum + t.stats.openCallbacks, 0), detail: "Customers waiting for a callback", icon: "clock" },
  ];
  const pending = tenants.filter((t) => t.status === "onboarding" || !t.numbers.length);
  return <AgencyShell><div className="dashboard-hero"><div><span className="eyebrow">YOUR AGENCY, CONNECTED</span><h1>A clear view of<br/>every client.</h1><p>Manage your receptionists, keep conversations moving,<br className="desktop-break"/> and give every business a better first hello.</p><div className="row"><Link className="btn hero-primary" href="/tenants/new"><Icon name="plus" size={18}/>Add client</Link><Link className="hero-link" href="/admin">Agency settings <Icon name="arrow" size={16}/></Link></div></div><div className="hero-art" aria-hidden="true"><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="hero-call"><span className="hero-call-icon"><Icon name="phone" size={23}/></span><span><strong>Your next conversation.</strong><small>Voice & messaging, working together.</small></span><span className="audio-bars">{[12, 22, 16, 30, 20, 13].map((height, i) => <i key={i} style={{ height }}/>)}</span></div><div className="hero-message"><Icon name="message" size={18}/><span>A warm welcome. Every time.</span></div><span className="hero-star">✦</span></div></div>
    <div className="summary-grid">{stats.map((stat) => <article className="summary-card" key={stat.label}><div className="summary-top"><span>{stat.label}</span><span className="summary-icon"><Icon name={stat.icon} size={18}/></span></div><strong>{stat.value.toString().padStart(2, "0")}</strong><p>{stat.detail}</p></article>)}</div>
    {pending.length ? <div className="attention-strip"><span className="attention-icon"><Icon name="settings" size={17}/></span><span><strong>{pending.length} client{pending.length === 1 ? "" : "s"} still in setup.</strong> Add a number and test the receptionist before going live.</span><Link href={`/t/${pending[0].id}/settings`}>Continue setup <Icon name="arrow" size={16}/></Link></div> : null}
    <ClientDirectory tenants={tenants}/>
  </AgencyShell>;
}
