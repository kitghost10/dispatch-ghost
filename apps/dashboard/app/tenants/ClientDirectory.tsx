"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/PageHeader";
import { fmtPhone } from "@/lib/format";
import type { TenantSummary } from "@/lib/types";
export function ClientDirectory({ tenants }: { tenants: TenantSummary[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const visible = tenants.filter((client) => (status === "all" || client.status === status) && `${client.name} ${client.numbers.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="directory"><div className="directory-heading"><div><h2>Client workspaces <span className="count-label">{tenants.length}</span></h2><p className="muted">Everything you need to manage each receptionist.</p></div><label className="search-field"><Icon name="search" size={18}/><input aria-label="Search clients" placeholder="Search clients or phone numbers…" value={search} onChange={(e) => setSearch(e.target.value)}/></label></div>
    <div className="filter-row" aria-label="Filter clients">{[["all", "All clients"], ["active", "Active"], ["onboarding", "In setup"], ["paused", "Paused"]].map(([key, label]) => <button type="button" key={key} className={status === key ? "selected" : ""} aria-pressed={status === key} onClick={() => setStatus(key)}>{label}<span>{key === "all" ? tenants.length : tenants.filter((t) => t.status === key).length}</span></button>)}</div>
    {visible.length ? <div className="client-grid">{visible.map((client, index) => <article className="client-card" key={client.id}>
      <div className="client-card-top"><span className={`client-avatar color-${index % 4}`}>{client.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase()}</span><span className={`status-tag ${client.status}`}><span/>{client.status === "onboarding" ? "In setup" : client.status === "active" ? "Active" : "Paused"}</span></div>
      <Link className="client-name" href={`/t/${client.id}`}>{client.name}</Link><p className="client-number">{client.numbers.length ? client.numbers.map(fmtPhone).join(" · ") : "Phone number not assigned"}</p>
      <div className="channel-chips"><span className={!client.channels?.voice ? "disabled" : ""}><Icon name="phone" size={14}/>{client.channels?.voice ? "Voice on" : "Voice off"}</span><span className={!client.channels?.sms ? "disabled" : ""}><Icon name="message" size={14}/>{client.channels?.sms ? "SMS on" : "SMS off"}</span><span className="agent-chip"><Icon name="spark" size={13}/>{client.agentName ?? "Receptionist"}</span></div>
      <div className="client-metrics"><div><strong>{client.stats.calls7d}</strong><span>Calls / 7d</span></div><div><strong>{client.stats.bookings7d}</strong><span>Booked / 7d</span></div><div><strong className={client.stats.openCallbacks ? "attention-number" : ""}>{client.stats.openCallbacks}</strong><span>Follow-ups</span></div></div>
      <div className="client-card-footer"><Link href={`/t/${client.id}/settings`} className="card-action"><Icon name="settings" size={15}/>{client.status === "onboarding" ? "Finish setup" : "Client setup"}</Link><Link href={`/t/${client.id}`} className="card-open" aria-label={`Open ${client.name}`}><Icon name="arrow" size={18}/></Link></div>
    </article>)}</div> : <EmptyState title={tenants.length ? "No clients match your search" : "Your first client starts here"} description={tenants.length ? "Try another name, phone number, or status." : "Add their business details, choose voice or SMS, and test their receptionist."} action={tenants.length ? <button className="secondary" onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</button> : <Link className="btn" href="/tenants/new"><Icon name="plus" size={17}/> Add your first client</Link>}/>}
  </section>;
}
