import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { PriorityBadge, Pill } from "@/components/Badges";
import { fmtPhone, fmtTime, humanize } from "@/lib/format";
import type { CallDetail, Tenant } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CallDetailPage({ params }: { params: Promise<{ id: string; callId: string }> }) {
  const { id, callId } = await params;
  const [tenant, d] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<CallDetail>(`/api/tenants/${id}/calls/${callId}`)]);
  const tz = tenant.config.timezone;
  const c = d.call;
  const facts = d.facts ?? {};
  const factRows = Object.entries(facts).filter(([k, v]) => k !== "description" && v !== undefined && !(Array.isArray(v) && v.length === 0));
  return (
    <>
      <PageHeader eyebrow="CONVERSATION DETAILS" title={fmtPhone(c.fromE164)} description={`${fmtTime(c.startedAt, tz)} · ${humanize(c.outcome)}`} actions={<Link className="btn secondary" href={`/t/${id}/calls`}>Back to calls</Link>}/>
      <div className="row" style={{ marginBottom: 22 }}><PriorityBadge p={c.priority}/><Pill>{c.channel === "voice" ? "Phone call" : c.channel === "simulator" ? "Test conversation" : "Text message"}</Pill>{c.afterHours ? <Pill>After hours</Pill> : null}{c.durationSec ? <Pill>{c.durationSec}s</Pill> : null}{c.recordingUrl ? <a href={c.recordingUrl}>Listen to recording</a> : null}</div>
      <div className="two">
        <section className="panel">
          <h2 style={{ marginTop: 0 }}>Transcript</h2>
          <div className="transcript">
            {d.transcript.length === 0 ? <p className="muted">No transcript (missed call).</p> : null}
            {d.transcript.map((t) => (
              <div key={t.id} className={`bubble ${t.role}`} title={fmtTime(t.at, tz)}>{t.text}</div>
            ))}
          </div>
        </section>
        <div className="grid" style={{ alignContent: "start" }}>
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>Conversation insights</h2>
            <p><PriorityBadge p={d.triage?.priority ?? c.priority} /> {humanize(c.issue)}</p>
            {c.safetyFlags.length ? <p className="error">Safety flags: {c.safetyFlags.map(humanize).join(", ")}</p> : null}
            <details className="advanced-details"><summary>Decision details</summary><div className="mono">{(d.triage?.reasonCodes ?? c.reasonCodes).map((r) => <div key={r}>{r}</div>)}</div></details>
            {factRows.length ? (
              <>
                <h2>Facts gathered</h2>
                <table><tbody>{factRows.map(([k, v]) => <tr key={k}><td className="muted">{humanize(k)}</td><td>{String(v)}</td></tr>)}</tbody></table>
              </>
            ) : null}
          </section>
          {d.bookings.length ? (
            <section className="panel">
              <h2 style={{ marginTop: 0 }}>Booking</h2>
              {d.bookings.map((b) => (
                <div key={b.id}>
                  <b>{b.customerName}</b> · {humanize(b.serviceKey)}<br />
                  {b.windowLabel}<br />{b.address}
                  <div className="muted">calendar: {b.calendarEventId ?? "—"} · FSM: {b.fsmProvider ? `${b.fsmProvider} ${b.fsmRef}` : "—"}</div>
                </div>
              ))}
            </section>
          ) : null}
          {c.summary ? <section className="panel"><h2 style={{ marginTop: 0 }}>Summary</h2><p>{c.summary}</p></section> : null}
          <section className="panel">
            <details className="advanced-details"><summary>Conversation event history</summary>
            <div className="mono">
              {d.events.map((e) => <div key={e.id}>{fmtTime(e.at, tz)} {e.type}</div>)}
            </div></details>
          </section>
        </div>
      </div>
    </>
  );
}
