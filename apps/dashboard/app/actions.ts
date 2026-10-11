"use server";

import type { AgencySettings } from "../../../packages/core/src/tenant/config";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, ApiError, API_URL, TOKEN_COOKIE } from "@/lib/api";

export async function loginAction(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: String(form.get("email") ?? ""), password: String(form.get("password") ?? "") }),
    cache: "no-store",
  }).catch(() => null);
  if (!res) return { error: `Cannot reach the API at ${API_URL}` };
  if (!res.ok) return { error: "Invalid email or password" };
  const { token } = (await res.json()) as { token: string };
  (await cookies()).set(TOKEN_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 12 * 3600 });
  redirect("/tenants");
}

export async function logoutAction() {
  (await cookies()).delete(TOKEN_COOKIE);
  redirect("/login");
}

export async function completeCallbackAction(tenantId: string, callbackId: string) {
  await api(`/api/tenants/${tenantId}/callbacks/${callbackId}/complete`, { method: "POST", body: {} });
  revalidatePath(`/t/${tenantId}/callbacks`);
}

export async function saveConfigAction(tenantId: string, json: string): Promise<{ ok: boolean; message: string; config?: string }> {
  let config: unknown;
  try {
    config = JSON.parse(json);
  } catch (err) {
    return { ok: false, message: `Invalid JSON: ${(err as Error).message}` };
  }
  try {
    const updated = await api<{ config: unknown }>(`/api/tenants/${tenantId}/config`, { method: "PUT", body: { config } });
    revalidatePath(`/t/${tenantId}`, "layout");
    return { ok: true, message: "Saved. New calls use these settings immediately.", config: JSON.stringify(updated.config) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 400) {
      const issues = (err.body as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues ?? [];
      return { ok: false, message: issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") || "Invalid config" };
    }
    return { ok: false, message: "Save failed" };
  }
}

export async function createTenantAction(json: string): Promise<{ ok: boolean; message: string; id?: string }> {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch (err) {
    return { ok: false, message: `Invalid JSON: ${(err as Error).message}` };
  }
  try {
    const t = await api<{ id: string }>("/api/tenants", { method: "POST", body });
    revalidatePath("/tenants");
    return { ok: true, message: "Created", id: t.id };
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string; issues?: Array<{ path: Array<string | number>; message: string }> };
      return { ok: false, message: body.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n") || (body.error === "number_in_use" ? "This phone number already belongs to another client." : body.error === "slug_taken" ? "A client with this name already exists." : "Check the client details and phone numbers, then try again.") };
    }
    return { ok: false, message: "Create failed" };
  }
}

export interface SimTurn {
  callId: string;
  say: string;
  actions: Array<{ type: string; reason: string; numbers?: string[] }>;
  priority: string;
  issue: string;
  safetyFlags: string[];
  reasonCodes: string[];
  outcome: string;
  ended: boolean;
  afterHours: boolean;
}

export async function simulateAction(tenantId: string, input: { callId?: string; text?: string; afterHours?: boolean; transferResult?: "connected" | "failed" }): Promise<SimTurn> {
  return api<SimTurn>(`/api/tenants/${tenantId}/simulate`, { method: "POST", body: input });
}

export async function setStatusAction(tenantId: string, form: FormData) {
  await api(`/api/tenants/${tenantId}/status`, { method: "PUT", body: { status: String(form.get("status")) } });
  revalidatePath(`/t/${tenantId}`, "layout");
}

export async function loadOpenRouterModelsAction(): Promise<{ models: Array<{ id: string; name: string }>; error?: string }> {
  try { return { models: await api<Array<{ id: string; name: string }>>("/api/models/openrouter") }; }
  catch { return { models: [], error: "Could not load models. You can enter a model ID manually." }; }
}

export async function addPhoneNumberAction(tenantId: string, number: string): Promise<{ ok: boolean; message: string }> {
  try {
    await api(`/api/tenants/${tenantId}/numbers`, { method: "POST", body: { number } });
    revalidatePath(`/t/${tenantId}`, "layout");
    return { ok: true, message: "Phone number assigned. Configure its webhooks in Twilio." };
  } catch (err) {
    const code = err instanceof ApiError ? (err.body as { error?: string }).error : "";
    return { ok: false, message: code === "number_in_use" ? "That number belongs to another client." : code === "agency_admin_only" ? "Ask your agency admin to assign this number." : "Enter a valid US phone number, including +1 and 10 digits." };
  }
}

export async function applyAgencySettingsAction(settings: AgencySettings): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await api<{ updatedAccounts: number }>("/api/agency/settings", { method: "PUT", body: { settings } });
    revalidatePath("/", "layout");
    return { ok: true, message: `Applied to ${result.updatedAccounts} account${result.updatedAccounts === 1 ? "" : "s"}. New clients will use these defaults too.` };
  } catch (err) {
    const body = err instanceof ApiError ? err.body as { issues?: Array<{ path: Array<string | number>; message: string }> } : null;
    return { ok: false, message: body?.issues?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n") || "Could not apply settings. Check your selections and try again." };
  }
}
