import { createTenantFromTemplate, DEMO_ANSWERS, type TenantConfig } from "@sb/core";
import { hashPassword } from "./password";
import type { Store, Tenant, User } from "./types";

export const DEMO_BUSINESS_NUMBER = "+15125550199";

export interface SeedResult {
  tenant: Tenant;
  admin: User;
  owner: User;
}

/** Idempotent demo seed: agency admin, one plumber tenant, its number and owner login. */
export async function seedDemo(store: Store, opts: { adminEmail?: string; adminPassword: string; ownerPassword?: string; config?: TenantConfig }): Promise<SeedResult> {
  const adminEmail = (opts.adminEmail ?? "admin@sonicbold.test").toLowerCase();
  const admin = (await store.findUserByEmail(adminEmail)) ?? (await store.createUser({ email: adminEmail, passwordHash: await hashPassword(opts.adminPassword), isAgencyAdmin: true }));
  let tenant = (await store.listTenants()).find((t) => t.slug === "lone-star-plumbing");
  if (!tenant) {
    const config = opts.config ?? createTenantFromTemplate(DEMO_ANSWERS);
    tenant = await store.createTenant({ slug: "lone-star-plumbing", name: config.brand.companyName, config });
  }
  await store.addPhoneNumber(tenant.id, DEMO_BUSINESS_NUMBER);
  const ownerEmail = "owner@lonestar.test";
  const owner = (await store.findUserByEmail(ownerEmail)) ?? (await store.createUser({ email: ownerEmail, passwordHash: await hashPassword(opts.ownerPassword ?? opts.adminPassword) }));
  await store.addMembership({ userId: owner.id, tenantId: tenant.id, role: "owner" });
  return { tenant, admin, owner };
}
