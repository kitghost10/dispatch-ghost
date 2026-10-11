import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { buildInstructions, executeTool, findUnapprovedPrices, localNow, RECEPTIONIST_TOOLS, ScriptedReceptionist, type ReceptionistSession, type RuntimeAction } from "@sb/core";
import { sayHangupTwiml, type VoiceSession } from "@sb/providers";

import type { Tenant } from "@sb/db";
import type { AppContext } from "../context";
import { verifySig } from "../auth";
import { newSession } from "../services/conversations";
import { tenantVoice } from "../services/providers";
import { persistSession } from "../services/persist";
import { signedQuery, transferDialTwiml } from "../services/transfer";

/** How long to wait for Twilio's mark echo (end of playback) before acting anyway. */
const MARK_FALLBACK_MS = 8_000;

interface TwilioFrame {
  event: "connected" | "start" | "media" | "mark" | "stop" | "dtmf";
  start?: { streamSid: string; callSid: string; customParameters?: Record<string, string> };
  media?: { payload: string; track?: string };
  mark?: { name: string };
}

/**
 * Bridges a Twilio Media Stream to the VoiceProvider and enforces the
 * deterministic plumbing rules on every caller utterance:
 *  - llm driver: the model converses via tools; any P0 safety flag in the
 *    caller transcript interrupts the model and speaks the fixed script.
 *  - scripted driver (mock): the ScriptedReceptionist decides every reply.
 * Transfers/hangups run after the current reply finishes playing.
 */
export class LiveCall {
  private voice: VoiceSession | null = null;
  private pending: RuntimeAction[] = [];
  private markSeq = 0;
  private awaitingMark: string | null = null;
  private markTimer: NodeJS.Timeout | null = null;
  private work: Promise<void> = Promise.resolve();
  private finished = false;
  private recovering = false;
  private actionsDone = false;
  private streamSid = "";
  private callSid = "";
  private scripted: ScriptedReceptionist | null = null;
  private session!: ReceptionistSession;
  private effects!: { flush(): Promise<void> };

  constructor(
    private readonly ctx: AppContext,
    private readonly socket: WebSocket,
    private readonly tenant: Tenant,
    private readonly callId: string,
    private readonly callerE164: string,
  ) {}

  async start(streamSid: string, callSid: string, afterHours: boolean) {
    const { ctx, tenant } = this;
    this.streamSid = streamSid;
    this.callSid = callSid;
    const created = newSession(ctx, tenant, this.callId, { channel: "voice", callerPhone: this.callerE164 });
    this.session = created.session;
    this.effects = created.effects;
    this.session.state.afterHours = afterHours;
    try {
      const provider = tenantVoice(ctx, tenant.config);
      const driver = provider.driver;
      this.scripted = driver === "scripted" ? new ScriptedReceptionist(this.session) : null;
      const greeting = new ScriptedReceptionist(this.session).greeting();
      await ctx.store.appendEvent(tenant.id, this.callId, "call.stream_started", { provider: provider.name, driver });

      if (tenant.config.recording.enabled && callSid) {
        ctx.telephony
          .startRecording({ callSid, statusCallback: `${ctx.env.PUBLIC_BASE_URL}/twilio/voice/recording?${signedQuery(ctx, tenant.id, this.callId)}` })
          .catch((err) => ctx.log.warn({ err }, "failed to start recording"));
      }

      const localLabel = localNow(tenant.config, ctx.now()).toFormat("cccc, LLLL d, h:mm a");
      this.voice = await provider.connect({
        instructions: buildInstructions(tenant.config, { channel: "voice", afterHours, localTimeLabel: localLabel }),
        tools: RECEPTIONIST_TOOLS,
        filterReply: (text) => {
          if (this.session.isLockedForSafety) return "Please follow the emergency instructions and contact emergency services. We cannot book this call.";
          return findUnapprovedPrices(text, tenant.config).length ? "I can't quote repair prices. The technician will provide an exact price before work starts." : text;
        },
        greeting,
        handlers: {
          onAudio: (payload) => this.send({ event: "media", streamSid: this.streamSid, media: { payload } }),
          onInterrupt: () => this.send({ event: "clear", streamSid: this.streamSid }),
          onCallerTranscript: (text) => this.enqueue(() => this.onCaller(text)),
          onAgentTranscript: (text) => this.enqueue(() => this.onAgent(text)),
          onToolCall: (name, args) => this.onTool(name, args),
          onResponseDone: () => this.onResponseDone(),
          onError: (err) => this.providerFailed(err),
          onClose: () => this.providerFailed(new Error("Voice provider disconnected")),
        },
      });
    } catch (err) {
      ctx.log.error({ err, callId: this.callId }, "voice provider unavailable; falling back to human transfer");
      await this.fallbackToHuman("voice_provider_unavailable");
    }
  }

