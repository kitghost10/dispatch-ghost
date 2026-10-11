import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store, User } from "@sb/db";

function b64url(buf: Buffer | string) {
  return Buffer.from(buf).toString("base64url");
}

export function sign(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function verifySig(secret: string, value: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const a = Buffer.from(sign(secret, value));
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueToken(secret: string, userId: string, ttlSec = 12 * 3600, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Math.floor(now / 1000) + ttlSec }));
  return `${payload}.${sign(secret, payload)}`;
}

export function readToken(secret: string, token: string | undefined, now = Date.now()): { uid: string } | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !verifySig(secret, payload, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { uid: string; exp: number };
    if (data.exp * 1000 < now) return null;
    return { uid: data.uid };
  } catch {
    return null;
  }
}

export interface AuthedRequest extends FastifyRequest {
  user?: User;
}

export function authGuard(store: Store, secret: string) {
  return async (req: AuthedRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const claims = readToken(secret, token);
    if (!claims) return reply.code(401).send({ error: "unauthorized" });
    const user = await store.getUser(claims.uid);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    req.user = user;
  };
}

export async function canAccessTenant(store: Store, user: User, tenantId: string): Promise<boolean> {
  if (user.isAgencyAdmin) return true;
  return (await store.listMemberships(user.id)).some((m) => m.tenantId === tenantId);
}
