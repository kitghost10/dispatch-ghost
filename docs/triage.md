# Plumbing triage and safety rules (enforced in code)

All of this lives in `packages/core` and runs identically for the scripted agent, the LLM tools, SMS, and the dashboard simulator.

## Priorities

| Level | Meaning | Examples | What happens |
| --- | --- | --- | --- |
| **P0** | Life safety | gas / rotten-egg smell, CO alarm, smoke, fire, sparks, burning smell, water near the panel, outlets, or wiring, injury, someone trapped | Fixed safety script (evacuate; call 911 / the gas utility / the electric utility from outside). **Never booked**: all booking tools refuse. SMS alert to on-call, P0 callback task, then hang up. |
| **P1** | Active emergency | burst pipe, flooding, uncontrolled active leak, sewage backing up into the home, no water to the whole house, failed sump pump with water rising | Shut-off valve guidance. After hours: live transfer to the on-call rota. If no one answers, SMS alert plus a callback task due within `transfer.emergencyCallbackMinutes`. During hours: first slot today, or transfer if `triage.transferP1DuringHours`. |
| **P2** | Same day | water heater out, leak that is contained or already shut off, the only toilet clogged | Offer same-day slots first. A vulnerable occupant (infant, elderly, medical) is prioritized, and `triage.vulnerableOccupantUpgradesToP1` can promote it to P1. |
| **P3** | Routine | slow or clogged drain, dripping faucet, running toilet, installs and estimates | Next available window; weekends only if `booking.routineOnWeekends`. |

## Facts over words

- A caller saying "emergency" is recorded but **never** raises priority (`NOTE:CALLER_SAID_EMERGENCY_NOT_USED_FOR_PRIORITY`). The agent asks questions instead, and the **electrical question comes first** whenever water is involved:
  1. Is the water near outlets, the panel, cords, or light fixtures? (yes → P0)
  2. Is water still flowing right now?
  3. Do you know where the main shut-off is, and is it off?
  4. Is the sewage inside the living space?
  5. For water heaters: any gas smell?
  6. Is there an infant, elderly person, or medical need in the home?
- Negations are handled ("no gas smell", "nowhere near the panel").
- Safety flags only ever accumulate: once P0, the call stays P0.
- Reason codes are stored on every call and shown in the dashboard.

## Other rules

- The trip/diagnostic fee is stated early and unprompted. The after-hours fee is used outside business hours.
- **Repair prices are never quoted.** `findUnapprovedPrices()` checks every agent line; a blocked LLM SMS reply is replaced with the scripted one, and a violation during a voice call is logged and corrected immediately. "Starting at" prices are only spoken if the tenant enables them.
- The service area (ZIP list and/or radius with a geocoder) is checked **in code before any slot is offered or booked**. A ZIP that doesn't match the address blocks the booking.
- An adult (18+) must be on site to book, if enabled.
- The only DIY advice given is shut-off valve guidance.

Sources: HomeGuard Rapid Dispatch (P0–P3, safety flags, negation) and open-receptionist (`emergency_us.yaml` rules). Both are MIT; see THIRD_PARTY_NOTICES.md.