  private providerFailed(err: Error) {
    if (this.finished || this.actionsDone || this.recovering) return;
    this.ctx.log.error({ err, callId: this.callId }, "voice provider error");
    this.recovering = true;
    this.enqueue(() => this.fallbackToHuman("voice_provider_failed"));
  }

  private send(frame: Record<string, unknown>) {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private enqueue(fn: () => Promise<void>) {
    this.work = this.work.then(fn).catch((err) => this.ctx.log.error({ err, callId: this.callId }, "live call handler failed"));
    return this.work;
  }

  private async onCaller(text: string) {
    const { ctx, tenant } = this;
    await ctx.store.appendTranscript(tenant.id, this.callId, "caller", text);
    if (this.session.state.ended) return;
    if (this.scripted) {
      const turn = await this.scripted.respond(text);
      this.pending.push(...turn.actions);
      await persistSession(ctx, tenant.id, this.callId, this.session);
      if (turn.say) this.voice?.say(turn.say);
      else if (this.pending.length) await this.runActions();
      return;
    }
    // LLM driver: deterministic safety net on every caller utterance.
    const obs = this.session.observeCaller(text);
    if ((obs.becameP0 || obs.triage.priority === "P0") && !this.session.state.safetyScriptGiven) {
      const turn = await this.session.handleLifeSafety();
      this.pending.push(...turn.actions);
      await persistSession(ctx, tenant.id, this.callId, this.session);
      this.voice?.say(turn.say, { interrupt: true });
      return;
    }
    await persistSession(ctx, tenant.id, this.callId, this.session);
  }

  private async onAgent(text: string) {
    const { ctx, tenant } = this;
    await ctx.store.appendTranscript(tenant.id, this.callId, "agent", text);
    const violations = findUnapprovedPrices(text, tenant.config);
    if (violations.length) {
      // Audio already played; record for QA and correct on the next turn.
      await ctx.store.appendEvent(tenant.id, this.callId, "guard.price_violation", { violations, text });
      if (!this.scripted) this.voice?.say("Just to be clear, I can't quote repair prices. The technician gives you an exact price on site before any work starts.");
    }
  }

  private async onTool(name: string, args: unknown): Promise<Record<string, unknown>> {
    const { ctx, tenant } = this;
    const exec = await executeTool(this.session, name, args);
    if (exec.action) this.pending.push(exec.action);
    await ctx.store.appendEvent(tenant.id, this.callId, "tool.call", { name, args, output: exec.output });
    await persistSession(ctx, tenant.id, this.callId, this.session);
    return exec.output;
  }

  private onResponseDone() {
    if (!this.pending.length || this.actionsDone) return;
    const name = `r${++this.markSeq}`;
    this.awaitingMark = name;
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
    if (this.markTimer) clearTimeout(this.markTimer);
    this.markTimer = setTimeout(() => this.enqueue(() => this.runActions()), MARK_FALLBACK_MS);
  }

  audio(payload: string) {
    this.voice?.sendAudio(payload);
  }

  onMark(name: string) {
    if (this.awaitingMark && name === this.awaitingMark) {
      this.awaitingMark = null;
      if (this.markTimer) clearTimeout(this.markTimer);
      this.enqueue(() => this.runActions());
    }
  }

  private async runActions() {
    if (this.actionsDone || !this.pending.length) return;
    this.actionsDone = true;
    const { ctx, tenant } = this;
    const action = this.pending.find((a) => a.type === "transfer") ?? this.pending[0]!;
    this.pending = [];
    try {
      if (action.type === "transfer") {
        await ctx.telephony.updateLiveCall({
          callSid: this.callSid,
          twiml: transferDialTwiml(ctx, tenant, { callId: this.callId, callerE164: this.callerE164, numbers: action.numbers, index: 0 }),
        });
      } else {
        await ctx.telephony.updateLiveCall({ callSid: this.callSid, twiml: sayHangupTwiml() });
      }
      await ctx.store.appendEvent(tenant.id, this.callId, `runtime.${action.type}`, { reason: action.reason });
    } catch (err) {
      ctx.log.error({ err, callId: this.callId }, "failed to update live call");
    }
    await persistSession(ctx, tenant.id, this.callId, this.session);
    this.voice?.close();
  }

  /** Voice AI down: never drop a plumbing emergency; ring the humans. */
  private async fallbackToHuman(reason: string) {
    this.voice?.close();
    const target = this.session.transferTargets("auto");
    if (target.numbers.length === 0) {
      await this.session.scheduleCallback(reason, "Voice AI unavailable; caller hung up or was disconnected.");
      await this.ctx.telephony.updateLiveCall({ callSid: this.callSid, twiml: sayHangupTwiml("Sorry, we're having trouble answering. Someone will call you back shortly.") });
      await persistSession(this.ctx, this.tenant.id, this.callId, this.session);
      await this.effects.flush();
      return;
    }
    const action = this.session.requestTransfer("auto", reason);
    if (action.type === "transfer") this.pending.push(action);
    await this.runActions();
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.markTimer) clearTimeout(this.markTimer);
    await this.work;
    this.voice?.close();
    if (!this.session) return;
    await persistSession(this.ctx, this.tenant.id, this.callId, this.session);
    await this.effects.flush();
  }
}

