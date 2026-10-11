import type { Priority } from "@/lib/types";

const LABEL: Record<Priority, string> = { P0: "Life safety", P1: "Urgent", P2: "Same-day", P3: "Routine" };

export function PriorityBadge({ p }: { p: Priority | null }) {
  if (!p) return <span className="badge muted">—</span>;
  return <span className={`badge ${p.toLowerCase()}`} title={p}>{LABEL[p]}</span>;
}

export function Pill({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "ok" | "warn" | "bad" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}
