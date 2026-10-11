import Link from "next/link";
import { api } from "@/lib/api";
import { completeCallbackAction } from "@/app/actions";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { PriorityBadge, Pill } from "@/components/Badges";
import { fmtPhone, fmtTime, humanize } from "@/lib/format";
import type { Alert, Callback, Priority, Tenant } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CallbacksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, callbacks, alerts] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<Callback[]>(`/api/tenants/${id}/callbacks`), api<Alert[]>(`/api/tenants/${id}/alerts`)]);
  const tz = tenant.config.timezone;
  const now = Date.now();
  return (
    <>
      <PageHeader eyebrow="NEEDS YOUR ATTENTION" title="Follow-ups" description="Keep callbacks and urgent handoffs moving."/>
      <h2>Callback tasks</h2>
      {callbacks.length === 0 ? <EmptyState title="All caught up" description="Customers waiting for a callback will appear here."/> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Due</th><th>Priority</th><th>Caller</th><th>Reason</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {callbacks.map((c) => {
              const overdue = c.status === "open" && new Date(c.dueAt).getTime() < now;
              return (
                <tr key={c.id}>
                  <td>{fmtTime(c.dueAt, tz)}{overdue ? <div><Pill tone="bad">overdue</Pill></div> : null}</td>
                  <td><PriorityBadge p={c.priority} /></td>
                  <td>{c.name ?? ""}<div>{fmtPhone(c.callerPhone)}</div></td>
                  <td>{humanize(c.reason)}{c.callId ? <div><Link href={`/t/${id}/calls/${c.callId}`}>call →</Link></div> : null}</td>
                  <td className="muted" style={{ maxWidth: 380 }}>{c.notes}</td>
                  <td>
                    {c.status === "open" ? (
                      <form action={completeCallbackAction.bind(null, id, c.id)}><button type="submit">Mark complete</button></form>
                    ) : <Pill tone="ok">done</Pill>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      <h2>On-call alerts</h2>
      {alerts.length === 0 ? <div className="notice">No on-call alerts yet. Urgent handoffs appear here when they happen.</div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Priority</th><th>Reason</th><th>Sent to</th><th>Message</th><th>Status</th></tr></thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.id}>
                <td>{fmtTime(a.createdAt, tz)}</td>
                <td><PriorityBadge p={a.priority as Priority} /></td>
                <td>{humanize(a.reason)}</td>
                <td>{a.recipients.map((r) => `${r.name} ${fmtPhone(r.phone)}`).join(", ")}</td>
                <td className="muted" style={{ maxWidth: 420 }}>{a.body}</td>
                <td>{a.status}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
