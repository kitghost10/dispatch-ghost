import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import type { AppContext } from "./context";
import { makeProcessor } from "./jobs";
import { registerAdmin } from "./routes/admin";
import { registerDev } from "./routes/dev";
import { registerMediaStream } from "./routes/mediaStream";
import { registerTwilioSms } from "./routes/twilioSms";
import { registerTwilioVoice } from "./routes/twilioVoice";

export async function buildServer(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: ctx.env.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers[\"x-twilio-signature\"]"] },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });
  ctx.log = app.log;
  ctx.processor ??= makeProcessor(ctx);

  // The dashboard proxies through its own server, but allow its origin for direct browser calls.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && origin === ctx.env.DASHBOARD_ORIGIN) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Headers", "authorization, content-type");
      reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      reply.header("Vary", "Origin");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
  });

  await app.register(formbody);
  await app.register(websocket);
  await registerAdmin(app, ctx);
  await registerTwilioVoice(app, ctx);
  await registerTwilioSms(app, ctx);
  await registerMediaStream(app, ctx);
  await registerDev(app, ctx);
  return app;
}
