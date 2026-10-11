"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { AgencySettings } from "../../../../../packages/core/src/tenant/config";
import { Icon } from "@/components/Icon";
import { createTenantAction } from "@/app/actions";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function splitList(s: string): string[] {
  return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

export function OnboardingForm({ services, agencySettings = {} }: { services: unknown[]; agencySettings?: AgencySettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [f, setF] = useState({
    companyName: "",
    spokenName: "",
    agentName: "Riley",
    website: "",
    primaryColor: "#0B5FFF",
    timezone: "America/Chicago",
    tripFee: "89",
    afterHoursTripFee: "149",
    tripFeeLabel: "service call fee",
    zips: "",
    areaDescription: "",
    open: "08:00",
    close: "17:00",
    saturday: false,
    officeNumber: "",
    onCall: "",
    voiceEnabled: agencySettings.voice?.enabled ?? true,
    smsEnabled: agencySettings.sms?.enabled ?? true,
    voiceProvider: agencySettings.voice?.provider ?? "elevenlabs",
    voiceModel: agencySettings.voice?.model ?? "",
    smsProvider: agencySettings.sms?.provider ?? "agency",
    smsModel: agencySettings.sms?.model ?? "",
    fallbackPhone: "",
    gasUtilityLine: "",
    recording: agencySettings.recording?.enabled ?? true,
    preamble: agencySettings.recording?.preamble ?? "This call may be recorded for quality and training purposes.",
    numbers: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });

  const payload = useMemo(() => {
    const shifts = f.onCall
      .split("\n")
      .map((l) => l.split(",").map((x) => x.trim()))
      .filter(([name, phone]) => name && phone)
      .map(([name, phone], order) => ({ name, phone, days: DAYS, order }));
    const hours: Record<string, Array<{ open: string; close: string }>> = {};
    for (const d of DAYS) hours[d] = ["sat", "sun"].includes(d) && !(d === "sat" && f.saturday) ? [] : [{ open: f.open, close: f.close }];
    return {
      answers: {
        brand: {
          companyName: f.companyName,
          ...(f.spokenName ? { spokenName: f.spokenName } : {}),
          agentName: f.agentName,
          ...(f.website ? { website: f.website } : {}),
          primaryColor: f.primaryColor,
        },
        timezone: f.timezone,
        voice: { enabled: f.voiceEnabled, provider: f.voiceProvider, ...(f.voiceModel ? { model: f.voiceModel.trim() } : {}) },
        sms: { enabled: f.smsEnabled, aiReplies: true, provider: f.smsProvider, ...(f.smsModel ? { model: f.smsModel.trim() } : {}) },
        services,
        pricing: {
          tripFee: Number(f.tripFee),
          tripFeeLabel: f.tripFeeLabel,
          ...(f.afterHoursTripFee ? { afterHoursTripFee: Number(f.afterHoursTripFee) } : {}),
          creditedTowardRepair: true,
          allowStartingAtPrices: false,
        },
        serviceArea: { zips: splitList(f.zips), description: f.areaDescription },
        hours,
        onCall: { enabled: true, shifts, ...(f.fallbackPhone ? { fallbackPhone: f.fallbackPhone } : {}), alwaysAlertOnEmergency: true },
        transfer: { ...(f.officeNumber ? { officeNumber: f.officeNumber } : {}), dialTimeoutSec: 20, emergencyCallbackMinutes: 10 },
        recording: { enabled: f.recording, preamble: f.preamble },
        triage: { vulnerableOccupantUpgradesToP1: false, transferP1DuringHours: false, ...(f.gasUtilityLine ? { gasUtilityLine: f.gasUtilityLine } : {}) },
      },
      phoneNumbers: splitList(f.numbers),
    };
  }, [f, services]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1 && !f.voiceEnabled && !f.smsEnabled) { setResult({ ok: false, message: "Choose Voice calls, SMS replies, or both." }); return; }
    if (step === 2 && f.open >= f.close) { setResult({ ok: false, message: "Closing time must be after opening time." }); return; }
    if (step < 3) { setResult(null); setStep(step + 1); return; }
    if (!f.voiceEnabled && !f.smsEnabled) { setResult({ ok: false, message: "Enable Voice calls or SMS replies to continue." }); setStep(1); return; }
    const invalidRota = f.onCall.split("\n").filter((line) => line.trim()).some((line) => { const [name, phone, extra] = line.split(",").map((v) => v.trim()); return !name || !/^\+1\d{10}$/.test(phone ?? "") || Boolean(extra); });
    if (invalidRota) { setResult({ ok: false, message: "Check each on-call contact: enter Name, +1 followed by 10 digits." }); setStep(2); return; }
    start(async () => {
      const r = await createTenantAction(JSON.stringify(payload));
      setResult(r);
      if (r.ok && r.id) router.push(`/t/${r.id}/settings`);
    });
  };

  return (
    <form onSubmit={submit} className="grid" style={{ gap: 16 }}>
      <nav className="steps" aria-label="Setup progress">{["Business", "Channels", "Phone & routing", "Review"].map((name, index) => <span key={name} aria-current={step === index ? "step" : undefined} className={step === index ? "current" : ""}>{index + 1}. {name}</span>)}</nav>
      {step === 0 && <section className="panel">
        <span className="channel-heading-icon"><Icon name="building"/></span><h2>Meet your new client</h2><p className="muted">Start with the details customers will hear.</p>
        <div className="fieldset"><label>Company name<input required value={f.companyName} onChange={set("companyName")} placeholder="Acme Plumbing & Drain" /></label><label>Receptionist name<input value={f.agentName} onChange={set("agentName")} placeholder="Riley" /></label></div>
        <label>Client timezone<select value={f.timezone} onChange={set("timezone")}>{["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"].map((zone) => <option key={zone} value={zone}>{zone.replace("America/", "").replaceAll("_", " ")}</option>)}</select></label>
        <details className="advanced-details"><summary>Brand details (optional)</summary><div className="fieldset"><label>Spoken company name<input value={f.spokenName} onChange={set("spokenName")} placeholder="Acme Plumbing"/></label><label>Website<input type="url" value={f.website} onChange={set("website")} placeholder="https://"/></label><label>Brand color<input type="color" value={f.primaryColor} onChange={set("primaryColor")}/></label></div></details>
      </section>}
      {step === 0 && <section className="panel"><h2>Fees & service area</h2><p className="muted">Help the receptionist know who to serve and what to say.</p><div className="fieldset"><label>Service call fee ($)<input type="number" min="0" step="0.01" required value={f.tripFee} onChange={set("tripFee")}/></label><label>After-hours fee ($, optional)<input type="number" min="0" step="0.01" value={f.afterHoursTripFee} onChange={set("afterHoursTripFee")}/></label></div><label>Service ZIP codes<textarea aria-label="Service ZIP codes" required rows={2} value={f.zips} onChange={set("zips")} placeholder="33602 33603 33604"/></label><p className="field-hint">Separate ZIP codes with a space or comma.</p><details className="advanced-details"><summary>Customize the fee and area description</summary><div className="fieldset"><label>Fee label<input value={f.tripFeeLabel} onChange={set("tripFeeLabel")}/></label><label>Spoken service area<input value={f.areaDescription} onChange={set("areaDescription")} placeholder="Tampa and nearby areas"/></label></div></details></section>}
      {step === 2 && <section className="panel">
        <h2 style={{ marginTop: 0 }}>Hours, on-call &amp; transfers</h2>
        <div className="fieldset">
          <div><label>Weekday open</label><input type="time" value={f.open} onChange={set("open")} /></div>
          <div><label>Weekday close</label><input type="time" value={f.close} onChange={set("close")} /></div>
          <div><label><input type="checkbox" checked={f.saturday} onChange={set("saturday")} style={{ width: "auto" }} /> Open Saturdays (same hours)</label></div>
          <div><label>Office transfer number (E.164)</label><input value={f.officeNumber} onChange={set("officeNumber")} placeholder="+18135550100" /></div>
          <div><label>Fallback on-call number</label><input value={f.fallbackPhone} onChange={set("fallbackPhone")} placeholder="+18135550199" /></div>
          <div><label>Gas utility line (read in gas emergencies)</label><input value={f.gasUtilityLine} onChange={set("gasUtilityLine")} placeholder="TECO Peoples Gas emergency line" /></div>
        </div>
        <label>On-call rota, in dial order — one per line: &quot;Name, +1XXXXXXXXXX&quot;</label>
        <textarea rows={3} value={f.onCall} onChange={set("onCall")} />
      </section>}
      {step === 2 && <section className="panel">
        <h2 style={{ marginTop: 0 }}>Phone numbers &amp; recording</h2>
        <label>Twilio numbers for this client (E.164, comma separated)</label>
        <input value={f.numbers} onChange={set("numbers")} placeholder="+18135550142" />
        <label><input type="checkbox" checked={f.recording} disabled={Boolean(agencySettings.recording)} onChange={set("recording")} style={{ width: "auto" }} /> Record calls</label>
        <label>Recording notice (spoken before the AI answers)</label>
        <input value={f.preamble} disabled={Boolean(agencySettings.recording)} onChange={set("preamble")} />
      </section>}
      {step === 1 && <section className="panel">
        <span className="eyebrow">Choose what your client needs</span><h2>Two channels. One receptionist.</h2>
        {Object.keys(agencySettings).length ? <p className="notice">This client starts with your admin defaults. Customize shared channels afterward in Client setup.</p> : null}
        <div className="fieldset">
          <fieldset className="settings-fields onboarding-channel" disabled={Boolean(agencySettings.voice)}><span className="channel-heading-icon"><Icon name="phone"/></span><label className="toggle"><input type="checkbox" checked={f.voiceEnabled} onChange={set("voiceEnabled")} /> Voice calls</label><p className="muted">Answer calls, collect details, and book or transfer.</p><label>Voice provider<select value={f.voiceProvider} onChange={set("voiceProvider")}><option value="elevenlabs">ElevenLabs — primary</option><option value="deepgram-openrouter">Deepgram + OpenRouter — testing</option><option value="agency">Use agency default</option><option value="openai-realtime">OpenAI Realtime</option></select></label>{f.voiceProvider === "deepgram-openrouter" ? <label>OpenRouter reply model<input value={f.voiceModel} onChange={set("voiceModel")} placeholder="Choose model, e.g. openai/gpt-4.1-mini" /></label> : <p className="muted">Uses your agency’s voice settings. Customize each client in Client setup.</p>}</fieldset>
          <fieldset className="settings-fields onboarding-channel" disabled={Boolean(agencySettings.sms)}><span className="channel-heading-icon sms-icon"><Icon name="message"/></span><label className="toggle"><input type="checkbox" checked={f.smsEnabled} onChange={set("smsEnabled")} /> SMS replies</label><p className="muted">Reply to texts and follow up on missed calls.</p><label>Reply provider<select value={f.smsProvider} onChange={set("smsProvider")}><option value="agency">Agency default</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter — testing</option></select></label><label>Reply model<input value={f.smsModel} onChange={set("smsModel")} placeholder="Choose a model or leave blank for agency default" /></label></fieldset>
        </div>
      </section>}
      {step === 3 && <section className="panel"><span className="eyebrow">Ready to create</span><h2>{f.companyName}</h2><p className="muted">Create the client workspace, then connect providers and test the receptionist.</p><div className="check-item">Voice: {f.voiceEnabled ? ({ elevenlabs: "ElevenLabs (primary)", "deepgram-openrouter": "Deepgram + OpenRouter (testing)", "openai-realtime": "OpenAI Realtime", agency: "Agency default" } as Record<string, string>)[f.voiceProvider] : "Off"}</div><div className="check-item">SMS replies: {f.smsEnabled ? "Enabled" : "Off"}</div><div className="check-item">Phone: {f.numbers || "Not assigned yet"}</div><div className="check-item">Office: {f.officeNumber || "Not configured yet"}</div><div className="check-item">Timezone: {f.timezone}</div><p className="muted">Creating this workspace does not forward the client’s phone or connect paid providers automatically.</p></section>}
      <div className="row">
        {step > 0 ? <button type="button" className="secondary" disabled={pending} onClick={() => setStep(step - 1)}>Back</button> : null}
        <button type="submit" disabled={pending}>{pending ? "Creating…" : step === 3 ? "Create client workspace" : "Continue"}</button>
        {result ? <span className={result.ok ? "ok" : "error"}>{result.message}</span> : null}
      </div>
    </form>
  );
}
