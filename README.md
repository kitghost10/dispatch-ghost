# Dispatch Ghost AI Receptionist

A multi-tenant, white-label AI phone receptionist built for US plumbing contractors. Sonic Bold LLC (sonicbold.com) hosts it for many plumber clients.

It answers the phone and triages the problem with **deterministic safety rules in code**. Emergencies go to the on-call plumber, routine jobs get booked into arrival windows, missed callers get a text back, and inbound texts get AI replies. Everything is visible per client in a dashboard.

- **Based on [LobbyStack](https://github.com/lobbystack/lobbystack)** (MIT), pinned at `c6d0a6644f00a628ceb1339de518405d4967a46b`. See [docs/voice-path.md](docs/voice-path.md) for what we reused and why we didn't take its newest voice path.
- **Plumbing domain logic** was ported from [open-receptionist](https://github.com/andriidrok1/open-receptionist) and [HomeGuard Rapid Dispatch](https://github.com/PickleRith/homeguard-rapid-dispatch) (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What it does

| Area | Behaviour |
| --- | --- |
| Safety / triage | P0–P3 decided in code from facts (water flowing? near electrics? shut-off found? sewage in the home? infant?), never from the caller saying "emergency". **P0** (gas, smoke/fire, sparks, water near electrics, injury) gets the fixed evacuate / 911 / utility script, is never booked, alerts on-call, and creates a callback. Shut-off valve guidance. [docs/triage.md](docs/triage.md) |
| Pricing | Tenant trip/diagnostic fee (and after-hours fee) stated early. Repair prices are **never** quoted: an output guard checks every agent line. Optional "starting at" prices. |
| Service area | ZIP list and/or radius (with geocoding), enforced in code before slots are offered or booked. |
| Scheduling | Per-service job duration and arrival window, business hours, holidays, capacity (trucks), lead time. P1/P2 same-day first. Google Calendar free/busy + event creation. |
| After hours | On-call rota by day and date range. Emergencies are transferred live, with a whisper summary to the plumber. **If the transfer fails**, the caller hears an honest message, the whole rota gets an SMS alert, and an urgent callback task is created. If that callback is still open past its due time, it is escalated by SMS to the rota, fallback, and office. Routine jobs are booked for the next business day or get a callback. |
| SMS | Missed-call and abandoned-call text-back (12h dedupe, US only). AI replies to inbound texts. STOP/HELP/START consent ledger. [docs/a2p-10dlc.md](docs/a2p-10dlc.md) |
| Onboarding | Plumbing template (services, durations, windows, defaults) plus a form for fees, area, hours, on-call list, transfer numbers, brand, and numbers. |
| Recording | Per-tenant recording toggle and spoken consent preamble. [docs/recording-consent.md](docs/recording-consent.md) |
| Field service | `FieldServiceAdapter` interface. ServiceTitan and Housecall Pro adapters sit behind flags (dry-run by default); Jobber is stubbed. [docs/field-service.md](docs/field-service.md) |
| Dashboard | Calls, transcripts, triage level and reason codes, bookings, texts and missed-call texts, callbacks and on-call alerts, per-tenant settings with validation, onboarding, and a live simulator. |

## Architecture

```
            PSTN caller
                │
          ┌─────▼──────┐   voice webhook / status / <Dial action>   ┌──────────────────────────────┐
          │   Twilio   │ ─────────────────────────────────────────▶ │  apps/api  (Fastify)         │
          │  number    │ ◀══ Media Stream (wss, mu-law 8k) ═══════▶ │  ├ routes/twilioVoice.ts      │
          │  + SMS     │ ─── SMS webhook / status ────────────────▶ │  ├ routes/mediaStream.ts ─────┼──▶ VoiceProvider
          └────────────┘ ◀── REST: SMS, call update, recording ──── │  ├ routes/twilioSms.ts        │     ├ ElevenLabs Agents (live)
                                                                    │  ├ routes/admin.ts (JWT-ish)  │     ├ OpenAI Realtime (optional)
    ┌────────────────┐   server-side fetch (httpOnly cookie)        │  └ services/* ────────────────┼──▶ @sb/core ReceptionistSession
    │ apps/dashboard │ ───────────────────────────────────────────▶ │                               │     (triage, safety, pricing,
    │  Next.js 16    │                                              └──────┬───────────────┬────────┘      area, slots, SMS policy)
    └────────────────┘                                                     │               │
                                                           Postgres (RLS per tenant)   Redis / BullMQ ──▶ worker: SMS send+retry,
                                                           sb_app role, no BYPASSRLS                      missed-call text-back,
                                                                                                          Calendar / FSM sync
```

- **packages/core**: pure plumbing domain with no I/O: `tenant/` (zod config and onboarding template), `triage/` (safety flags, issue classifier, priority, scripts), `pricing.ts`, `serviceArea.ts`, `schedule/` (hours, on-call, slots), `sms/policy.ts`, `engine/`. The engine has `ReceptionistSession` (enforcement), `ScriptedReceptionist` (deterministic dialog), and `tools.ts` (LLM tools, locked once P0).
- **packages/db**: SQL migrations (roles, schema, RLS), a `Store` interface with Postgres and in-memory implementations, and the seed.
- **packages/providers**: Twilio REST + TwiML + signature validation, the voice providers, Google Calendar, field-service adapters, and geocoders.
- **apps/api**: webhooks, the media-stream gateway, the admin API, jobs, the worker, and the `simulate` CLI.
- **apps/dashboard**: the Next.js App Router dashboard.

**Tenant isolation.** The API connects as `sb_app`, a role with no BYPASSRLS; migrations check this. Each query runs in a transaction with `app.current_tenant_id` set. Number → tenant lookup and the callback sweep use narrow `SECURITY DEFINER` functions. Dashboard users see only tenants they are members of; agency admins see all of them.

**Voice path.** Twilio Media Streams + **ElevenLabs Agents** (Conversational AI). Audio still passes through our process so a P0 hazard can interrupt the model and play a fixed safety script in the same ElevenLabs voice. OpenAI Realtime remains an optional `VOICE_PROVIDER` fallback. Details: [docs/voice-path.md](docs/voice-path.md).

## Quick start: mock mode (no Twilio or ElevenLabs keys, no Docker)

Requirements: Node ≥ 22.12 and pnpm 10.

```bash
pnpm install
pnpm test                      # unit + scenario suites
pnpm dev:api                   # API on :4000 (in-memory store, demo tenant + sample calls)
API_URL=http://localhost:4000 pnpm dev:dashboard   # dashboard on :3000
```

Log in at http://localhost:3000 as `admin@sonicbold.test` / `sonicbold-demo` (agency admin) or `owner@lonestar.test` / `sonicbold-demo` (plumber owner).

In mock mode, startup runs a handful of demo calls through the real webhook and media-stream path: a booking, a gas leak, a price shopper, an infant with no hot water, an out-of-area caller, water near the panel, a failed after-hours transfer, and a missed call with an SMS reply. Other ways to try it:

- **Dashboard → "Test the receptionist"**: chat with the same engine. Alerts and texts are recorded as *simulated*.
- **Phone-call simulator in the terminal**: `pnpm simulate`, or `pnpm --filter @sb/api simulate --at 2026-09-30T04:30:00Z` to pretend it's 11:30 PM Central. It plays the part of Twilio, including transfer answered / no-answer.
- `POST /dev/missed-call`, `POST /dev/inbound-sms`, and `GET /dev/outbox` (mock mode only).

### Mock mode with Postgres + Redis (closer to production)

```bash
# once: create an owner role + DB (the owner role needs CREATEROLE to create sb_app)
createuser --createrole -P sb_owner && createdb -O sb_owner sonicbold
MIGRATION_DATABASE_URL=postgres://sb_owner:PW@localhost:5432/sonicbold SB_APP_DB_PASSWORD=apppw pnpm db:migrate
export DATABASE_URL=postgres://sb_app:apppw@localhost:5432/sonicbold REDIS_URL=redis://localhost:6379
pnpm dev:api & pnpm dev:worker & pnpm dev:dashboard
```

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm test:scenarios            # verbose scripted phone conversations
# Postgres RLS tests (skipped unless these are set):
TEST_MIGRATION_DATABASE_URL=postgres://sb_owner:PW@localhost:5432/sonicbold_test \
TEST_DATABASE_URL=postgres://sb_app:apppw@localhost:5432/sonicbold_test pnpm --filter @sb/db test
# Same env vars: run the whole API + scenario suite against Postgres under RLS (as sb_app)
pnpm --filter @sb/api test:pg
```

The **scenario suite** (`apps/api/test/scenarios.test.ts`) drives complete calls over HTTP and WebSocket exactly as Twilio would, with fixed clocks and no phone lines. Scenarios:

- burst pipe near the electrical panel
- gas smell
- no hot water with an infant
- clogged drain (caller says "emergency")
- price shopper
- out-of-area caller
- after-hours emergency with live transfer and whisper
- after-hours routine call booked for the next day
- transfer failure (rota walk, then SMS alerts and a callback)
- missed-call text-back, then an SMS conversation, HELP, and STOP
- 12h dedupe
- emergency by SMS
- abandoned-call text-back
- recording preamble
- bad signature or token
- voice provider outage falling back to a human

`apps/api/test/api.test.ts` covers auth, tenant isolation, onboarding, config validation, the simulator, Twilio signature validation, and an **LLM-driver guardrail test**: a deliberately "reckless" fake model tries to book and quote after a gas report, and the gateway interrupts it and the tools refuse.

## Going live with Twilio + ElevenLabs

1. Create a Conversational AI agent in the [ElevenLabs dashboard](https://elevenlabs.io/app/agents). Copy its agent id.
2. Set `APP_MODE=live`, `PUBLIC_BASE_URL=https://your-api-host`, `SESSION_SECRET`, `DATABASE_URL`, `REDIS_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_AGENT_ID` (see `.env.example`). Optional: `ELEVENLABS_VOICE_ID` (defaults to Rachel) and `OPENAI_API_KEY` for SMS AI replies. The API refuses to start in live mode if the required keys or https URL are missing.
3. On first live call the API PATCHes that agent: receptionist client tools, `ulaw_8000` in and out, and prompt/first-message overrides so each plumber's instructions can be injected per call.
4. For each plumber number in Twilio:
   - **A call comes in** → Webhook `POST https://your-api-host/twilio/voice/incoming`
   - **Call status changes** → `POST https://your-api-host/twilio/voice/status` (needed for missed-call text-back and call finalization)
   - **A message comes in** → `POST https://your-api-host/twilio/sms/incoming`
5. Register A2P 10DLC before enabling texting: [docs/a2p-10dlc.md](docs/a2p-10dlc.md).
6. Optionally configure Google Calendar and field-service software: [docs/field-service.md](docs/field-service.md).
7. Run `pnpm --filter @sb/api build`, then run `node apps/api/dist/index.js` and `node apps/api/dist/worker.js`.

Twilio signatures are validated on every webhook, using `PUBLIC_BASE_URL` plus the path. Media streams are authenticated with an HMAC token passed as a `<Parameter>`.

## Deploying

### docker-compose (single VM)

```bash
cp .env.example .env          # set APP_MODE, keys, PUBLIC_BASE_URL, strong passwords
docker compose up --build -d  # postgres, redis, migrate (one-shot), api, worker, dashboard
```

Put a TLS reverse proxy (Caddy, nginx, or a cloud load balancer) in front of `:4000` and `:3000`. The proxy must allow WebSocket upgrades on `/twilio/media-stream` and should have an idle timeout of at least 15 minutes. Images are defined in `docker/api.Dockerfile` (API, worker, and migrations share one image) and `docker/dashboard.Dockerfile` (Next.js standalone).

> Docker was not available on the build machine, so the compose file and Dockerfiles have **not** been run. We did replay the API image's steps outside Docker (filtered install, tsup bundle, migrate, boot on Postgres) and checked the Next.js standalone layout. Run `docker compose up --build` once as a smoke test.

### Hosted: Render (Blueprint)

`render.yaml` defines Postgres, Key Value (Redis, `noeviction`), the API web service (Docker, `/health`, migrations as `preDeployCommand`), the worker, and the dashboard. Render web services support the long-lived WebSockets that Media Streams need.

1. New Blueprint → select the repo. Fill in the `sync: false` secrets.
2. Render's Postgres user is the owner role. It must be able to `CREATE ROLE`; migration 0001 creates the `sb_app` role. Set `SB_APP_DB_PASSWORD`, then set `DATABASE_URL` to `postgres://sb_app:<that password>@<internal host>/sonicbold`, so the app runs under RLS rather than as the owner.
3. Set `PUBLIC_BASE_URL` to the API's https URL, `API_URL` on the dashboard, and `DASHBOARD_ORIGIN` on the API. Then point the Twilio webhooks at the API.

Any host that supports WebSockets and a long-running Node process works the same way (Fly.io, Railway, ECS). Serverless platforms without WebSockets do **not** work for the voice gateway.

## Adding a plumber tenant

**From the dashboard (agency admin):** All plumbers → **+ Onboard a plumber**. Fill in:

- company and spoken name
- receptionist name
- timezone
- trip fee and after-hours fee
- service ZIPs and area description
- hours
- office transfer number
- on-call rota (name and phone, in dial order) and fallback number
- gas utility line
- recording notice
- Twilio number(s)

The plumbing template fills in services (emergency repair, water heater, drain cleaning, general repair, install estimate) with durations and arrival windows. You land on **Settings**, where every other option can be edited (per-service durations and windows, "starting at" prices, holidays, capacity, booking mode, SMS templates, quiet hours, triage options, calendar, field-service provider). Changes are validated before saving.

**Via the API:** `POST /api/tenants` with `{ "answers": OnboardingAnswers, "phoneNumbers": ["+1…"] }`. `GET /api/onboarding/template` returns the service catalogue and a complete example.

Then:

1. Buy or port the number in Twilio and set its three webhooks.
2. Register the plumber's A2P brand and campaign.
3. Make a test call from the simulator.
4. Switch the tenant from `onboarding` to `active` (tenants in `onboarding` still answer calls; `paused` forwards to the office line).

## Cost drivers (per plumber)

Verify current prices with each vendor; these are rough orders of magnitude.

| Driver | Scales with | Notes |
| --- | --- | --- |
| ElevenLabs Agents audio | AI talk minutes | The largest variable cost (conversation + TTS). Use `eleven_flash_v2_5` (the default) to keep latency and price down. Short prompts and early hang-ups on P0/out-of-area calls help. |
| Twilio voice | Inbound minutes, plus transfer legs (billed as outbound minutes), plus Media Streams | A transferred emergency costs two legs for the whole conversation. |
| Recording and storage | Recorded minutes | Turn recording off per tenant if it isn't needed. |
| SMS | Segments | Missed-call texts, confirmations, AI replies, on-call alerts. Carrier fees apply per segment. Keep templates under 160 characters (GSM-7). |
| A2P 10DLC | Per brand and campaign | One-time brand/vetting fees plus a monthly campaign fee **per plumber**. |
| OpenAI text (SMS replies) | Inbound texts | Small; a mini model is used. |
| Infra | Fixed | One API instance handles many concurrent calls (WebSocket I/O-bound), plus Postgres, Redis, and the worker. |

## What's stubbed or not done yet

- **Jobber** adapter is a stub. **ServiceTitan / Housecall Pro** are implemented but dry-run by default and have not been tested against real accounts.
- **Live voice has not been exercised with real Twilio/ElevenLabs keys** (none available during the build). The ElevenLabs provider follows the Agents WebSocket event shapes (`ulaw_8000`, client tools, ping/pong). Plan a staged pilot on one number. OpenAI Realtime remains available as `VOICE_PROVIDER=openai-realtime`.
- **Radius service areas** need a geocoder. The US Census geocoder is used in live mode (addresses only, US-only, no key needed). ZIP lists work without one.
- **Overdue callbacks** are escalated once: a sweep runs every minute (the worker's BullMQ scheduler, or in-process without Redis) and texts the rota, fallback, and office. There is no multi-step escalation ladder (e.g. phone-call the owner) yet.
- **Horizontal scaling:** the media stream is handled by whichever instance accepts the WebSocket, and transfer results are stateless (rehydrated from `calls.state`), so multiple instances work behind a load balancer with WebSocket support. There is no cross-instance live-call registry for "barge in / whisper from dashboard" features.
- **Transcript retention** policy, dashboard user management UI (users are created via seed or SQL), and per-tenant Twilio subaccounts are not implemented.
- **LLM conversation quality** is only covered by the scripted engine and guardrail tests. Add an eval set of recorded calls before scaling.

## License

MIT © 2026 Sonic Bold LLC. Includes MIT-licensed material from LobbyStack, open-receptionist, HomeGuard Rapid Dispatch, servicetitan-mcp, and housecallpro-mcp: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [upstream/LOBBYSTACK-LICENSE](upstream/LOBBYSTACK-LICENSE).

## Guided agency setup and experimental providers

Client onboarding now has four steps: business, channels, phone/routing, and review.
Client setup has separate Voice calls and SMS replies sections, a configuration checklist,
phone-number assignment, model selection, and optional Advanced configuration. API keys
stay in the hosting environment; the dashboard only shows whether they are configured.
Readiness checks do not test provider credentials or make paid calls.

ElevenLabs remains primary for new clients. To test the additional voice stack, add
`DEEPGRAM_API_KEY` and `OPENROUTER_API_KEY` to the API and worker environment, then choose
**Deepgram + OpenRouter — testing** in that client's Voice calls section. Deepgram handles
streaming mu-law transcription and speech synthesis; OpenRouter supplies tool-enabled
text replies. Select the reply model, listening model, and speech model there. Blank model
fields use `OPENROUTER_MODEL`, `DEEPGRAM_TRANSCRIPTION_MODEL`, and `DEEPGRAM_SPEECH_MODEL`.
The model browser lists OpenRouter models that advertise text output and tool calling;
manual model IDs are supported if the catalog is unavailable. Availability and account
access must still be verified with a pilot. This pipeline buffers each synthesized reply,
so its latency should be measured before production use. No real provider calls have been
verified during this change.

SMS can independently use OpenAI or OpenRouter. Choose the provider and reply model in
SMS replies; `OPENROUTER_SMS_MODEL` can set an agency default. Existing OpenAI SMS defaults
are preserved when testing keys are added. SMS and voice may be enabled independently.
SMS off suppresses customer messages, while opt-out keyword processing and staff emergency
alerts still work. Voice off forwards callers to the office when configured.

This dashboard is configured as a personal workspace and opens directly without sign-in.
The dashboard server connects to the owner account internally. Optional hosting settings
`PERSONAL_ADMIN_EMAIL` and `PERSONAL_ADMIN_PASSWORD` select that account; the local demo
uses the seeded agency owner automatically. No login information is shown in the UI.

Provider references: https://developers.deepgram.com/reference/listen-live,
https://developers.deepgram.com/reference/text-to-speech-api, and
https://openrouter.ai/docs/api/reference/overview.

## Agency admin panel

Open `/admin` from the sidebar to manage shared Voice calls, SMS replies and templates,
quiet hours, recording, appointment rules, and emergency rules. Choose the groups to apply,
then click **Apply to all accounts**. This replaces the selected settings on all existing
accounts and saves defaults for future clients. Company identities, fees, service areas,
operating hours, transfer contacts, and client-specific gas utility lines are preserved.
Changes apply to new calls/messages; calls already in progress keep their configuration.
Individual clients can subsequently be customized in Client setup; applying that group
again from Admin overwrites those customizations.

Migration `0005_agency_settings.sql` adds the persistent global defaults. Run the normal
database migration before using the panel on a hosted deployment. PostgreSQL applies the
batch and defaults in one transaction. Local mock mode retains defaults only until restart,
like its other client data. No login screen is added to the personal dashboard.
