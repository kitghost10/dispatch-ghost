import { api } from "@/lib/api";
import { WorkspaceShell } from "./WorkspaceShell";
export async function AgencyShell({ children, tenant }: { children: React.ReactNode; tenant?: { id: string; name: string } }) {
  const [clients, setup] = await Promise.all([api<Array<{ id: string; name: string }>>("/api/tenants"), api<{ mode: string }>("/api/setup")]);
  return <WorkspaceShell tenant={tenant} clients={clients} mode={setup.mode}>{children}</WorkspaceShell>;
}
