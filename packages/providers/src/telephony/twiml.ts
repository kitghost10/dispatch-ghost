/** Minimal TwiML builders (no SDK). Escaping ported from LobbyStack's voice gateway (MIT). */
export function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export function say(text: string, voice = "Polly.Joanna-Neural"): string {
  return `<Say voice="${escapeXml(voice)}">${escapeXml(text)}</Say>`;
}

/** Recording notice + bidirectional Media Stream to the gateway. */
export function connectStreamTwiml(input: { preamble?: string; streamUrl: string; parameters: Record<string, string>; statusCallback?: string }): string {
  const params = Object.entries(input.parameters)
    .map(([k, v]) => `<Parameter name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
    .join("");
  const status = input.statusCallback ? ` statusCallback="${escapeXml(input.statusCallback)}" statusCallbackMethod="POST"` : "";
  return twiml(`${input.preamble ? say(input.preamble) : ""}<Connect><Stream url="${escapeXml(input.streamUrl)}"${status}>${params}</Stream></Connect>`);
}

/**
 * Transfer: dial the on-call rota in order (sequential <Number>s are tried
 * simultaneously by Twilio, so we dial one number per <Dial> and chain through
 * the action callback). `action` receives DialCallStatus to detect failure.
 */
export function dialTwiml(input: { sayFirst?: string; number: string; callerId?: string; timeoutSec: number; action: string; record?: boolean; whisperUrl?: string }): string {
  const callerId = input.callerId ? ` callerId="${escapeXml(input.callerId)}"` : "";
  const record = input.record ? ` record="record-from-answer-dual"` : "";
  // The whisper plays to the plumber before bridging ("Emergency from AI receptionist: burst pipe...").
  const whisper = input.whisperUrl ? ` url="${escapeXml(input.whisperUrl)}" method="POST"` : "";
  return twiml(
    `${input.sayFirst ? say(input.sayFirst) : ""}<Dial timeout="${input.timeoutSec}" action="${escapeXml(input.action)}" method="POST"${callerId}${record}><Number${whisper}>${escapeXml(input.number)}</Number></Dial>`,
  );
}

export function sayHangupTwiml(text?: string): string {
  return twiml(`${text ? say(text) : ""}<Hangup/>`);
}

export function emptyTwiml(): string {
  return twiml("");
}
