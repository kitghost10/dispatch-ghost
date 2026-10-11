import type { FastifyInstance } from "fastify";
import { MockTelephony } from "@sb/providers";
import { DEMO_BUSINESS_NUMBER } from "@sb/db";
import type { AppContext } from "../context";

/** Mock-mode helpers: fake a missed call and inspect what would have been sent. */
export async function registerDev(app: FastifyInstance, ctx: AppContext) {
  if (ctx.env.APP_MODE !== "mock") return;

  app.post("/dev/missed-call", async (req) => {
    const body = (req.body ?? {}) as { from?: string; to?: string };
    const to = body.to ?? DEMO_BUSINESS_NUMBER;
    const from = body.from ?? "+15125550177";
    const sid = `CAdev${Date.now()}`;
    const res = await app.inject({ method: "POST", url: "/twilio/voice/status", payload: new URLSearchParams({ CallSid: sid, From: from, To: to, CallStatus: "no-answer", CallDuration: "0" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    return { ok: res.statusCode < 300, callSid: sid };
  });

  app.post("/dev/inbound-sms", async (req) => {
    const body = (req.body ?? {}) as { from?: string; to?: string; text?: string };
    await app.inject({
      method: "POST",
      url: "/twilio/sms/incoming",
      payload: new URLSearchParams({ From: body.from ?? "+15125550177", To: body.to ?? DEMO_BUSINESS_NUMBER, Body: body.text ?? "", MessageSid: `SMdev${Date.now()}` }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    return { ok: true };
  });

  app.get("/dev/outbox", async () => {
    const t = ctx.telephony;
    return t instanceof MockTelephony ? { sms: t.sms, liveCallUpdates: t.liveCallUpdates } : { sms: [], liveCallUpdates: [] };
  });
}
