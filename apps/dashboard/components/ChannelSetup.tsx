"use client";
import { useId, useState } from "react";
import { Icon } from "./Icon";
import { loadOpenRouterModelsAction } from "@/app/actions";
import type { ProviderSetup, Tenant } from "@/lib/types";
type Config = Tenant["config"];

function ModelPicker({ value, placeholder, onChange }: { value?: string; placeholder: string; onChange: (value: string | undefined) => void }) {
  const id = useId();
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  return <div>
    <label htmlFor={id}>Reply model</label>
    <div className="model-field"><input id={id} list={`${id}-models`} value={value ?? ""} placeholder={`Choose a model · default: ${placeholder}`} onChange={(e) => onChange(e.target.value.trim() || undefined)} />
      <button type="button" className="secondary" disabled={loading} onClick={async () => { setLoading(true); try { const result = await loadOpenRouterModelsAction(); setModels(result.models); setError(result.error); } finally { setLoading(false); } }}>{loading ? "Loading…" : "Browse models"}</button></div>
    <datalist id={`${id}-models`}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
    <p className="muted">Choose a model with tool calling, or enter its OpenRouter ID. Leave blank to use the agency default.</p>
    {error ? <p role="status" className="error">{error}</p> : null}
  </div>;
}
function Connection({ name, configured }: { name: string; configured: boolean }) {
  return <span className={`pill ${configured ? "ok" : "warn"}`}>{name}: {configured ? "Configured" : "Needs connection"}</span>;
}
export function ChannelSetup({ config, onChange, setup, section }: { config: Config; onChange: (config: Config) => void; setup: ProviderSetup; section?: "voice" | "sms" }) {
  const voice = config.voice ?? { enabled: true, provider: "agency" as const };
  const provider = voice.provider === "agency" ? setup.defaultVoice : voice.provider;
  const smsProvider = config.sms.provider === "agency" ? setup.defaultSms : config.sms.provider;
  const updateVoice = (patch: Partial<Config["voice"]>) => onChange({ ...config, voice: { ...voice, ...patch } });
  const updateSms = (patch: Partial<Config["sms"]>) => onChange({ ...config, sms: { ...config.sms, ...patch } });
  return <div className="grid">
    {setup.mode === "mock" ? <div className="notice">Preview mode · Conversations are simulated. Provider choices are saved for live setup.</div> : null}
    {(!section || section === "voice") && <section className="panel channel-panel">
      <span className="channel-heading-icon"><Icon name="phone"/></span><div className="section-heading"><div><h2>Voice calls</h2><p className="muted">Answer customers, book appointments, and transfer to the team.</p></div><label className="toggle switch-control"><input aria-label="Enable voice calls" type="checkbox" checked={voice.enabled} onChange={(e) => updateVoice({ enabled: e.target.checked })} /> {voice.enabled ? "Enabled" : "Off"}</label></div>
      <label htmlFor="voice-provider">Voice provider</label>
      <select id="voice-provider" value={voice.provider} onChange={(e) => updateVoice({ provider: e.target.value as Config["voice"]["provider"], model: undefined })}>
        <option value="elevenlabs">ElevenLabs — primary</option><option value="deepgram-openrouter">Deepgram + OpenRouter — testing</option><option value="agency">Use agency default</option><option value="openai-realtime">OpenAI Realtime</option>
      </select>
      {provider === "deepgram-openrouter" ? <>
        <div className="voice-flow"><span>Deepgram listens</span><span>→</span><span>OpenRouter replies</span><span>→</span><span>Deepgram speaks</span></div>
        <div className="row"><Connection name="Deepgram" configured={setup.connections.deepgram} /><Connection name="OpenRouter" configured={setup.connections.openrouter} /></div>
        <ModelPicker value={voice.model} placeholder={setup.defaults.openrouterModel} onChange={(model) => updateVoice({ model })} />
        <div className="fieldset">
          <label>Listening / transcription model<input list="transcription-models" value={voice.transcriptionModel ?? ""} placeholder={`Choose model · ${setup.defaults.transcriptionModel}`} onChange={(e) => updateVoice({ transcriptionModel: e.target.value.trim() || undefined })} /><datalist id="transcription-models"><option value="nova-3" /><option value="nova-2" /></datalist></label>
          <label>Speech model / voice<input list="speech-models" value={voice.speechModel ?? ""} placeholder={`Choose voice · ${setup.defaults.speechModel}`} onChange={(e) => updateVoice({ speechModel: e.target.value.trim() || undefined })} /><datalist id="speech-models"><option value="aura-2-thalia-en" /><option value="aura-2-asteria-en" /><option value="aura-2-orion-en" /></datalist></label>
        </div><p className="muted">Testing option. Verify real calls before assigning this to a client.</p>
      </> : provider === "openai-realtime" ? <><Connection name="OpenAI" configured={setup.connections.openai} /><label>Realtime model<input value={voice.model ?? ""} placeholder={`Choose model · ${setup.defaults.openaiModel}`} onChange={(e) => updateVoice({ model: e.target.value.trim() || undefined })} /></label></> : <><div className="row"><Connection name="ElevenLabs" configured={setup.connections.elevenlabs} /><Connection name="Phone service" configured={setup.connections.twilio} /></div><p className="muted">Choose your voice and model in ElevenLabs. Client business details are supplied automatically.</p><a href="https://elevenlabs.io/app/agents" target="_blank" rel="noreferrer">Open ElevenLabs agent settings ↗</a></>}
      {!voice.enabled ? <p className="muted">Incoming calls forward to the office number when available.</p> : null}
    </section>}
    {(!section || section === "sms") && <section className="panel channel-panel">
      <span className="channel-heading-icon sms-icon"><Icon name="message"/></span><div className="section-heading"><div><h2>SMS replies</h2><p className="muted">Reply to incoming texts and follow up on missed calls.</p></div><label className="toggle switch-control"><input aria-label="Enable SMS replies" type="checkbox" checked={config.sms.enabled} onChange={(e) => updateSms({ enabled: e.target.checked })} /> {config.sms.enabled ? "Enabled" : "Off"}</label></div>
      <label>Reply provider<select value={config.sms.provider ?? "agency"} onChange={(e) => updateSms({ provider: e.target.value as Config["sms"]["provider"], model: undefined })}><option value="agency">Use agency default</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter — testing</option></select></label>
      <div className="row"><Connection name={smsProvider === "openrouter" ? "OpenRouter" : "OpenAI"} configured={setup.connections[smsProvider]} /><Connection name="Phone service" configured={setup.connections.twilio} /></div>
      {smsProvider === "openrouter" ? <ModelPicker value={config.sms.model} placeholder={setup.defaults.openrouterModel} onChange={(model) => updateSms({ model })} /> : <label>Reply model<input value={config.sms.model ?? ""} placeholder={`Choose model · ${setup.defaults.smsModel}`} onChange={(e) => updateSms({ model: e.target.value.trim() || undefined })} /></label>}
      <label className="toggle"><input type="checkbox" checked={config.sms.aiReplies} onChange={(e) => updateSms({ aiReplies: e.target.checked })} /> Automatic AI replies</label>
      <label className="toggle"><input type="checkbox" checked={config.sms.missedCallTextBack} onChange={(e) => updateSms({ missedCallTextBack: e.target.checked })} /> Text customers after missed calls</label>
      <p className="muted">AI off: texts become follow-up tasks. SMS off: customer replies and follow-ups stop.</p>
    </section>}
  </div>;
}
