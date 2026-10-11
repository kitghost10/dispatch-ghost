import Link from "next/link";
import { EmptyState } from "./PageHeader";
import { PriorityBadge, Pill } from "./Badges";
import { fmtPhone, fmtTime, humanize } from "@/lib/format";
import type { Call } from "@/lib/types";

function outcomeTone(o: string | null): "ok" | "warn" | "bad" | "muted" {
  if (!o) return "muted";
  if (["booked", "transferred"].includes(o)) return "ok";
  if (["safety_evacuate", "transfer_failed_callback"].includes(o)) return "bad";
  if (["callback_scheduled", "message_taken", "abandoned", "price_only"].includes(o)) return "warn";
  return "muted";
}

export function CallsTable({ tenantId, calls, tz }: { tenantId: string; calls: Call[]; tz: string }) {
  if (!calls.length) return <EmptyState title="No conversations yet" description="Calls, summaries, and outcomes will appear here once customers reach the receptionist." action={<Link className="btn secondary" href={`/t/${tenantId}/simulator`}>Test the receptionist</Link>}/>;
  return (
    <div className="table-wrap"><table>
      <thead>
        <tr><th>When</th><th>Caller</th><th>Channel</th><th>Triage</th><th>Issue</th><th>Outcome</th><th>Summary</th></tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={c.id}>
            <td><Link href={`/t/${tenantId}/calls/${c.id}`}>{fmtTime(c.startedAt, tz)}</Link>{c.afterHours ? <div><Pill>after hours</Pill></div> : null}</td>
            <td>{fmtPhone(c.fromE164)}</td>
            <td>{c.channel === "voice" ? "Phone" : c.channel === "sms" ? "SMS" : "Test"}{c.missed ? <div><Pill tone="warn">missed</Pill></div> : null}</td>
            <td><PriorityBadge p={c.priority} /></td>
            <td>{humanize(c.issue === "unknown" ? null : c.issue)}</td>
            <td><Pill tone={outcomeTone(c.outcome)}>{humanize(c.outcome)}</Pill>{c.transferStatus ? <div className="muted">transfer: {c.transferStatus}</div> : null}</td>
            <td className="muted" style={{ maxWidth: 360 }}>{c.summary?.slice(0, 160) ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}
