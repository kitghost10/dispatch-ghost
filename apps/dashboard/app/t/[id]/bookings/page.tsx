import Link from "next/link";
import { api } from "@/lib/api";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { PriorityBadge } from "@/components/Badges";
import { fmtPhone, fmtTime, humanize } from "@/lib/format";
import type { Booking, Tenant } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function BookingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [tenant, bookings] = await Promise.all([api<Tenant>(`/api/tenants/${id}`), api<Booking[]>(`/api/tenants/${id}/bookings`)]);
  return (
    <>
      <PageHeader eyebrow="SCHEDULING" title="Appointments" description="The next visits, booked by your receptionist."/>
      {bookings.length === 0 ? <EmptyState title="The next appointment starts with a conversation" description="Appointments booked by the receptionist appear here with customer details and arrival windows." action={<Link className="btn secondary" href={`/t/${id}/settings`}>Set up booking</Link>}/> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Arrival</th><th>Customer</th><th>Service</th><th>Priority</th><th>Address</th><th>Problem</th><th>Sync</th></tr></thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id}>
                <td>{fmtTime(b.startsAt, tenant.config.timezone)}<div className="muted">{b.windowLabel}</div></td>
                <td>{b.customerName}<div className="muted">{fmtPhone(b.customerPhone)}</div></td>
                <td>{humanize(b.serviceKey)}</td>
                <td><PriorityBadge p={b.priority} /></td>
                <td>{b.address}</td>
                <td className="muted" style={{ maxWidth: 260 }}>{b.problem.slice(0, 140)}{b.callId ? <div><Link href={`/t/${id}/calls/${b.callId}`}>call →</Link></div> : null}</td>
                <td className="muted">{b.calendarEventId ? "calendar ✓" : "—"}<br />{b.fsmProvider ? `${b.fsmProvider}: ${b.fsmRef}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
