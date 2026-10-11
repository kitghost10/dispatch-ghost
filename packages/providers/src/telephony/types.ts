export interface SendSmsInput {
  from: string;
  to: string;
  body: string;
  statusCallback?: string;
}

export interface SendSmsResult {
  sid: string;
  status: string;
}

export interface Telephony {
  readonly kind: "twilio" | "mock";
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  /** Replace a live call's TwiML (used to transfer or hang up a streaming call). */
  updateLiveCall(input: { callSid: string; twiml: string }): Promise<void>;
  /** Start dual-channel call recording (used when the tenant enables recording). */
  startRecording(input: { callSid: string; statusCallback?: string }): Promise<void>;
  /** Validate X-Twilio-Signature. Mock mode accepts everything. */
  validateSignature(input: { url: string; params: Record<string, string>; signature: string | undefined }): boolean;
}