export async function registerMediaStream(app: FastifyInstance, ctx: AppContext) {
  app.get("/twilio/media-stream", { websocket: true }, (socket) => {
    let call: LiveCall | null = null;
    let starting: Promise<void> | null = null;
    socket.on("message", (raw: Buffer) => {
      let frame: TwilioFrame;
      try {
        frame = JSON.parse(raw.toString()) as TwilioFrame;
      } catch {
        return;
      }
      if (frame.event === "start" && frame.start && !starting) {
        starting = (async () => {
          const p = frame.start!.customParameters ?? {};
          const tenantId = p.tenantId ?? "";
          const callId = p.callId ?? "";
          if (!verifySig(ctx.env.SESSION_SECRET, `${tenantId}:${callId}`, p.token)) {
            ctx.log.warn({ callId }, "media stream with bad token");
            socket.close();
            return;
          }
          const tenant = await ctx.store.getTenant(tenantId);
          const record = tenant ? await ctx.store.getCall(tenantId, callId) : null;
          if (!tenant || !record) return void socket.close();
          call = new LiveCall(ctx, socket, tenant, callId, record.fromE164);
          await call.start(frame.start!.streamSid, frame.start!.callSid, record.afterHours);
        })().catch((err) => ctx.log.error({ err }, "media stream start failed"));
        return;
      }
      void (async () => {
        await starting;
        if (!call) return;
        if (frame.event === "media" && frame.media) call.audio(frame.media.payload);
        else if (frame.event === "mark" && frame.mark) call.onMark(frame.mark.name);
        else if (frame.event === "stop") await call.finish();
      })();
    });
    socket.on("close", () => {
      void (async () => {
        await starting;
        await call?.finish();
      })();
    });
  });
}
