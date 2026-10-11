import type { SendSmsInput, SendSmsResult, Telephony } from "./types";

/** Records everything instead of calling Twilio. Used in mock mode and tests. */
export class MockTelephony implements Telephony {
  readonly kind = "mock" as const;
  readonly sms: Array<SendSmsInput & { sid: string; at: string }> = [];
  readonly liveCallUpdates: Array<{ callSid: string; twiml: string }> = [];
  failSmsTo = new Set<string>();
  private n = 0;

  async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
    if (this.failSmsTo.has(input.to)) throw new Error(`mock SMS failure to ${input.to}`);
    const sid = `SMmock${String(++this.n).padStart(6, "0")}`;
    this.sms.push({ ...input, sid, at: new Date().toISOString() });
    return { sid, status: "sent" };
  }

  async updateLiveCall(input: { callSid: string; twiml: string }): Promise<void> {
    this.liveCallUpdates.push(input);
  }

  readonly recordings: string[] = [];
  async startRecording(input: { callSid: string }): Promise<void> {
    this.recordings.push(input.callSid);
  }

  validateSignature(): boolean {
    return true;
  }
}
