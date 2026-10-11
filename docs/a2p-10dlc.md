# A2P 10DLC setup (US texting) for white-labelled plumber numbers

US carriers block unregistered application-to-person SMS from 10-digit long codes. Every number that sends missed-call text-backs, booking confirmations, or AI replies has to belong to a registered campaign. Sonic Bold is an agency sending on behalf of many plumbing companies, so plan for **one Brand per plumbing company** (their EIN) and a campaign per brand.

## Steps (Twilio Console → Messaging → Regulatory Compliance)

1. **Customer profile (ISV / agency).** Create Sonic Bold's Primary Customer Profile (business info, authorized representative).
2. **Secondary customer profile per plumber.** Each plumbing client needs a secondary profile with its legal name, EIN, address, website, and a contact person. Collect these during onboarding.
3. **Brand registration per plumber.** Use Standard brand registration (low-volume standard works for most single-location shops). Sole proprietors without an EIN use the Sole Proprietor brand type, which has lower limits.
4. **Campaign per brand.** Use case "Customer Care" (or "Mixed" if you also send appointment reminders). Suggested description and samples:
   - *Description:* "Lone Star Rapid Plumbing texts customers who call its business line: missed-call follow-ups, appointment confirmations, and replies to customer texts about plumbing service requests."
   - *Sample 1:* "Hi, this is Lone Star Rapid Plumbing. Sorry we missed your call! Reply here with what's going on and your ZIP code and we'll get you scheduled. Reply STOP to opt out."
   - *Sample 2:* "Lone Star Rapid Plumbing: You're booked Wednesday between 8 and 10 AM at 123 Main St. Service call fee: $89. Reply STOP to opt out."
   - *Opt-in (message flow):* "Customers call the business phone number and are texted back only after that inbound call. Customers who book by phone are asked verbally whether they want a text confirmation. Customers can also text the number first."
   - Opt-out keywords: STOP, UNSUBSCRIBE, CANCEL, END, QUIT, STOPALL, REVOKE, OPTOUT. Help keywords: HELP, INFO. Make sure the help and opt-out replies in the tenant's `sms.helpText` match what you register.
5. **Messaging Service.** Attach each plumber's campaign to a Messaging Service that contains their number(s). The app always sends with `From` set to the tenant's own number. If `TWILIO_MESSAGING_SERVICE_SID` is set, it passes that SID too; the number must then be in that service's sender pool. With one service per plumber, leave the env var unset: Twilio still applies the campaign to the number.
6. **Advanced Opt-Out (optional).** If you enable it on the Messaging Service, set `TWILIO_ADVANCED_OPT_OUT=true`. The app then records STOP/START/HELP but doesn't send its own reply, so the customer never gets two.

## What the code enforces

- **Consent ledger** (`sms_consent` table): the states are `unknown`, `implied` (the customer called or texted first), `granted` (said yes to a confirmation text on the call, or texted START), and `opted_out`.
- **STOP always wins.** After STOP the only message ever sent is the STOP confirmation. Missed-call text-backs and AI replies are suppressed and logged as `skipped / opted_out`. Twilio error `21610` from a status callback also marks the number opted out.
- **Missed-call text-back limits:** one per caller per 12 hours, US numbers only, never for life-safety (P0) calls.
- **On-call alerts** go to the plumber's own staff. They are internal notifications, not consumer marketing, so they bypass the consumer consent check.
- **Quiet hours** (`sms.quietHours`) are available for proactive messages. Replies to an inbound text or call are sent immediately.

Timelines: brand vetting usually takes minutes to days, and campaign review 1–3 weeks. Until a campaign is approved, keep `sms.missedCallTextBack=false` for that tenant.
