import Link from "next/link";
import { api } from "@/lib/api";
import { setStatusAction } from "@/app/actions";
import { CallsTable } from "@/components/CallsTable";
import { PageHeader } from "@/components/PageHeader";
import { Icon, type IconName } from "@/components/Icon";
import { fmtPhone } from "@/lib/format";
import type { Call, Stats, Tenant } from "@/lib/types";
export const dynamic = "force-dynamic";
export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, stats, calls] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<Stats>(`/api/tenants/${id}/stats`), api<Call[]>(`/api/tenants/${id}/calls?limit=8`)]);
  const cards: Array<[string, number, IconName]> = [["Calls this week", stats.calls7d, "phone"], ["Appointments booked", stats.bookings7d, "calendar"], ["Open follow-ups", stats.openCallbacks, "clock"], ["Urgent conversations", stats.emergencies7d + stats.lifeSafety7d, "shield"]];
  return <><PageHeader eyebrow="CLIENT OVERVIEW" title={tenant.name} description={`${tenant.numbers.map(fmtPhone).join(" · ") || "Phone number not assigned"} · ${tenant.config.timezone}`} actions={<><Link className="btn secondary" href={`/t/${id}/settings`}><Icon name="settings" size={15}/>Client setup</Link><Link className="btn" href={`/t/${id}/simulator`}><Icon name="play" size={15}/>Test receptionist</Link></>}/>
    <div className="client-banner"><div className="row"><span className="client-avatar color-0"><Icon name="spark" size={20}/></span><div><strong>{tenant.config.brand.agentName}, your receptionist</strong><p className="muted">{tenant.status === "active" ? "Client account active" : tenant.status === "paused" ? "Receptionist paused · calls forward to the office" : "Set up and test before going live"}</p></div><span className={`status-tag ${tenant.status}`}><span/>{tenant.status === "onboarding" ? "In setup" : tenant.status === "active" ? "Active" : "Paused"}</span></div><form action={setStatusAction.bind(null, id)}><input type="hidden" name="status" value={tenant.status === "active" ? "paused" : "active"}/><button type="submit" className="secondary">{tenant.status === "active" ? "Pause receptionist" : "Activate receptionist"}</button></form></div>
    <div className="summary-grid">{cards.map(([label, value, icon]) => <article className="summary-card" key={label}><div className="summary-top"><span>{label}</span><span className="summary-icon"><Icon name={icon} size={17}/></span></div><strong>{value.toString().padStart(2, "0")}</strong><p>{label === "Open follow-ups" ? "Waiting for the team" : "In the last 7 days"}</p></article>)}</div>
    <div className="channel-overview"><section className="panel"><span className="channel-heading-icon" style={{ margin: 0 }}><Icon name="phone"/></span><div><h3>Voice receptionist</h3><p className="muted">{tenant.config.voice.enabled ? "Enabled" : "Off"} · {tenant.config.voice.provider === "elevenlabs" ? "ElevenLabs" : tenant.config.voice.provider === "deepgram-openrouter" ? "Deepgram + OpenRouter" : "Agency voice settings"}</p></div><Link href={`/t/${id}/settings`} aria-label="Configure voice receptionist"><Icon name="arrow" size={18}/></Link></section><section className="panel"><span className="channel-heading-icon sms-icon" style={{ margin: 0 }}><Icon name="message"/></span><div><h3>SMS replies</h3><p className="muted">{tenant.config.sms.enabled ? tenant.config.sms.aiReplies ? "Automatic replies enabled" : "Team handles incoming texts" : "Messaging is off"}</p></div><Link href={`/t/${id}/settings`} aria-label="Configure SMS replies"><Icon name="arrow" size={18}/></Link></section></div>
    <section className="table-section"><div className="table-section-heading"><h2>Recent conversations</h2><Link href={`/t/${id}/calls`}>View all calls <Icon name="arrow" size={15}/></Link></div><CallsTable tenantId={id} calls={calls} tz={tenant.config.timezone}/></section>
  </>;
}
