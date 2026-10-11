/**
 * Plays the part of Twilio for a phone call: posts the incoming-call webhook,
 * opens the Media Stream WebSocket the returned TwiML points at, sends caller
 * "audio" (mock-encoded text) and echoes playback marks, exactly like Twilio.
 * Used by the scenario suite, demo seeding and the `simulate` CLI.
 */
import WebSocket from "ws";
import { decodeMockAudio, encodeMockAudio } from "@sb/providers";

export function unescapeXml(s: string): string {
  return s.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

export function parseStreamTwiml(xml: string): { url: string; params: Record<string, string>; preamble: string | null } | null {
  const url = /<Stream url="([^"]+)"/.exec(xml)?.[1];
  if (!url) return null;
  const params: Record<string, string> = {};
  for (const m of xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)) params[unescapeXml(m[1]!)] = unescapeXml(m[2]!);
  const preamble = /^<\?xml[^>]*\?><Response><Say[^>]*>([^<]*)<\/Say><Connect>/.exec(xml)?.[1];
  return { url: unescapeXml(url), params, preamble: preamble ? unescapeXml(preamble) : null };
}

export function parseDial(xml: string): { action: string; number: string; say: string | null } | null {
  const action = /<Dial [^>]*action="([^"]+)"/.exec(xml)?.[1];
  const number = /<Number[^>]*>([^<]+)<\/Number>/.exec(xml)?.[1];
  if (!action || !number) return null;
  const say = /<Say[^>]*>([^<]*)<\/Say><Dial/.exec(xml)?.[1];
  return { action: unescapeXml(action), number, say: say ? unescapeXml(say) : null };
}

export function parseSay(xml: string): string[] {
  return [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => unescapeXml(m[1]!));
}

export async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: res.status, text: await res.text() };
}

export interface CallDriverOptions {
  baseUrl: string;
  from: string;
  to: string;
  callSid?: string;
  /** Silence window that ends an agent turn. */
  quietMs?: number;
}

export class CallDriver {
  readonly callSid: string;
  readonly agent: string[] = [];
  readonly transcript: Array<{ role: "caller" | "agent"; text: string }> = [];
  preamble: string | null = null;
  callId = "";
  tenantId = "";
  private ws: WebSocket | null = null;
  private waiters: Array<() => void> = [];
  private lastActivity = Date.now();
  private closed = false;

  constructor(private readonly opts: CallDriverOptions) {
    this.callSid = opts.callSid ?? `CA${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`;
  }

  /** Returns the greeting. */
  async start(): Promise<string> {
    const res = await postForm(`${this.opts.baseUrl}/twilio/voice/incoming`, { CallSid: this.callSid, From: this.opts.from, To: this.opts.to, CallStatus: "ringing", Direction: "inbound" });
    const stream = parseStreamTwiml(res.text);
    if (!stream) throw new Error(`incoming call did not return a stream: ${res.text}`);
    this.preamble = stream.preamble;
    this.callId = stream.params.callId ?? "";
    this.tenantId = stream.params.tenantId ?? "";
    const ws = new WebSocket(stream.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (raw) => this.onFrame(JSON.parse(raw.toString()) as { event: string; media?: { payload: string }; mark?: { name: string } }));
    ws.on("close", () => {
      this.closed = true;
      this.wake();
    });
    const streamSid = `MZ${this.callSid.slice(2)}`;
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ws.send(JSON.stringify({ event: "start", sequenceNumber: "1", start: { streamSid, accountSid: "ACmock", callSid: this.callSid, tracks: ["inbound"], customParameters: stream.params, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } }, streamSid }));
    const lines = await this.collect();
    return lines.join(" ");
  }

  private onFrame(frame: { event: string; media?: { payload: string }; mark?: { name: string } }) {
    this.lastActivity = Date.now();
    if (frame.event === "media" && frame.media) {
      const text = decodeMockAudio(frame.media.payload);
      if (text) {
        this.agent.push(text);
        this.transcript.push({ role: "agent", text });
      }
    } else if (frame.event === "mark" && frame.mark) {
      // Twilio echoes a mark once the audio before it has finished playing.
      this.ws?.send(JSON.stringify({ event: "mark", streamSid: "x", mark: { name: frame.mark.name } }));
    }
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  /** Wait until the agent speaks and then goes quiet (or timeout with nothing). */
  private async collect(timeoutMs = 1500): Promise<string[]> {
    const startCount = this.agent.length;
    const quiet = this.opts.quietMs ?? 120;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const got = this.agent.length > startCount;
      if (got && Date.now() - this.lastActivity >= quiet) break;
      if (this.closed || Date.now() > deadline) break;
      await new Promise<void>((r) => {
        const t = setTimeout(r, got ? quiet : 50);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return this.agent.slice(startCount);
  }

  /** Caller says something; returns what the agent said back. */
  async say(text: string): Promise<string> {
    if (!this.ws || this.closed) throw new Error("stream closed");
    this.transcript.push({ role: "caller", text });
    this.ws.send(JSON.stringify({ event: "media", streamSid: "x", media: { track: "inbound", chunk: "1", timestamp: "0", payload: encodeMockAudio(text) } }));
    return (await this.collect()).join(" ");
  }

  /** Twilio ends the stream (because the call was redirected to <Dial> or hung up). */
  async stopStream(): Promise<void> {
    if (!this.ws || this.closed) return;
    this.ws.send(JSON.stringify({ event: "stop", streamSid: "x", stop: { callSid: this.callSid } }));
    this.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }

  /** Dial action callback (transfer leg finished). Returns TwiML. */
  async dialResult(actionUrl: string, dialCallStatus: "completed" | "no-answer" | "busy" | "failed"): Promise<string> {
    const url = actionUrl.startsWith("http") ? actionUrl : `${this.opts.baseUrl}${actionUrl}`;
    const res = await postForm(url, { CallSid: this.callSid, DialCallStatus: dialCallStatus, From: this.opts.from, To: this.opts.to });
    return res.text;
  }

  /** Final call status callback. */
  async end(status = "completed", durationSec = 60): Promise<void> {
    await this.stopStream();
    await postForm(`${this.opts.baseUrl}/twilio/voice/status`, { CallSid: this.callSid, From: this.opts.from, To: this.opts.to, CallStatus: status, CallDuration: String(durationSec) });
  }
}

/** Missed call: Twilio never connects a stream; only the status callback arrives. */
export async function missedCall(baseUrl: string, from: string, to: string, status: "no-answer" | "busy" | "completed" = "no-answer"): Promise<string> {
  const callSid = `CA${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`;
  await postForm(`${baseUrl}/twilio/voice/status`, { CallSid: callSid, From: from, To: to, CallStatus: status, CallDuration: "0" });
  return callSid;
}

export async function inboundSms(baseUrl: string, from: string, to: string, body: string, extra: Record<string, string> = {}): Promise<void> {
  await postForm(`${baseUrl}/twilio/sms/incoming`, { MessageSid: `SM${Date.now()}${Math.floor(Math.random() * 1e6)}`, From: from, To: to, Body: body, ...extra });
}
