import {
  findSlots,
  ReceptionistSession,
  ScriptedReceptionist,
  type BookingRequest,
  type CallbackTaskInput,
  type OnCallAlert,
  type SessionEvent,
  type TenantConfig,
  type Channel,
  type AgentTurn,
} from "../src";

export function harness(config: TenantConfig, now: Date, channel: Channel = "voice") {
  const alerts: OnCallAlert[] = [];
  const callbacks: CallbackTaskInput[] = [];
  const bookings: BookingRequest[] = [];
  const sms: Array<{ to: string; body: string }> = [];
  const events: SessionEvent[] = [];
  const session = new ReceptionistSession(
    {
      config,
      now: () => now,
      scheduler: {
        async findSlots({ serviceKey, priority, limit }) {
          const service = config.services.find((s) => s.key === serviceKey)!;
          return findSlots({ config, service, now, busy: [], priority, ...(limit ? { limit } : {}) });
        },
        async book(req) {
          bookings.push(req);
          return { ok: true, bookingId: `bk_${bookings.length}` };
        },
      },
      effects: {
        async alertOnCall(a) { alerts.push(a); },
        async createCallback(t) { callbacks.push(t); },
        async sendConfirmationSms(m) { sms.push(m); },
        event(e) { events.push(e); },
      },
    },
    { channel, callerPhone: "+15125559876" },
  );
  const agent = new ScriptedReceptionist(session);
  const transcript: Array<{ role: "caller" | "agent"; text: string }> = [{ role: "agent", text: agent.greeting() }];
  const turns: AgentTurn[] = [];
  async function say(text: string) {
    transcript.push({ role: "caller", text });
    const turn = await agent.respond(text);
    turns.push(turn);
    transcript.push({ role: "agent", text: turn.say });
    return turn;
  }
  return { session, agent, say, alerts, callbacks, bookings, sms, events, transcript, turns };
}
