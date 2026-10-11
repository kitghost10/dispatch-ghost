import type { FastifyInstance } from "fastify";
import { emptyTwiml } from "@sb/providers";
import type { AppContext } from "../context";
import { handleInboundSms } from "../services/smsInbound";
import { twilioGuard } from "./twilioVoice";

type Form = Record<string, string>;

export async function registerTwilioSms(app: FastifyInstance, ctx: AppContext) {
  const guard = twilioGuard(ctx);

  app.post("/twilio/sms/incoming", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    const tenantId = await ctx.store.resolveTenantByNumber(f.To ?? "");
    if (tenantId && f.From && typeof f.Body === "string") {
      // Reply asynchronously via the REST API (keeps webhook fast and lets consent checks apply).
      await handleInboundSms(ctx, {
        tenantId,
        from: f.From,
        to: f.To ?? "",
        body: f.Body,
        ...(f.OptOutType ? { optOutType: f.OptOutType } : {}),
        ...(f.MessageSid ? { messageSid: f.MessageSid } : {}),
      });
    }
    return reply.header("Content-Type", "text/xml").send(emptyTwiml());
  });

  app.post("/twilio/sms/status", { preHandler: guard }, async (req, reply) => {
    const f = req.body as Form;
    const q = req.query as Record<string, string>;
    if (q.tenantId && q.id && f.MessageStatus) {
      await ctx.store.updateSmsStatus(q.tenantId, q.id, f.MessageStatus, f.MessageSid ?? null);
      // 21610 = recipient replied STOP at the carrier level: honour it.
      if (f.ErrorCode === "21610" && f.To) await ctx.store.setConsent(q.tenantId, f.To, "opted_out", "carrier_21610");
    }
    return reply.code(204).send();
  });
}
