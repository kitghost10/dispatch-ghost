# Field-service software integrations

Bookings are always written to our database first, with a capacity check under an advisory lock. After that, a `booking.sync` job pushes them to:

1. **Google Calendar** (working). Set `calendar.provider = "google"` and `calendar.calendarId` in tenant settings, then share that calendar with the service account in `GOOGLE_SERVICE_ACCOUNT_JSON`. Availability also subtracts busy time from that calendar (FreeBusy), so jobs the office books by hand block slots.
2. **Field-service software** selected by `fieldService.provider`: `servicetitan`, `housecallpro`, `jobber`, or `none`.

Every adapter implements `FieldServiceAdapter.createJob()` (`packages/providers/src/fsm`) and sits behind two env flags:

| Provider | Flags | Tenant `fieldService.settings` | Status |
| --- | --- | --- | --- |
| ServiceTitan | `FSM_SERVICETITAN_ENABLED`, `FSM_SERVICETITAN_LIVE`; secrets `SERVICETITAN_CLIENT_ID/SECRET/APP_KEY` | `tenantId`, `bookingProviderId`, `environment` (`production`/`integration`) | Implemented against CRM v2 **booking-provider bookings** (the inbox a CSR converts to a job). Dry-run unless `*_LIVE=true`. Not yet exercised against a real ServiceTitan tenant. |
| Housecall Pro | `FSM_HOUSECALLPRO_ENABLED`, `FSM_HOUSECALLPRO_LIVE`; secret `HOUSECALLPRO_API_KEY` | — | Creates a customer, then a scheduled job. Dry-run unless live. Not exercised against a real account. |
| Jobber | `FSM_JOBBER_ENABLED` | — | Stub. Needs a Jobber OAuth app per account (GraphQL `clientCreate` + `requestCreate`). |

Dry-run mode logs the exact payload it would send and stores `dry-run:<bookingId>` as the reference. Use it to show a plumber what will land in their system before turning live mode on.

References (MIT, patterns only): `montrellcruse/servicetitan-mcp` for ServiceTitan auth and booking endpoints, and `NoBanks/housecallpro-mcp` for the Housecall Pro REST shapes.

Adding a provider: implement `FieldServiceAdapter`, register it in `apps/api/src/context.ts`, and add the key to the `fieldService.provider` enum in `packages/core/src/tenant/config.ts`.
