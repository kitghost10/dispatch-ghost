/**
 * Twilio over plain REST (fetch), no SDK. Signature validation ported from
 * LobbyStack apps/voice-gateway/src/telephony/twilioRequest.ts (MIT).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SendSmsInput, SendSmsResult, Telephony } from "./types";

export class TwilioApiError extends Error {
  constructor(readonly status: number, body: string) {
    super(`Twilio API ${status}: ${body.slice(0, 300)}`);
    this.name = "TwilioApiError";
  }
}

export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const payload = url + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha1", authToken).update(payload, "utf8").digest("base64");
}

export function validateTwilioSignature(authToken: string | undefined, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const provided = Buffer.from(signature);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export class TwilioTelephony implements Telephony {
  readonly kind = "twilio" as const;
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly opts: { messagingServiceSid?: string; baseUrl?: string } = {},
  ) {}

  private get base() {
    return `${this.opts.baseUrl ?? "https://api.twilio.com"}/2010-04-01/Accounts/${this.accountSid}`;
  }

  private async post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    });
    const text = await res.text();
    if (!res.ok) throw new TwilioApiError(res.status, text);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    const form: Record<string, string> = { To: input.to, Body: input.body };
    // Always send from the tenant's own number (white-label). If a Messaging Service is configured,
    // pass it too: Twilio then applies the service's A2P 10DLC campaign/opt-out handling while
    // keeping this exact From number (it must belong to the service's sender pool).
    form.From = input.from;
    if (this.opts.messagingServiceSid) form.MessagingServiceSid = this.opts.messagingServiceSid;
    if (input.statusCallback) form.StatusCallback = input.statusCallback;
    const json = await this.post("/Messages.json", form);
    return { sid: String(json.sid), status: String(json.status) };
  }

  async updateLiveCall(input: { callSid: string; twiml: string }): Promise<void> {
    await this.post(`/Calls/${encodeURIComponent(input.callSid)}.json`, { Twiml: input.twiml });
  }

  async startRecording(input: { callSid: string; statusCallback?: string }): Promise<void> {
    const form: Record<string, string> = { RecordingChannels: "dual" };
    if (input.statusCallback) form.RecordingStatusCallback = input.statusCallback;
    await this.post(`/Calls/${encodeURIComponent(input.callSid)}/Recordings.json`, form);
  }

  validateSignature(input: { url: string; params: Record<string, string>; signature: string | undefined }): boolean {
    return validateTwilioSignature(this.authToken, input.url, input.params, input.signature);
  }
}
